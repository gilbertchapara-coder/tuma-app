import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';

export const MAX_PHOTO_BYTES = 400 * 1024;
const MAX_PHOTOS_PER_HOUR = 60;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The photo id inside one of our own photo URLs, or null for any other URL. */
export function photoIdOf(publicBaseUrl: string, url: string): string | null {
  const prefix = `${publicBaseUrl}/photos/`;
  if (!url.startsWith(prefix)) return null;
  const id = url.slice(prefix.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** Returns the canonical URL, or throws a 400 unless `url` is a photo that `actorId` uploaded here. Other people's photos and foreign links are refused. */
export async function assertOwnPhoto(db: pg.Pool | pg.PoolClient, publicBaseUrl: string, url: string, actorId: string, field: string): Promise<string> {
  const id = photoIdOf(publicBaseUrl, url);
  const found = id ? (await db.query('SELECT 1 FROM photos WHERE id = $1 AND owner_id = $2', [id, actorId])).rowCount : 0;
  if (!id || !found) throw new HttpError(400, 'validation', `${field}: use a photo taken in the app`);
  return `${publicBaseUrl}/photos/${id}`;
}

export const photoRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES }, (_req, body, done) => done(null, body));

    app.post(
      '/photos',
      // onRequest runs before the body is read, so anonymous callers cannot make us buffer 400 KB.
      { onRequest: requireRole(deps.jwtSecret, 'shop', 'rider'), bodyLimit: MAX_PHOTO_BYTES },
      async (req, reply) => {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'validation', 'Send the photo as the request body');
        const startsOk = JPEG_MAGIC.every((byte, i) => body[i] === byte);
        const endsOk = body.length > 4 && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9;
        if (!startsOk || !endsOk) throw new HttpError(400, 'validation', 'The photo must be a JPEG image');
        const owner = userOf(req).id;
        const id = await withTx(deps.pool, async (tx) => {
          // Try, never wait: parallel uploads from one user must not park pool connections.
          const got = await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [`photos:${owner}`]);
          if (!got.rows[0].ok) throw new HttpError(429, 'too_many_requests', 'Another photo is still uploading, try again');
          const recent = await tx.query("SELECT count(*)::int AS n FROM photos WHERE owner_id = $1 AND created_at > now() - interval '1 hour'", [owner]);
          if ((recent.rows[0].n as number) >= MAX_PHOTOS_PER_HOUR) {
            throw new HttpError(429, 'too_many_requests', 'Too many photos in the last hour, try again later');
          }
          const ins = await tx.query('INSERT INTO photos (owner_id, data) VALUES ($1, $2) RETURNING id', [owner, body]);
          return ins.rows[0].id as string;
        });
        return reply.status(201).send({ url: `${deps.publicBaseUrl}/photos/${id}` });
      },
    );

    // Private: the uploader, an admin, or the shop and rider on a parcel that carries the photo.
    app.get('/photos/:id', { onRequest: requireRole(deps.jwtSecret, 'shop', 'rider', 'admin') }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) throw new HttpError(404, 'not_found', 'Photo not found');
      const user = userOf(req);
      const { rows } = await deps.pool.query(
        `SELECT ph.data FROM photos ph
         WHERE ph.id = $1 AND ($3 = 'admin' OR ph.owner_id = $2 OR EXISTS (
           SELECT 1 FROM custody_events ce JOIN parcels p ON p.id = ce.parcel_id
           WHERE ce.photo_url = $4 AND (p.shop_id = $2 OR p.rider_id = $2)))`,
        [id.toLowerCase(), user.id, user.role, `${deps.publicBaseUrl}/photos/${id.toLowerCase()}`],
      );
      if (!rows[0]) throw new HttpError(404, 'not_found', 'Photo not found');
      return reply
        .header('content-type', 'image/jpeg')
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', 'inline')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=3600')
        .send(rows[0].data as Buffer);
    });
  };
