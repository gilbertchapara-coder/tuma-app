import {
  appendEvent,
  IllegalTransitionError,
  liableParty,
  payoutLoss,
  type CustodyEvent,
  type Party,
} from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf, type Role } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { runFlagJob } from '../jobs/flagJob';
import { insertEntries, insertEvent, loadEvents, lockRider } from '../repo';
import { parse, uuidParam } from '../validate';

const MAX_LOCK_RETRIES = 3;
/** Before the rider has the parcel: shop may still end it by itself. */
const BEFORE_PICKUP = ['booked', 'sealed', 'refused_by_rider'];
const ACTOR_OF: Record<Role, CustodyEvent['actor']> = { shop: 'shop', rider: 'rider', admin: 'tuma' };

const claimsQuery = z.object({ status: z.enum(['open', 'settled', 'dismissed', 'closed']).default('open') }).strict();

type Outcome =
  | { kind: 'retry' }
  | { kind: 'open' }
  | { kind: 'settled'; first: boolean; liable: Party; payoutCents: number };

interface ParcelPeek {
  shop_id: string;
  rider_id: string | null;
  value_cents: number;
  bundle_id: string | null;
}

/** Files or settles a loss. Lock order: bundle, rider, parcel (delivery_codes is never touched). */
async function reportLost(tx: pg.PoolClient, id: string, user: { id: string; role: Role }): Promise<Outcome> {
  const peek = (
    await tx.query<ParcelPeek>(
      `SELECT p.shop_id, p.rider_id, p.value_cents, bp.bundle_id
       FROM parcels p LEFT JOIN bundle_parcels bp ON bp.parcel_id = p.id WHERE p.id = $1`,
      [id],
    )
  ).rows[0];
  if (!peek || (user.role === 'shop' && peek.shop_id !== user.id)) throw new HttpError(404, 'not_found', 'Parcel not found');
  if (user.role === 'rider' && peek.rider_id !== user.id) throw new HttpError(403, 'forbidden', 'You have not accepted this parcel');

  if (peek.bundle_id) await tx.query('SELECT 1 FROM bundles WHERE id = $1 FOR UPDATE', [peek.bundle_id]);
  const locked = peek.rider_id ? await lockRider(tx, peek.rider_id) : undefined;
  const p = (await tx.query('SELECT rider_id FROM parcels WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (p.rider_id !== peek.rider_id) return { kind: 'retry' };

  const events = await loadEvents(tx, id);
  const last = events[events.length - 1]?.type;
  const existing = (await tx.query('SELECT status, liable, payout_cents FROM claims WHERE parcel_id = $1', [id])).rows[0];
  if (user.role === 'shop' && (existing?.status === 'dismissed' || existing?.status === 'closed')) {
    throw new HttpError(409, 'claim_closed', 'This claim was already reviewed');
  }

  if (last === 'reported_lost') {
    // Already ended: return the first result. A shop only ever sees its own parcel here (404 above otherwise).
    if (existing?.status === 'settled') {
      return { kind: 'settled', first: false, liable: existing.liable, payoutCents: existing.payout_cents };
    }
    throw new HttpError(409, 'illegal_transition', 'This parcel was already reported lost');
  }

  const at = new Date().toISOString();
  const next: CustodyEvent = { type: 'reported_lost', at, actor: ACTOR_OF[user.role] };
  try {
    appendEvent(events, next);
  } catch (err) {
    if (err instanceof IllegalTransitionError) throw new HttpError(409, 'illegal_transition', err.message);
    throw err;
  }

  if (user.role === 'shop' && last && !BEFORE_PICKUP.includes(last)) {
    // A shop claim against a rider is only a request for review: no custody event, no money.
    await tx.query(
      `INSERT INTO claims (parcel_id, status, filed_by) VALUES ($1, 'open', 'shop') ON CONFLICT (parcel_id) DO NOTHING`,
      [id],
    );
    return { kind: 'open' };
  }

  const liable = liableParty(events);
  let payoutCents = 0;
  if (liable === 'rider' && locked && peek.rider_id) {
    const res = payoutLoss(locked.entries, id, peek.value_cents, at);
    await insertEntries(tx, peek.rider_id, res.entries.slice(locked.entries.length));
    payoutCents = res.paidCents;
    if (res.shortfallCents > 0) await tx.query(`UPDATE riders SET status = 'removed' WHERE user_id = $1`, [peek.rider_id]);
  }
  await insertEvent(tx, id, next);
  await tx.query(
    `INSERT INTO claims (parcel_id, status, filed_by, liable, payout_cents, settled_at) VALUES ($1, 'settled', $2, $3, $4, now())
     ON CONFLICT (parcel_id) DO UPDATE SET status = 'settled', liable = EXCLUDED.liable, payout_cents = EXCLUDED.payout_cents, settled_at = now()`,
    [id, user.role, liable, payoutCents],
  );
  return { kind: 'settled', first: true, liable, payoutCents };
}

export const claimRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const admin = requireRole(deps.jwtSecret, 'admin');

    app.post('/parcels/:id/report-lost', { preHandler: requireRole(deps.jwtSecret, 'shop', 'rider', 'admin') }, async (req, reply) => {
      const { id } = parse(uuidParam, req.params);
      const user = userOf(req);
      for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt += 1) {
        const out = await withTx(deps.pool, (tx) => reportLost(tx, id, user));
        if (out.kind === 'retry') continue;
        if (out.kind === 'open') return reply.status(202).send({ status: 'open' });
        return reply.status(out.first ? 201 : 200).send({ liable: out.liable, payoutCents: out.payoutCents });
      }
      throw new HttpError(409, 'busy', 'The parcel changed while recording this, try again');
    });

    // No phones or contents: only what an admin needs to open the parcel.
    app.get('/claims', { preHandler: admin }, async (req) => {
      const { status } = parse(claimsQuery, req.query);
      const { rows } = await deps.pool.query(
        `SELECT c.id, c.parcel_id, c.status, c.filed_by, c.liable, c.payout_cents, c.created_at, p.suburb, p.value_cents
         FROM claims c JOIN parcels p ON p.id = c.parcel_id WHERE c.status = $1 ORDER BY c.created_at LIMIT 200`,
        [status],
      );
      return {
        claims: rows.map((r) => ({
          id: r.id,
          parcelId: r.parcel_id,
          status: r.status,
          filedBy: r.filed_by,
          liable: r.liable,
          payoutCents: r.payout_cents,
          suburb: r.suburb,
          valueCents: r.value_cents,
          createdAt: r.created_at.toISOString(),
        })),
      };
    });

    // Rejects a claim after review: no payout, no custody event.
    app.post('/claims/:id/dismiss', { preHandler: admin }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      return withTx(deps.pool, async (tx) => {
        const claim = (await tx.query('SELECT parcel_id FROM claims WHERE id = $1', [id])).rows[0];
        if (!claim) throw new HttpError(404, 'not_found', 'Claim not found');
        // Parcel lock first, like every other custody change, so it cannot interleave with a settle.
        await tx.query('SELECT 1 FROM parcels WHERE id = $1 FOR UPDATE', [claim.parcel_id]);
        const res = await tx.query(
          `UPDATE claims SET status = 'dismissed', settled_at = now() WHERE id = $1 AND status = 'open'`,
          [id],
        );
        if (res.rowCount === 0) throw new HttpError(409, 'not_open', 'Only an open claim can be dismissed');
        return { status: 'dismissed' };
      });
    });

    app.post('/admin/run-flag-job', { preHandler: admin }, async () => ({ raised: await runFlagJob(new Date(), deps.pool) }));

    app.get('/flags', { preHandler: admin }, async () => {
      const { rows } = await deps.pool.query(
        'SELECT id, parcel_id, rider_id, kind, episode_start, raised_at FROM flags ORDER BY id DESC LIMIT 200',
      );
      return {
        flags: rows.map((r) => ({
          id: Number(r.id),
          parcelId: r.parcel_id,
          riderId: r.rider_id,
          kind: r.kind,
          episodeStart: r.episode_start.toISOString(),
          raisedAt: r.raised_at.toISOString(),
        })),
      };
    });
  };
