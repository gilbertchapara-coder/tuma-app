import { holdDeposit, InsufficientFloatError, topup } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { insertEntries, lockRider, riderSummary } from '../repo';
import { centsSchema, parse, uuidParam } from '../validate';

const centsBody = z.object({ cents: centsSchema }).strict();
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

    app.get('/riders/me', { preHandler: rider }, async (req) => riderSummary(deps.pool, userOf(req).id));

    // Float top-ups and deposits are admin-recorded until a payment provider is wired in.
    app.post('/riders/:id/topup', { preHandler: admin }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { cents } = parse(centsBody, req.body);
      return withTx(deps.pool, async (tx) => {
        const { entries } = await lockRider(tx, id);
        const next = topup(entries, cents, new Date().toISOString());
        await insertEntries(tx, id, next.slice(entries.length));
        return { ok: true };
      });
    });

    app.post('/riders/:id/deposit', { preHandler: admin }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { cents } = parse(centsBody, req.body);
      return withTx(deps.pool, async (tx) => {
        const { entries } = await lockRider(tx, id);
        try {
          const next = holdDeposit(entries, cents, new Date().toISOString());
          await insertEntries(tx, id, next.slice(entries.length));
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
