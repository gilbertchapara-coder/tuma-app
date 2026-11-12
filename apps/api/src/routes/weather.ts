import { isCountryCode, isCountryConfigured, quoteWithWeather, WEATHER_MESSAGES, type CountryCode } from '@tuma/core';
import { countryConfig } from '../repo';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { HttpError } from '../errors';
import { parse } from '../validate';

const quoteQuery = z.object({ suburb: z.string().max(80), level: z.enum(['express', 'standard', 'overnight']), country: z.string().max(2).optional() }).strict();

export const weatherRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    // Public: carries no personal data.
    app.get('/weather', async () => {
      const weather = await deps.weather.current();
      return { weather, message: WEATHER_MESSAGES[weather] };
    });

    // Price before booking, with the weather extra as its own line. The total is locked at booking.
    app.get('/quote', async (req) => {
      const q = parse(quoteQuery, req.query);
      if (q.country !== undefined && !isCountryCode(q.country)) throw new HttpError(400, 'validation', 'country: not a country Tuma serves');
      const weather = await deps.weather.current();
      const code: CountryCode = q.country && isCountryCode(q.country) ? q.country : 'ZW';
      const cfg = await countryConfig(deps.pool, code);
      if (!isCountryConfigured(cfg)) throw new HttpError(409, 'country_not_open', 'Tuma is not open in that country yet');
      try {
        return { ...quoteWithWeather(q.suburb, q.level, weather, cfg), currency: cfg.currency, currencySymbol: cfg.currencySymbol, message: WEATHER_MESSAGES[weather] };
      } catch {
        throw new HttpError(400, 'validation', 'suburb: unknown suburb. Check the spelling against the delivery areas.');
      }
    });
  };
