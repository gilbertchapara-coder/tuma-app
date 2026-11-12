import { holdDeposit, InsufficientFloatError, topup } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { insertEntries, lockRider, riderSummary, userCountry } from '../repo';
import { isCountryCode, type CountryCode } from '@tuma/core';
import { centsSchema, parse, uuidParam } from '../validate';

const centsBody = z
  .object({ cents: centsSchema, country: z.string().refine((s): s is CountryCode => isCountryCode(s), { message: 'unknown country' }).optional() })
  .strict();
const profileBody = z
  .object({
    verified: z.boolean().optional(),
    hasGuarantor: z.boolean().optional(),
    cleanDeliveries: z.number().int().min(0).max(1_000_000).optional(),
    rating: z.number().min(0).max(5).optional(),
  })
  .strict();

export const riderRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const rider = requireRole(deps.jwtSecret, 'rider');
    const admin = requireRole(deps.jwtSecret, 'admin');

    app.get('/riders/me', { preHandler: rider }, async (req) => {
      const id = userOf(req).id;
      const country = await userCountry(deps.pool, id);
      return { ...(await riderSummary(deps.pool, id, country)), country };
    });

    // The rider's current run: accepted parcels that have not ended (delivered, cancelled, lost or refused).
    app.get('/riders/me/run', { preHandler: rider }, async (req) => {
      const { rows } = await deps.pool.query(
        `SELECT p.id, p.suburb, p.pickup_suburb, p.pickup_note, (c.parcel_id IS NOT NULL AND NOT c.used) AS needs_code
         FROM parcels p LEFT JOIN pickup_codes c ON c.parcel_id = p.id
         WHERE p.rider_id = $1
           AND COALESCE((SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1), '')
               NOT IN ('delivered', 'cancelled', 'reported_lost', 'refused_by_rider')
         ORDER BY p.created_at, p.id`,
        [userOf(req).id],
      );
      return {
        parcels: rows.map((r) => ({
          id: r.id as string,
          suburb: r.suburb as string,
          ...(r.pickup_suburb ? { pickupFrom: r.pickup_suburb as string, pickupNote: (r.pickup_note as string | null) ?? null, needsPickupCode: r.needs_code === true } : {}),
        })),
      };
    });

    // Float top-ups and deposits are admin-recorded until a payment provider is wired in.
    app.post('/riders/:id/topup', { preHandler: admin }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { cents, country: asked } = parse(centsBody, req.body);
      return withTx(deps.pool, async (tx) => {
        const country = (asked as CountryCode | undefined) ?? (await userCountry(tx, id));
        const { entries } = await lockRider(tx, id, country);
        const next = topup(entries, cents, new Date().toISOString());
        await insertEntries(tx, id, next.slice(entries.length), country);
        return { ok: true };
      });
    });

    app.post('/riders/:id/deposit', { preHandler: admin }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { cents, country: asked } = parse(centsBody, req.body);
      return withTx(deps.pool, async (tx) => {
        const country = (asked as CountryCode | undefined) ?? (await userCountry(tx, id));
        const { entries } = await lockRider(tx, id, country);
        try {
          const next = holdDeposit(entries, cents, new Date().toISOString());
          await insertEntries(tx, id, next.slice(entries.length), country);
        } catch (err) {
          if (err instanceof InsufficientFloatError) {
            throw new HttpError(402, 'insufficient_float', 'The rider float cannot cover this deposit');
          }
          throw err;
        }
        return { ok: true };
      });
    });

    app.patch('/riders/:id/profile', { preHandler: admin }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const b = parse(profileBody, req.body);
      const { rowCount } = await deps.pool.query(
        `UPDATE riders SET verified = COALESCE($2, verified), has_guarantor = COALESCE($3, has_guarantor),
           clean_deliveries = COALESCE($4, clean_deliveries), rating = COALESCE($5, rating)
         WHERE user_id = $1`,
        [id, b.verified ?? null, b.hasGuarantor ?? null, b.cleanDeliveries ?? null, b.rating ?? null],
      );
      if (rowCount === 0) throw new HttpError(404, 'not_found', 'Rider not found');
      return { ok: true };
    });
  };
