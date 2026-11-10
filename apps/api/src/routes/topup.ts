import { balanceCents, topup } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { insertEntries, lockRider } from '../repo';
import { centsSchema, parse } from '../validate';

const body = z.object({ cents: centsSchema }).strict();
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const topupRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const rider = requireRole(deps.jwtSecret, 'rider');

    app.post('/riders/me/topup', { preHandler: rider }, async (req, reply) => {
      const user = userOf(req);
      const { cents } = parse(body, req.body);
      if (cents > deps.topupMaxSingleCents) {
        throw new HttpError(422, 'topup_too_large', `You can top up at most ${dollars(deps.topupMaxSingleCents)} at a time`);
      }
      const current = balanceCents((await withTx(deps.pool, (tx) => lockRider(tx, user.id))).entries);
      if (current + cents > deps.topupMaxBalanceCents) {
        throw new HttpError(422, 'balance_too_large', `Your float cannot go above ${dollars(deps.topupMaxBalanceCents)}`);
      }

      const phone = (await deps.pool.query('SELECT phone FROM users WHERE id = $1', [user.id])).rows[0]?.phone as string | undefined;
      if (!phone) throw new HttpError(404, 'not_found', 'Rider not found');

      let ref: string;
      let paid: boolean;
      try {
        ({ ref } = await deps.topupProvider.requestTopup(phone, cents));
        paid = await deps.topupProvider.confirmed(ref);
      } catch {
        throw new HttpError(502, 'payment_unavailable', 'We could not reach the payment service. Try again.');
      }
      if (!paid) return reply.status(202).send({ ok: false, status: 'pending', ref });

      // Re-check the cap inside the transaction: the balance may have moved while we waited on the provider.
      return withTx(deps.pool, async (tx) => {
        const { entries } = await lockRider(tx, user.id);
        if (balanceCents(entries) + cents > deps.topupMaxBalanceCents) {
          throw new HttpError(422, 'balance_too_large', `Your float cannot go above ${dollars(deps.topupMaxBalanceCents)}`);
        }
        const next = topup(entries, cents, new Date().toISOString());
        await insertEntries(tx, user.id, next.slice(entries.length));
        return { ok: true, status: 'confirmed', ref };
      });
    });
  };
