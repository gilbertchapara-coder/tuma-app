import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { parse, uuidParam } from '../validate';

export const MAX_MESSAGE_CHARS = 500;
const MAX_MESSAGES_PER_MINUTE = 20;
const PAGE = 100;

/** Seven or more digits in a row, even with spaces or dashes, looks like a phone number. */
const PHONE_LIKE = /(?:\d[\s().-]*){7,}/;

const sendBody = z.object({ body: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) }).strict();
const listQuery = z.object({ after: z.coerce.number().int().min(0).default(0) }).strict();

export const messageRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const people = requireRole(deps.jwtSecret, 'shop', 'rider');

    /** The shop that booked the parcel or the rider assigned to it. Anyone else gets 404 so ids do not leak. */
    const assertMember = async (parcelId: string, user: { id: string; role: string }): Promise<void> => {
      const { rows } = await deps.pool.query('SELECT shop_id, rider_id FROM parcels WHERE id = $1', [parcelId]);
      const p = rows[0];
      const ok = p && ((user.role === 'shop' && p.shop_id === user.id) || (user.role === 'rider' && p.rider_id === user.id));
      if (!ok) throw new HttpError(404, 'not_found', 'Parcel not found');
    };

    app.get('/parcels/:id/messages', { preHandler: people }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { after } = parse(listQuery, req.query);
      const user = userOf(req);
      await assertMember(id, user);
      const { rows } = await deps.pool.query(
        `SELECT m.id, m.sender_id, m.body, m.created_at FROM messages m WHERE m.parcel_id = $1 AND m.id > $2 ORDER BY m.id LIMIT ${PAGE}`,
        [id, after],
      );
      const last = rows.length ? (rows[rows.length - 1].id as string) : null;
      if (last) {
        await deps.pool.query(
          `INSERT INTO message_reads (parcel_id, user_id, last_id) VALUES ($1, $2, $3)
           ON CONFLICT (parcel_id, user_id) DO UPDATE SET last_id = GREATEST(message_reads.last_id, EXCLUDED.last_id)`,
          [id, user.id, last],
        );
      }
      return {
        messages: rows.map((r) => ({
          id: Number(r.id),
          mine: r.sender_id === user.id,
          body: r.body as string,
          at: (r.created_at as Date).toISOString(),
        })),
        note: 'Messages are kept by Tuma as evidence if there is a dispute.',
      };
    });

    app.post('/parcels/:id/messages', { preHandler: people }, async (req, reply) => {
      const { id } = parse(uuidParam, req.params);
      const { body } = parse(sendBody, req.body);
      const user = userOf(req);
      if (PHONE_LIKE.test(body)) {
        throw new HttpError(400, 'validation', 'body: phone numbers cannot be sent in messages. Use the app to talk.');
      }
      await assertMember(id, user);
      const sent = await withTx(deps.pool, async (tx) => {
        // Try, never wait: a flood from one user must not park pool connections.
        const got = await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [`msg:${user.id}`]);
        if (!got.rows[0].ok) throw new HttpError(429, 'too_many_requests', 'Slow down, try again');
        const recent = await tx.query("SELECT count(*)::int AS n FROM messages WHERE sender_id = $1 AND created_at > now() - interval '1 minute'", [user.id]);
        if ((recent.rows[0].n as number) >= MAX_MESSAGES_PER_MINUTE) {
          throw new HttpError(429, 'too_many_requests', 'Too many messages, wait a minute');
        }
        const ins = await tx.query('INSERT INTO messages (parcel_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id, created_at', [id, user.id, body]);
        return ins.rows[0];
      });
      return reply.status(201).send({ id: Number(sent.id), mine: true, body, at: (sent.created_at as Date).toISOString() });
    });

    // Which of my parcels have messages I have not read: drives the new-message dot.
    app.get('/messages/unread', { preHandler: people }, async (req) => {
      const user = userOf(req);
      const { rows } = await deps.pool.query(
        `SELECT m.parcel_id, count(*)::int AS n
         FROM messages m JOIN parcels p ON p.id = m.parcel_id
         LEFT JOIN message_reads r ON r.parcel_id = m.parcel_id AND r.user_id = $1
         WHERE m.sender_id <> $1 AND m.id > COALESCE(r.last_id, 0) AND (p.shop_id = $1 OR p.rider_id = $1)
         GROUP BY m.parcel_id`,
        [user.id],
      );
      return { unread: rows.map((r) => ({ parcelId: r.parcel_id as string, count: r.n as number })) };
    });
  };
