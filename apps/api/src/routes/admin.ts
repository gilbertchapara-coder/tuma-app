import { COUNTRY_CODES, isCountryCode, isCountryConfigured, parcelReference, referencePrefix, withOverrides, type CountryCode } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole } from '../auth';
import { HttpError } from '../errors';
import { countryConfig } from '../repo';
import { parse } from '../validate';
import { publicCountry } from './me';

const lookupQuery = z.object({ ref: z.string().min(1).max(40) }).strict();
const codeParam = z.object({ code: z.string().refine((s): s is CountryCode => isCountryCode(s), { message: `must be one of ${COUNTRY_CODES.join(', ')}` }) }).strict();

const RUNS = ['north', 'southwest', 'south'] as const;
const suburbEntry = z.object({ band: z.string().min(1).max(40), run: z.enum(RUNS) }).strict();
// Prices are in minor units; the ceiling stops a typo from overflowing the column or becoming a huge fee.
const MAX_PRICE_CENTS = 1_000_000;
const price = z.number().int().positive().max(MAX_PRICE_CENTS);
const priceRow = z.tuple([price, price, price]);
/** Above this share Tuma must be told the value is meant (guards against 1000 typed as 10000). */
export const PLATFORM_BPS_SOFT_CAP = 3000;

const settingsBody = z
  .object({
    suburbs: z.record(z.string().min(1).max(80), suburbEntry).optional(),
    prices: z.record(z.string().min(1).max(40), priceRow).optional(),
    // Tuma's share of each run price in basis points (1000 = 10%). Null clears it.
    platformBps: z.number().int().min(0).max(10_000).nullable().optional(),
    /** Required true to set a percentage above 30%. */
    confirmHighPercentage: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.platformBps == null || b.platformBps <= PLATFORM_BPS_SOFT_CAP || b.confirmHighPercentage === true, {
    message: 'Tuma percentage above 30% needs confirmHighPercentage: true',
    path: ['platformBps'],
  });

interface LockRow {
  id: string;
  suburb: string;
  country: string;
  shop_phone: string;
  rider_first_name: string | null;
  last_event: string | null;
  pickup_locked: boolean | null;
  pickup_used: boolean | null;
  delivery_locked: boolean | null;
  delivery_used: boolean | null;
}

const LOOKUP_SQL = `
  SELECT p.id, p.suburb, p.country, s.phone AS shop_phone, r.first_name AS rider_first_name,
         (SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1) AS last_event,
         pc.locked AS pickup_locked, pc.used AS pickup_used,
         dc.locked AS delivery_locked, dc.used AS delivery_used
  FROM parcels p
  JOIN users s ON s.id = p.shop_id
  LEFT JOIN users r ON r.id = p.rider_id
  LEFT JOIN pickup_codes pc ON pc.parcel_id = p.id
  LEFT JOIN delivery_codes dc ON dc.parcel_id = p.id`;

const maskPhone = (phone: string): string => `***${phone.slice(-3)}`;

const present = (r: LockRow): Record<string, unknown> => ({
  id: r.id,
  reference: parcelReference(r.id),
  suburb: r.suburb,
  country: r.country,
  // Support sees the shop to know who to call back; the number itself stays masked on screen.
  shopPhone: maskPhone(r.shop_phone),
  riderFirstName: r.rider_first_name,
  status: r.last_event,
  codes: {
    pickup: r.pickup_locked === null ? null : { locked: r.pickup_locked === true, used: r.pickup_used === true },
    delivery: r.delivery_locked === null ? null : { locked: r.delivery_locked === true, used: r.delivery_used === true },
  },
});

export const adminRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const admin = requireRole(deps.jwtSecret, 'admin');

    // Support finds a parcel by the reference the shop quotes (TUM-XXXXXXXX), then unlocks a code by id.
    app.get('/admin/parcels/lookup', { preHandler: admin }, async (req) => {
      const { ref } = parse(lookupQuery, req.query);
      const prefix = referencePrefix(ref);
      if (!prefix) throw new HttpError(400, 'validation', 'ref: type at least 6 characters of the reference, such as TUM-3F2A9C10');
      const { rows } = await deps.pool.query<LockRow>(`${LOOKUP_SQL} WHERE replace(p.id::text, '-', '') LIKE $1 || '%' ORDER BY p.created_at DESC LIMIT 5`, [prefix]);
      if (rows.length === 0) throw new HttpError(404, 'not_found', 'No parcel with that reference');
      return { parcels: rows.map(present) };
    });

    // Every parcel with a locked code, newest first, so support can work through them.
    app.get('/admin/codes/locked', { preHandler: admin }, async () => {
      const { rows } = await deps.pool.query<LockRow>(
        `${LOOKUP_SQL} WHERE (pc.locked AND NOT pc.used) OR (dc.locked AND NOT dc.used) ORDER BY p.created_at DESC LIMIT 100`,
      );
      return { parcels: rows.map(present) };
    });

    app.get('/admin/countries', { preHandler: admin }, async () => ({
      countries: await Promise.all(COUNTRY_CODES.map(async (c) => publicCountry(await countryConfig(deps.pool, c)))),
    }));

    // The owner opens a country or changes its prices and Tuma's percentage here, with no new app release.
    app.put('/admin/countries/:code', { preHandler: admin }, async (req) => {
      const { code } = parse(codeParam, req.params) as { code: CountryCode };
      const b = parse(settingsBody, req.body);
      const prices = b.prices;
      const suburbs = b.suburbs;
      // Check the result of the change, not just the part sent: a country that is open must stay able to price every suburb.
      const current = await countryConfig(deps.pool, code);
      const merged = withOverrides(current, { suburbs, prices });
      const wasOpen = isCountryConfigured(current);
      const missing = [...new Set(Object.values(merged.suburbs).map((s) => s.band))].filter((band) => merged.prices[band] === undefined);
      if (missing.length > 0 && (suburbs || wasOpen)) {
        throw new HttpError(400, 'validation', `prices: no price row for band ${missing.join(', ')}`);
      }
      await deps.pool.query(
        `INSERT INTO country_settings (country, suburbs, prices, platform_bps)
         VALUES ($1, $2::jsonb, $3::jsonb, $4)
         ON CONFLICT (country) DO UPDATE SET
           suburbs = COALESCE($2::jsonb, country_settings.suburbs),
           prices = COALESCE($3::jsonb, country_settings.prices),
           platform_bps = CASE WHEN $5 THEN $4 ELSE country_settings.platform_bps END,
           updated_at = now()`,
        [code, suburbs ? JSON.stringify(suburbs) : null, prices ? JSON.stringify(prices) : null, b.platformBps ?? null, b.platformBps !== undefined],
      );
      return { country: publicCountry(await countryConfig(deps.pool, code)) };
    });
  };
