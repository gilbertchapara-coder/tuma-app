import { randomBytes } from 'node:crypto';
import {
  appendEvent,
  findSuburbEntry,
  IllegalTransitionError,
  issueCode,
  priceCents,
  refundFee,
  riderTier,
  depositCents,
  type CustodyEvent,
  type EventType,
} from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf, type Role } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { insertEntries, insertEvent, loadEntries, loadEvents, lockRider } from '../repo';
import { assertOwnPhoto } from './photos';
import { centsSchema, httpsUrl, parse, phoneSchema, uuidParam } from '../validate';

const TRACK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_VALUE_CENTS = 100_000_00;

const suburbSchema = z.string().max(80).transform((s, ctx) => {
  try {
    return findSuburbEntry(s).name;
  } catch {
    ctx.issues.push({ code: 'custom', message: 'Unknown suburb. Check the spelling against the delivery areas.', input: s });
    return z.NEVER;
  }
});

const bookingBody = z
  .object({
    suburb: suburbSchema,
    level: z.enum(['express', 'standard', 'overnight']),
    valueCents: centsSchema.max(MAX_VALUE_CENTS),
    contents: z.string().trim().min(1).max(200),
    recipientPhone: phoneSchema,
    recipientPhoneConfirm: phoneSchema,
    sealedPhotoUrl: httpsUrl.optional(),
  })
  .strict()
  .refine((b) => b.recipientPhone === b.recipientPhoneConfirm, {
    path: ['recipientPhoneConfirm'],
    message: 'does not match recipientPhone',
  });

const EVENT_TYPES = [
  'booked',
  'sealed',
  'pickup_confirmed',
  'in_transit',
  'delivered',
  'refused_by_rider',
  'reported_lost',
  'cancelled',
] as const satisfies readonly EventType[];

const eventBody = z.object({ type: z.enum(EVENT_TYPES), photoUrl: httpsUrl.optional() }).strict();

/** Which events each role may record through the API. Delivery is only possible with the code. */
const ROLE_EVENTS: Record<Role, readonly EventType[]> = {
  // reported_lost is deliberately absent: it must go through POST /parcels/:id/report-lost, which settles the loss.
  shop: ['sealed', 'cancelled'],
  rider: ['pickup_confirmed', 'in_transit', 'refused_by_rider', 'cancelled'],
  admin: ['cancelled'],
};
const ACTOR_OF: Record<Role, CustodyEvent['actor']> = { shop: 'shop', rider: 'rider', admin: 'tuma' };

const STAGE: Record<EventType, string> = {
  booked: 'booked',
  sealed: 'sealed',
  pickup_confirmed: 'picked_up',
  in_transit: 'in_transit',
  delivered: 'delivered',
  refused_by_rider: 'refused',
  reported_lost: 'problem',
  cancelled: 'cancelled',
};

function statusOf(last: EventType): string {
  if (last === 'delivered') return 'delivered';
  if (last === 'cancelled') return 'cancelled';
  if (last === 'reported_lost' || last === 'refused_by_rider') return 'problem';
  return 'in_progress';
}

const MAX_LOCK_RETRIES = 3;
/** States in which the parcel is not yet in the rider's hands, so shop or admin may still end it. */
const BEFORE_PICKUP: readonly EventType[] = ['booked', 'sealed', 'refused_by_rider'];

/**
 * Records one custody event. Lock order: rider (only when a refund may be needed), then the parcel row.
 * Returns false when the assigned rider changed under us and the caller should retry.
 */
async function recordEvent(
  tx: pg.PoolClient,
  id: string,
  body: { type: EventType; photoUrl?: string | undefined },
  user: { id: string; role: Role },
): Promise<boolean> {
  const peek = (await tx.query('SELECT shop_id, rider_id FROM parcels WHERE id = $1', [id])).rows[0];
  if (!peek || (user.role === 'shop' && peek.shop_id !== user.id)) throw new HttpError(404, 'not_found', 'Parcel not found');

  const refunding = body.type === 'cancelled' && user.role !== 'rider' && peek.rider_id !== null;
  const locked = refunding ? await lockRider(tx, peek.rider_id) : undefined;

  const p = (await tx.query('SELECT rider_id FROM parcels WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (p.rider_id !== peek.rider_id) return false;
  if (user.role === 'rider' && p.rider_id !== user.id) throw new HttpError(403, 'forbidden', 'You have not accepted this parcel');

  const events = await loadEvents(tx, id);
  const last = events[events.length - 1]?.type;
  const ends = body.type === 'cancelled' || body.type === 'reported_lost';
  if (ends && user.role !== 'rider' && last && !BEFORE_PICKUP.includes(last)) {
    throw new HttpError(409, 'illegal_transition', 'Only the assigned rider can end a parcel after pickup');
  }
  const at = new Date().toISOString();
  const next: CustodyEvent = {
    type: body.type,
    at,
    actor: ACTOR_OF[user.role],
    ...(body.photoUrl ? { photoUrl: body.photoUrl } : {}),
  };
  try {
    appendEvent(events, next);
  } catch (err) {
    if (err instanceof IllegalTransitionError) throw new HttpError(409, 'illegal_transition', err.message);
    throw err;
  }
  await insertEvent(tx, id, next);

  if (locked) {
    // Refunds the fee only if one was charged for this parcel, and only once (core refundFee is idempotent).
    const after = refundFee(locked.entries, id, at);
    await insertEntries(tx, peek.rider_id, after.slice(locked.entries.length));
  }
  return true;
}

export const parcelRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const shop = requireRole(deps.jwtSecret, 'shop');
    const trackingUrl = (token: string): string => `${deps.publicBaseUrl}/track/${token}`;

    app.post('/parcels', { preHandler: shop }, async (req, reply) => {
      const b = parse(bookingBody, req.body);
      const shopId = userOf(req).id;
      const sealedPhotoUrl = b.sealedPhotoUrl ? await assertOwnPhoto(deps.pool, deps.publicBaseUrl, b.sealedPhotoUrl, shopId, 'sealedPhotoUrl') : undefined;
      const price = priceCents(b.suburb, b.level);
      const token = randomBytes(32).toString('base64url');
      const { code, record } = issueCode();

      const parcelId = await withTx(deps.pool, async (tx) => {
        const ins = await tx.query(
          `INSERT INTO parcels (shop_id, suburb, level, value_cents, contents, recipient_phone, price_cents, track_token)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [shopId, b.suburb, b.level, b.valueCents, b.contents, b.recipientPhone, price, token],
        );
        const id = ins.rows[0].id as string;

        let events: CustodyEvent[] = appendEvent([], { type: 'booked', at: new Date().toISOString(), actor: 'shop' });
        if (sealedPhotoUrl) {
          events = appendEvent(events, { type: 'sealed', at: new Date().toISOString(), actor: 'shop', photoUrl: sealedPhotoUrl });
        }
        for (const e of events) await insertEvent(tx, id, e);

        await tx.query('INSERT INTO delivery_codes (parcel_id, hash, salt, failed_attempts, used, locked) VALUES ($1, $2, $3, 0, false, false)', [
          id,
          record.hash,
          record.salt,
        ]);

        if (b.level === 'express') {
          // Express never pools: a one-parcel job so riders accept it the same way as a bundle.
          const run = findSuburbEntry(b.suburb).suburb.run;
          const bundle = await tx.query(`INSERT INTO bundles (run, level, drop_order) VALUES ($1, 'express', $2::jsonb) RETURNING id`, [
            run,
            JSON.stringify([b.suburb]),
          ]);
          await tx.query('INSERT INTO bundle_parcels (bundle_id, parcel_id) VALUES ($1, $2)', [bundle.rows[0].id, id]);
        }

        try {
          await deps.notifier.sendDeliveryCode(b.recipientPhone, code);
        } catch {
          throw new HttpError(502, 'notify_failed', 'Could not send the delivery code to the recipient, nothing was booked');
        }
        return id;
      });

      return reply.status(201).send({ parcelId, priceCents: price, trackingUrl: trackingUrl(token) });
    });

    app.get('/parcels', { preHandler: shop }, async (req) => {
      const { rows } = await deps.pool.query(
        `SELECT p.id, p.suburb, p.level, p.value_cents, p.contents, p.price_cents, p.created_at,
                (SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1) AS last_event
         FROM parcels p WHERE p.shop_id = $1 ORDER BY p.created_at DESC LIMIT 200`,
        [userOf(req).id],
      );
      return {
        parcels: rows.map((r) => ({
          id: r.id,
          suburb: r.suburb,
          level: r.level,
          valueCents: r.value_cents,
          contents: r.contents,
          priceCents: r.price_cents,
          createdAt: r.created_at.toISOString(),
          stage: STAGE[r.last_event as EventType],
          status: statusOf(r.last_event),
        })),
      };
    });

    app.get('/parcels/:id', { preHandler: shop }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { rows } = await deps.pool.query(
        `SELECT id, suburb, level, value_cents, contents, recipient_phone, price_cents, track_token, created_at
         FROM parcels WHERE id = $1 AND shop_id = $2`,
        [id, userOf(req).id],
      );
      const p = rows[0];
      if (!p) throw new HttpError(404, 'not_found', 'Parcel not found');
      const events = await loadEvents(deps.pool, id);
      const last = events[events.length - 1]?.type ?? 'booked';
      return {
        id: p.id,
        suburb: p.suburb,
        level: p.level,
        valueCents: p.value_cents,
        contents: p.contents,
        recipientPhone: p.recipient_phone,
        priceCents: p.price_cents,
        trackingUrl: trackingUrl(p.track_token),
        createdAt: p.created_at.toISOString(),
        stage: STAGE[last],
        status: statusOf(last),
        events,
      };
    });

    app.post(
      '/parcels/:id/events',
      { preHandler: requireRole(deps.jwtSecret, 'shop', 'rider', 'admin') },
      async (req, reply) => {
        const { id } = parse(uuidParam, req.params);
        const body = parse(eventBody, req.body);
        const user = userOf(req);
        if (!ROLE_EVENTS[user.role].includes(body.type)) {
          throw new HttpError(403, 'forbidden', `A ${user.role} cannot record ${body.type}`);
        }
        if (body.photoUrl) body.photoUrl = await assertOwnPhoto(deps.pool, deps.publicBaseUrl, body.photoUrl, user.id, 'photoUrl');
        if (body.type === 'sealed' && !body.photoUrl) {
          throw new HttpError(400, 'validation', 'photoUrl: a sealed event needs a photo of the sealed parcel');
        }
        // The rider can change between our unlocked peek and the parcel lock (an accept landing in between);
        // if so, start over so the rider row is always locked before the parcel row.
        for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt += 1) {
          const done = await withTx(deps.pool, (tx) => recordEvent(tx, id, body, user));
          if (done) return reply.status(201).send({ ok: true });
        }
        throw new HttpError(409, 'busy', 'The parcel changed while recording this event, try again');
      },
    );
    // Public, read-only. The token is the only credential, so it exposes the bare minimum.
    app.get('/track/:token', async (req) => {
      const { token } = req.params as { token: string };
      if (!TRACK_TOKEN.test(token)) throw new HttpError(404, 'not_found', 'Tracking link not found');
      const { rows } = await deps.pool.query(
        `SELECT p.id, p.suburb, p.recipient_phone, p.rider_id, u.first_name FROM parcels p LEFT JOIN users u ON u.id = p.rider_id WHERE p.track_token = $1`,
        [token],
      );
      const p = rows[0];
      if (!p) throw new HttpError(404, 'not_found', 'Tracking link not found');
      const events = await loadEvents(deps.pool, p.id);
      const last = events[events.length - 1]?.type ?? 'booked';

      let rider: { firstName: string | null; tier: string } | null = null;
      if (p.rider_id) {
        const r = await deps.pool.query('SELECT verified, has_guarantor, clean_deliveries, rating FROM riders WHERE user_id = $1', [p.rider_id]);
        const row = r.rows[0];
        if (row) {
          const entries = await loadEntries(deps.pool, p.rider_id);
          const tier = riderTier({
            verified: row.verified,
            hasGuarantor: row.has_guarantor,
            depositCents: depositCents(entries),
            cleanDeliveries: row.clean_deliveries,
            rating: Number(row.rating),
          });
          rider = { firstName: p.first_name ?? null, tier };
        }
      }
      return {
        status: statusOf(last),
        stage: STAGE[last],
        suburb: p.suburb,
        run: findSuburbEntry(p.suburb).suburb.run,
        phoneLast3: String(p.recipient_phone).slice(-3),
        rider,
        events: events.map((e) => ({ stage: STAGE[e.type], at: e.at })),
      };
    });
  };
