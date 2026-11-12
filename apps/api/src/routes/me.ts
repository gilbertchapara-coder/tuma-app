import { COUNTRY_CODES, countryFromCoords, isCountryConfigured, isCountryCode, percentFeeCents, type CountryCode, type CountryConfig } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { countryConfig, userCountry } from '../repo';
import { HttpError } from '../errors';
import { parse } from '../validate';

/** What the apps need to show prices, money and delivery areas for one country. */
export const publicCountry = (c: CountryConfig): Record<string, unknown> => ({
  code: c.code,
  name: c.name,
  dialCode: c.dialCode,
  currency: c.currency,
  currencySymbol: c.currencySymbol,
  open: isCountryConfigured(c),
  suburbs: Object.entries(c.suburbs).map(([name, s]) => ({ name, band: s.band, run: s.run })),
  prices: c.prices,
  // Null until the owner sets it. The apps show "to be confirmed" for null.
  platformBps: c.platformBps,
});

const switchBody = z
  .object({ country: z.string().refine((s): s is CountryCode => isCountryCode(s), { message: `must be one of ${COUNTRY_CODES.join(', ')}` }) })
  .strict();

const positionBody = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();

export const meRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const anyUser = requireRole(deps.jwtSecret, 'shop', 'rider');
    const rider = requireRole(deps.jwtSecret, 'rider');

    // Where the signed-in user is working, with that country's prices and money.
    app.get('/me', { preHandler: requireRole(deps.jwtSecret, 'shop', 'rider', 'admin') }, async (req) => {
      const u = userOf(req);
      const country = await userCountry(deps.pool, u.id);
      return { id: u.id, role: u.role, country: publicCountry(await countryConfig(deps.pool, country)) };
    });

    // A user who travels (a rider going from Zimbabwe to Zambia) switches country and starts working there at once.
    // Their account, level and loyalty stay. Float is kept per country: Zambia float is separate from Zimbabwe float.
    const switchTo = async (id: string, country: CountryCode): Promise<Record<string, unknown>> => {
      // A rider cannot move away while parcels are still on the road: they are backed by this country's deposit.
      // The check and the change happen together under a lock on the user, and a parcel with no events yet counts as busy.
      await withTx(deps.pool, async (tx) => {
        await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
        const busy = await tx.query(
          `SELECT 1 FROM parcels p
           WHERE p.rider_id = $1
             AND COALESCE((SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1), 'assigned')
                 NOT IN ('delivered', 'cancelled', 'reported_lost', 'refused_by_rider')
           LIMIT 1`,
          [id],
        );
        if (busy.rowCount) throw new HttpError(409, 'parcels_in_progress', 'Finish or hand back your parcels before changing country');
        await tx.query('UPDATE users SET country = $2 WHERE id = $1', [id, country]);
      });
      return publicCountry(await countryConfig(deps.pool, country));
    };

    app.post('/me/country', { preHandler: anyUser }, async (req) => {
      const { country } = parse(switchBody, req.body) as { country: CountryCode };
      return { country: await switchTo(userOf(req).id, country) };
    });

    // The rider's phone reports where it is. If that is clearly another country Tuma serves, the rider moves there
    // at once: currency, delivery areas and prices follow, and float stays separate per country.
    // Unclear positions (near a border, or outside both countries) change nothing.
    // Limited per IP (generous, because mobile networks share addresses); the app asks about once every five minutes.
    await app.register(rateLimit, { global: false });
    app.post('/me/country/detect', { preHandler: rider, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
      const pos = parse(positionBody, req.body);
      const found = countryFromCoords(pos);
      if (!found) return { changed: false, reason: 'unclear' };
      const id = userOf(req).id;
      if ((await userCountry(deps.pool, id)) === found) return { changed: false, reason: 'same_country' };
      return { changed: true, country: await switchTo(id, found) };
    });

    // Today's earnings for the rider, in the rider's current country, by that country's clock.
    app.get('/riders/me/earnings', { preHandler: rider }, async (req) => {
      const id = userOf(req).id;
      const country = await userCountry(deps.pool, id);
      const cfg = await countryConfig(deps.pool, country);
      const { rows } = await deps.pool.query(
        `SELECT p.price_cents, bp.bundle_id
         FROM parcels p
         JOIN custody_events e ON e.parcel_id = p.id AND e.type = 'delivered'
         LEFT JOIN bundle_parcels bp ON bp.parcel_id = p.id
         WHERE p.rider_id = $1 AND p.country = $2
           AND (e.at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date`,
        [id, country, cfg.timezone],
      );
      const earnedCents = rows.reduce((sum, r) => sum + (r.price_cents as number), 0);
      const runs = new Set(rows.map((r) => r.bundle_id ?? r.price_cents)).size;
      return {
        country,
        currency: cfg.currency,
        currencySymbol: cfg.currencySymbol,
        earnedCents,
        parcelsDelivered: rows.length,
        runs,
        // Tuma's share is taken from float as runs are accepted. Null means the owner has not set it.
        platformBps: cfg.platformBps,
        tumaShareCents: cfg.platformBps === null ? null : rows.reduce((sum, r) => sum + percentFeeCents(r.price_cents as number, cfg.platformBps), 0),
      };
    });

    // Public: the apps ask this before sign-in to show the country a typed number belongs to.
    app.get('/countries', async () => ({
      countries: await Promise.all(COUNTRY_CODES.map(async (c) => publicCountry(await countryConfig(deps.pool, c)))),
    }));
  };

