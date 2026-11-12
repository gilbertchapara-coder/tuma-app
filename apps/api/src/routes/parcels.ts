import { randomBytes } from 'node:crypto';
import {
  appendEvent,
  checkCode,
  distanceExtraCents,
  distanceKm,
  MAX_CODE_ATTEMPTS,
  type CodeRecord,
  findSuburbEntryFor,
  isCountryConfigured,
  type CountryCode,
  type CountryConfig,
  IllegalTransitionError,
  issueCode,
  MIN_ASK_CENTS,
  quoteWithWeather,
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
import { AUCTION_WINDOW_MINUTES } from '../dispatch';
import { countryConfig, insertEntries, insertEvent, loadEntries, loadEvents, lockRider, userCountry } from '../repo';
import { assertOwnPhoto } from './photos';
import { centsSchema, httpsUrl, parse, phoneSchema, uuidParam } from '../validate';

const TRACK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_VALUE_CENTS = 100_000_00;

const suburbSchema = z.string().trim().min(1).max(80);

/** Matches a typed suburb against the country's table, or refuses with the same message as before. */
const resolveSuburb = (cfg: CountryConfig, typed: string, field: string): string => {
  try {
    return findSuburbEntryFor(cfg, typed).name;
  } catch {
    throw new HttpError(400, 'validation', `${field}: Unknown suburb. Check the spelling against the delivery areas.`);
  }
};

const bookingBody = z
  .object({
    suburb: suburbSchema,
    level: z.enum(['express', 'standard', 'overnight']),
    valueCents: centsSchema.max(MAX_VALUE_CENTS),
    contents: z.string().trim().min(1).max(200),
    recipientPhone: phoneSchema,
    recipientPhoneConfirm: phoneSchema,
    sealedPhotoUrl: httpsUrl.optional(),
    dispatch: z.enum(['fixed', 'first', 'cheapest']).default('fixed'),
    maxPriceCents: centsSchema.optional(),
    // Collect from another place first. The suburb prices the trip; lat and lng are an optional pin for the rider.
    pickup: z
      .object({
        suburb: suburbSchema,
        note: z.string().trim().max(200).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      })
      .strict()
      .refine((p) => (p.lat === undefined) === (p.lng === undefined), { message: 'lat and lng go together' })
      .optional(),
    // Where the parcel goes, as a pin. With a pickup pin too, the straight-line distance adds a (placeholder) long-trip charge.
    dropoff: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .strict()
      .optional(),
    payMethod: z.enum(['cash', 'mobile_money']).default('cash'),
  })
  .strict()
  .refine((b) => b.recipientPhone === b.recipientPhoneConfirm, {
    path: ['recipientPhoneConfirm'],
    message: 'does not match recipientPhone',
  })
  .refine((b) => b.dispatch === 'fixed' || b.level === 'express', {
    path: ['dispatch'],
    message: 'only Express parcels can use First rider or Cheapest rider',
  })
  .refine((b) => (b.dispatch === 'cheapest') === (b.maxPriceCents !== undefined), {
    path: ['maxPriceCents'],
    message: 'is needed for Cheapest rider and not allowed otherwise',
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

const eventBody = z
  .object({ type: z.enum(EVENT_TYPES), photoUrl: httpsUrl.optional(), pickupCode: z.string().regex(/^[0-9]{6}$/, 'must be the 6 digit pickup code').optional() })
  .strict();

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
interface CodeRefusal {
  refused: 'wrong' | 'locked';
  attemptsLeft: number;
}
/** States in which the parcel is not yet in the rider's hands, so shop or admin may still end it. */
const BEFORE_PICKUP: readonly EventType[] = ['booked', 'sealed', 'refused_by_rider'];

/**
 * Records one custody event. Lock order: rider (only when a refund may be needed), then the parcel row.
 * Returns false when the assigned rider changed under us and the caller should retry.
 */
async function recordEvent(
  tx: pg.PoolClient,
  id: string,
  body: { type: EventType; photoUrl?: string | undefined; pickupCode?: string | undefined },
  user: { id: string; role: Role },
): Promise<boolean | CodeRefusal> {
  const peek = (await tx.query('SELECT shop_id, rider_id, country FROM parcels WHERE id = $1', [id])).rows[0];
  if (!peek || (user.role === 'shop' && peek.shop_id !== user.id)) throw new HttpError(404, 'not_found', 'Parcel not found');

  const refunding = body.type === 'cancelled' && user.role !== 'rider' && peek.rider_id !== null;
  const locked = refunding ? await lockRider(tx, peek.rider_id, peek.country as CountryCode) : undefined;

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
  // A pickup from a third-party address needs the sender's one-time code. Wrong tries are saved, then refused.
  if (body.type === 'pickup_confirmed') {
    const row = (await tx.query('SELECT hash, salt, failed_attempts, used, locked FROM pickup_codes WHERE parcel_id = $1 FOR UPDATE', [id])).rows[0];
    if (row) {
      const record: CodeRecord = { hash: row.hash, salt: row.salt, failedAttempts: row.failed_attempts, used: row.used, locked: row.locked };
      if (record.locked) return { refused: 'locked', attemptsLeft: 0 };
      if (!body.pickupCode) throw new HttpError(400, 'validation', 'pickupCode: ask the sender for the 6 digit pickup code');
      const result = checkCode(record, body.pickupCode);
      await tx.query('UPDATE pickup_codes SET failed_attempts = $2, used = $3, locked = $4 WHERE parcel_id = $1', [id, result.record.failedAttempts, result.record.used, result.record.locked]);
      if (!result.ok) return { refused: result.record.locked ? 'locked' : 'wrong', attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - result.record.failedAttempts) };
    }
  }
  await insertEvent(tx, id, next);

  if (locked) {
    // Refunds the fee only if one was charged for this parcel, and only once (core refundFee is idempotent).
    const after = refundFee(locked.entries, id, at);
    await insertEntries(tx, peek.rider_id, after.slice(locked.entries.length), peek.country as CountryCode);
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
      const country = await userCountry(deps.pool, shopId);
      const cfg = await countryConfig(deps.pool, country);
      if (!isCountryConfigured(cfg)) throw new HttpError(409, 'country_not_open', `Tuma is not taking bookings in ${cfg.name} yet`);
      const dropSuburb = resolveSuburb(cfg, b.suburb, 'suburb');
      const pickupSuburb = b.pickup ? resolveSuburb(cfg, b.pickup.suburb, 'pickup.suburb') : null;
      const weatherNow = await deps.weather.current();
      const dropQuote = quoteWithWeather(dropSuburb, b.level, weatherNow, cfg);
      // PLACEHOLDER pricing for pickup requests: the dearer of the pickup and delivery suburbs on the table.
      const pickupQuote = pickupSuburb ? quoteWithWeather(pickupSuburb, b.level, weatherNow, cfg) : dropQuote;
      const base = pickupQuote.totalCents > dropQuote.totalCents ? pickupQuote : dropQuote;
      const pin = b.pickup?.lat !== undefined && b.pickup.lng !== undefined ? { lat: b.pickup.lat, lng: b.pickup.lng } : null;
      const km = pin && b.dropoff ? distanceKm(pin, b.dropoff) : null;
      const distanceCents = km === null ? 0 : distanceExtraCents(km);
      const quote = { ...base, totalCents: base.totalCents + distanceCents };
      if (b.maxPriceCents !== undefined && (b.maxPriceCents < MIN_ASK_CENTS || b.maxPriceCents > quote.totalCents * 2)) {
        throw new HttpError(400, 'validation', `maxPriceCents: must be between ${MIN_ASK_CENTS} and ${quote.totalCents * 2}`);
      }
      // The rain extra is locked here. With Cheapest rider the price starts at the most the shop will pay.
      const price = b.maxPriceCents ?? quote.totalCents;
      const token = randomBytes(32).toString('base64url');
      const { code, record } = issueCode();
      const pickupIssue = b.pickup ? issueCode() : null;

      const parcelId = await withTx(deps.pool, async (tx) => {
        const ins = await tx.query(
          `INSERT INTO parcels (shop_id, suburb, level, value_cents, contents, recipient_phone, price_cents, track_token, weather_cents, dispatch_mode, max_price_cents, pickup_suburb, pickup_note, pickup_lat, pickup_lng, pay_method, drop_lat, drop_lng, distance_km, distance_cents, country)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING id`,
          [shopId, dropSuburb, b.level, b.valueCents, b.contents, b.recipientPhone, price, token, quote.surchargeCents, b.dispatch, b.maxPriceCents ?? null, pickupSuburb, b.pickup?.note ?? null, b.pickup?.lat ?? null, b.pickup?.lng ?? null, b.payMethod, b.dropoff?.lat ?? null, b.dropoff?.lng ?? null, km, distanceCents, country],
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

        if (pickupIssue) {
          await tx.query('INSERT INTO pickup_codes (parcel_id, hash, salt) VALUES ($1, $2, $3)', [id, pickupIssue.record.hash, pickupIssue.record.salt]);
        }

        if (b.level === 'express') {
          // Express never pools: a one-parcel job so riders accept it the same way as a bundle.
          const run = findSuburbEntryFor(cfg, pickupSuburb ?? dropSuburb).suburb.run;
          const bundle = await tx.query(
            `INSERT INTO bundles (run, level, drop_order, dispatch_mode, ceiling_cents, auction_ends_at, country)
             VALUES ($1, 'express', $2::jsonb, $3, $4, CASE WHEN $3 = 'cheapest' THEN now() + $5 * interval '1 minute' END, $6) RETURNING id`,
            [run, JSON.stringify([dropSuburb]), b.dispatch, b.dispatch === 'fixed' ? null : price, AUCTION_WINDOW_MINUTES, country],
          );
          await tx.query('INSERT INTO bundle_parcels (bundle_id, parcel_id) VALUES ($1, $2)', [bundle.rows[0].id, id]);
        }

        try {
          await deps.notifier.sendDeliveryCode(b.recipientPhone, code);
        } catch {
          throw new HttpError(502, 'notify_failed', 'Could not send the delivery code to the recipient, nothing was booked');
        }
        return id;
      });

      return reply.status(201).send({ parcelId, country, currency: cfg.currency, currencySymbol: cfg.currencySymbol, priceCents: price, weatherCents: quote.surchargeCents, dispatch: b.dispatch, payMethod: b.payMethod, ...(km !== null ? { distanceKm: km, distanceCents } : {}), trackingUrl: trackingUrl(token), ...(pickupIssue ? { pickupCode: pickupIssue.code } : {}) });
    });

    app.get('/parcels', { preHandler: shop }, async (req) => {
      const { rows } = await deps.pool.query(
        `SELECT p.id, p.suburb, p.level, p.value_cents, p.contents, p.price_cents, p.created_at,
                (SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1) AS last_event,
                EXISTS (SELECT 1 FROM pickup_codes c WHERE c.parcel_id = p.id AND NOT c.used) AS pickup_code_open
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
          ...(r.pickup_code_open && r.last_event !== 'pickup_confirmed' ? { pickupCodeOpen: true } : {}),
          createdAt: r.created_at.toISOString(),
          stage: STAGE[r.last_event as EventType],
          status: statusOf(r.last_event),
        })),
      };
    });

    // A lost pickup code: the owner may get a fresh one until the rider has collected. Locked codes need Tuma support.
    app.post('/parcels/:id/pickup-code/reissue', { preHandler: shop }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const owner = userOf(req).id;
      return withTx(deps.pool, async (tx) => {
        const p = (await tx.query('SELECT shop_id FROM parcels WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!p || p.shop_id !== owner) throw new HttpError(404, 'not_found', 'Parcel not found');
        const row = (await tx.query('SELECT used, locked FROM pickup_codes WHERE parcel_id = $1 FOR UPDATE', [id])).rows[0];
        if (!row) throw new HttpError(409, 'no_pickup_code', 'This parcel has no pickup code');
        const events = await loadEvents(tx, id);
        if (row.used || events.some((e) => e.type === 'pickup_confirmed')) throw new HttpError(409, 'already_collected', 'The rider has already collected this parcel');
        if (row.locked) throw new HttpError(423, 'code_locked', 'Too many wrong codes. Contact Tuma support to unlock it.');
        const fresh = issueCode();
        await tx.query('UPDATE pickup_codes SET hash = $2, salt = $3, failed_attempts = 0 WHERE parcel_id = $1', [id, fresh.record.hash, fresh.record.salt]);
        return { pickupCode: fresh.code };
      });
    });

    // Tuma support: clear a lock after checking who is at the door. Attempts reset; a used code stays used.
    app.post('/admin/parcels/:id/unlock', { preHandler: requireRole(deps.jwtSecret, 'admin') }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { which } = parse(z.object({ which: z.enum(['pickup', 'delivery']) }).strict(), req.body);
      const table = which === 'pickup' ? 'pickup_codes' : 'delivery_codes';
      const done = await deps.pool.query(`UPDATE ${table} SET failed_attempts = 0, locked = false WHERE parcel_id = $1 AND NOT used`, [id]);
      if (!done.rowCount) throw new HttpError(404, 'not_found', 'No unused code to unlock for that parcel');
      return { unlocked: true };
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
          if (typeof done === 'object') {
            if (done.refused === 'locked') throw new HttpError(423, 'code_locked', 'Too many wrong codes. This pickup is locked, contact Tuma support.');
            throw new HttpError(403, 'invalid_code', 'That pickup code is wrong', { attemptsLeft: done.attemptsLeft });
          }
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
        `SELECT p.id, p.suburb, p.country, p.recipient_phone, p.rider_id, u.first_name FROM parcels p LEFT JOIN users u ON u.id = p.rider_id WHERE p.track_token = $1`,
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
          const entries = await loadEntries(deps.pool, p.rider_id, p.country as CountryCode);
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
        run: findSuburbEntryFor(await countryConfig(deps.pool, p.country as CountryCode), p.suburb).suburb.run,
        phoneLast3: String(p.recipient_phone).slice(-3),
        rider,
        events: events.map((e) => ({ stage: STAGE[e.type], at: e.at })),
      };
    });
  };
