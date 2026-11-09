import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { parse } from '../validate';

const MAX_FUTURE_MS = 60_000;
const MAX_AGE_MS = 5 * 60_000;
const MIN_GAP_SECONDS = 10;
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
    // Live pings only: recent, in order, at most one per 10 s per rider. A retry of the latest ping is a no-op.
    app.post(
      '/riders/me/location',
      { preHandler: requireRole(deps.jwtSecret, 'rider'), bodyLimit: PING_BODY_LIMIT_BYTES },
      async (req, reply) => {
        const b = parse(pingBody, req.body);
        const riderId = userOf(req).id;
        const now = Date.now();
        const at = b.at ? Date.parse(b.at) : now;
        if (at > now + MAX_FUTURE_MS || at < now - MAX_AGE_MS) {
          throw new HttpError(400, 'validation', 'at: timestamp must be within the last 5 minutes and not more than 1 minute ahead');
        }
        await withTx(deps.pool, async (tx) => {
          // Serialise one rider's pings so the rate limit and ordering checks cannot race.
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ping:${riderId}`]);
          const latest = (
            await tx.query(
              `SELECT at, (now() - received_at) < make_interval(secs => $2) AS recent
               FROM gps_pings WHERE rider_id = $1 ORDER BY at DESC LIMIT 1`,
              [riderId, MIN_GAP_SECONDS],
            )
          ).rows[0];
          if (latest) {
            const latestMs = (latest.at as Date).getTime();
            if (at === latestMs) return;
            if (at < latestMs) throw new HttpError(400, 'validation', 'at: earlier than your latest stored ping');
            if (latest.recent) throw new HttpError(429, 'too_many_requests', 'Send at most one location ping every 10 seconds');
          }
          await tx.query(
            'INSERT INTO gps_pings (rider_id, lat, lng, at) VALUES ($1, $2, $3, $4) ON CONFLICT (rider_id, at) DO NOTHING',
            [riderId, b.lat, b.lng, new Date(at)],
          );
        });
        return reply.status(204).send();
      },
    );
  };
