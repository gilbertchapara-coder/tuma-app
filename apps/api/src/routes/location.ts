import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { HttpError } from '../errors';
import { parse } from '../validate';

const MAX_FUTURE_MS = 60_000;
const MAX_AGE_MS = 24 * 3_600_000;
const PING_BODY_LIMIT_BYTES = 512;

const pingBody = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const locationRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    // Small, idempotent per (rider, timestamp): a retry of the same ping stores one row.
    app.post(
      '/riders/me/location',
      { preHandler: requireRole(deps.jwtSecret, 'rider'), bodyLimit: PING_BODY_LIMIT_BYTES },
      async (req, reply) => {
        const b = parse(pingBody, req.body);
        const now = Date.now();
        const at = b.at ? Date.parse(b.at) : now;
        if (at > now + MAX_FUTURE_MS || at < now - MAX_AGE_MS) {
          throw new HttpError(400, 'validation', 'at: timestamp must be within the last 24 hours and not in the future');
        }
        await deps.pool.query(
          'INSERT INTO gps_pings (rider_id, lat, lng, at) VALUES ($1, $2, $3, $4) ON CONFLICT (rider_id, at) DO NOTHING',
          [userOf(req).id, b.lat, b.lng, new Date(at)],
        );
        return reply.status(204).send();
      },
    );
  };
