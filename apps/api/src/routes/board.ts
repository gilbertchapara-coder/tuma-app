import { canCarry, MIN_ASK_CENTS, type DispatchMode } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { assertAsk, awardBundleTx, LAST_EVENT_SEALED } from '../dispatch';
import { HttpError } from '../errors';
import { lockRider, riderSummary, userCountry } from '../repo';
import { centsSchema, parse, uuidParam } from '../validate';

const RUNS = ['north', 'southwest', 'south'] as const;
const boardQuery = z.object({ run: z.enum(RUNS).optional() }).strict();
const offerBody = z.object({ askCents: centsSchema }).strict();
const RECENT_RESULT_HOURS = 24;

type BoardState = 'open' | 'in_cart' | 'won' | 'taken';

/** Awards every cheapest-rider auction whose offer window has closed. Safe to call often. */
export async function settleDueAuctions(pool: pg.Pool): Promise<void> {
  const due = await pool.query(
    `SELECT id FROM bundles WHERE status = 'open' AND dispatch_mode = 'cheapest' AND auction_ends_at <= now()
       AND EXISTS (SELECT 1 FROM bundle_offers o WHERE o.bundle_id = bundles.id)`,
  );
  for (const row of due.rows) await withTx(pool, (tx) => awardBundleTx(tx, row.id as string));
}

export const boardRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const rider = requireRole(deps.jwtSecret, 'rider');
    const shop = requireRole(deps.jwtSecret, 'shop');

    const ownsJob = async (jobId: string, shopId: string): Promise<void> => {
      const mine = await deps.pool.query(
        `SELECT 1 FROM bundle_parcels bp JOIN parcels p ON p.id = bp.parcel_id WHERE bp.bundle_id = $1 AND p.shop_id = $2`,
        [jobId, shopId],
      );
      if (!mine.rowCount) throw new HttpError(404, 'not_found', 'Job not found');
    };

    app.get('/board', { preHandler: rider }, async (req) => {
      const q = parse(boardQuery, req.query);
      const me = userOf(req).id;
      await settleDueAuctions(deps.pool);
      const country = await userCountry(deps.pool, me);
      const { rows } = await deps.pool.query(
        `SELECT b.id, b.run, b.level, b.drop_order, b.dispatch_mode, b.ceiling_cents, b.auction_ends_at, b.created_at, b.status, b.rider_id AS winner,
                (SELECT count(*)::int FROM bundle_offers o WHERE o.bundle_id = b.id) AS offer_count,
                (SELECT o.ask_cents FROM bundle_offers o WHERE o.bundle_id = b.id AND o.rider_id = $1) AS my_ask
         FROM bundles b
         WHERE b.dispatch_mode <> 'fixed' AND b.country = $4 AND ($2::text IS NULL OR b.run = $2)
           AND ( (b.status = 'open' AND EXISTS (SELECT 1 FROM bundle_parcels bp JOIN parcels p ON p.id = bp.parcel_id WHERE bp.bundle_id = b.id AND ${LAST_EVENT_SEALED}))
              OR (b.status = 'accepted' AND b.accepted_at > now() - $3 * interval '1 hour'
                  AND EXISTS (SELECT 1 FROM bundle_offers o WHERE o.bundle_id = b.id AND o.rider_id = $1)) )
         ORDER BY b.created_at DESC LIMIT 100`,
        [me, q.run ?? null, RECENT_RESULT_HOURS, country],
      );
      return {
        jobs: rows.map((r) => {
          const state: BoardState =
            r.status === 'accepted' ? (r.winner === me ? 'won' : 'taken') : r.my_ask !== null ? 'in_cart' : 'open';
          return {
            id: r.id,
            run: r.run,
            level: r.level,
            suburb: (r.drop_order as string[])[0] ?? null,
            mode: r.dispatch_mode as DispatchMode,
            ceilingCents: r.ceiling_cents,
            postedAt: (r.created_at as Date).toISOString(),
            auctionEndsAt: r.auction_ends_at ? (r.auction_ends_at as Date).toISOString() : null,
            offerCount: r.offer_count,
            myAskCents: r.my_ask,
            state,
          };
        }),
        note: 'A place in your cart is not a guarantee. The parcel goes to the winning offer.',
      };
    });

    app.post('/board/:id/offers', { preHandler: rider }, async (req, reply) => {
      const { id } = parse(uuidParam, req.params);
      const { askCents } = parse(offerBody, req.body);
      const me = userOf(req).id;
      const outcome = await withTx(deps.pool, async (tx) => {
        const b = (
          await tx.query('SELECT status, dispatch_mode, ceiling_cents, country, auction_ends_at <= now() AS closed FROM bundles WHERE id = $1 FOR UPDATE', [id])
        ).rows[0];
        if (!b) throw new HttpError(404, 'not_found', 'Job not found');
        if (b.status !== 'open') throw new HttpError(409, 'taken', 'Another rider already took this job');
        assertAsk(b.dispatch_mode, b.ceiling_cents, askCents);
        const sealed = await tx.query(
          `SELECT 1 FROM bundle_parcels bp JOIN parcels p ON p.id = bp.parcel_id WHERE bp.bundle_id = $1 AND ${LAST_EVENT_SEALED}`,
          [id],
        );
        if (!sealed.rowCount) throw new HttpError(409, 'unavailable', 'This job is not ready for a rider yet');
        // Check the rider up front so a cart place is never a promise they cannot keep (they can still lose to another offer).
        if ((await userCountry(tx, me)) !== b.country) throw new HttpError(409, 'wrong_country', 'This job is in another country. Switch country to take it.');
        const { stats, removed } = await lockRider(tx, me, b.country);
        if (removed) throw new HttpError(403, 'rider_removed', 'Your rider account is suspended, contact Tuma support');
        const worth = await tx.query(
          `SELECT max(p.value_cents)::int AS v FROM bundle_parcels bp JOIN parcels p ON p.id = bp.parcel_id WHERE bp.bundle_id = $1`,
          [id],
        );
        if (!canCarry(stats, worth.rows[0].v as number, false)) {
          throw new HttpError(403, 'over_cap', 'This parcel is worth more than your rider level allows');
        }
        await tx.query(
          `INSERT INTO bundle_offers (bundle_id, rider_id, ask_cents) VALUES ($1, $2, $3)
           ON CONFLICT (bundle_id, rider_id) DO UPDATE SET ask_cents = EXCLUDED.ask_cents`,
          [id, me, askCents],
        );
        // First come first served wins at once. A cheapest auction whose window already closed awards the first late offer.
        if (b.dispatch_mode === 'first' || b.closed) {
          const winner = await awardBundleTx(tx, id);
          if (winner === null) throw new HttpError(402, 'insufficient_float', 'Top up your float to take this job');
          return { state: (winner === me ? 'won' : 'taken') as BoardState };
        }
        return { state: 'in_cart' as BoardState };
      });
      return reply.status(201).send(outcome);
    });

    app.delete('/board/:id/offers', { preHandler: rider }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const done = await deps.pool.query(
        `DELETE FROM bundle_offers o USING bundles b WHERE o.bundle_id = b.id AND b.id = $1 AND b.status = 'open' AND o.rider_id = $2`,
        [id, userOf(req).id],
      );
      return { removed: done.rowCount ?? 0 };
    });

    // The shop sees who offered: level and ask only, never a phone number.
    app.get('/board/:id/offers', { preHandler: shop }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      await ownsJob(id, userOf(req).id);
      const { rows } = await deps.pool.query(
        `SELECT o.rider_id, o.ask_cents, o.created_at, u.first_name FROM bundle_offers o JOIN users u ON u.id = o.rider_id
         WHERE o.bundle_id = $1 ORDER BY o.ask_cents, o.created_at`,
        [id],
      );
      const offers = [];
      for (const r of rows) {
        const s = await riderSummary(deps.pool, r.rider_id, await userCountry(deps.pool, r.rider_id)).catch(() => null);
        offers.push({ firstName: r.first_name ?? null, tier: s?.tier ?? 'unverified', askCents: r.ask_cents, at: (r.created_at as Date).toISOString() });
      }
      return { offers };
    });

    // The shop's meter: raise or lower the most it will pay while the job is still open.
    app.post('/board/:id/ceiling', { preHandler: shop }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { maxPriceCents } = parse(z.object({ maxPriceCents: centsSchema }).strict(), req.body);
      await ownsJob(id, userOf(req).id);
      if (maxPriceCents < MIN_ASK_CENTS) throw new HttpError(400, 'too_low', 'That price is too low for a rider to take');
      return withTx(deps.pool, async (tx) => {
        const { rows } = await tx.query('SELECT status, dispatch_mode FROM bundles WHERE id = $1 FOR UPDATE', [id]);
        if (rows[0]?.status !== 'open' || rows[0].dispatch_mode !== 'cheapest') {
          throw new HttpError(409, 'closed', 'The price can only change while a Cheapest rider job is open');
        }
        const low = await tx.query('SELECT min(ask_cents) AS low FROM bundle_offers WHERE bundle_id = $1', [id]);
        if (low.rows[0]?.low !== null && maxPriceCents < Number(low.rows[0].low)) {
          throw new HttpError(409, 'below_offers', 'Riders have already offered more than that. Pick an offer or raise the price.');
        }
        await tx.query('UPDATE bundles SET ceiling_cents = $2 WHERE id = $1', [id, maxPriceCents]);
        return { ceilingCents: maxPriceCents };
      });
    });

    // The shop may close a cheapest-rider auction early.
    app.post('/board/:id/award', { preHandler: shop }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      await ownsJob(id, userOf(req).id);
      const winner = await withTx(deps.pool, (tx) => awardBundleTx(tx, id));
      if (winner === null) throw new HttpError(409, 'no_offer', 'No rider can take this job yet');
      return { awarded: true };
    });
  };
