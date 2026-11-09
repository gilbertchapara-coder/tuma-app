import { appendEvent, checkCode, IllegalTransitionError, type CodeRecord, type CustodyEvent } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { insertEvent, loadEvents } from '../repo';
import { parse, uuidParam } from '../validate';

const deliverBody = z.object({ code: z.string().regex(/^[0-9]{6}$/, 'must be the 6 digit delivery code') }).strict();

type Outcome = { kind: 'delivered' } | { kind: 'locked' } | { kind: 'wrong'; attemptsLeft: number };

export const codeRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    // The rider enters the code the recipient reads out, so the delivered event is the recipient's confirmation.
    app.post('/parcels/:id/deliver', { preHandler: requireRole(deps.jwtSecret, 'rider') }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { code } = parse(deliverBody, req.body);
      const riderId = userOf(req).id;

      const outcome = await withTx(deps.pool, async (tx): Promise<Outcome> => {
        const parcel = await tx.query('SELECT rider_id FROM parcels WHERE id = $1', [id]);
        if (!parcel.rows[0]) throw new HttpError(404, 'not_found', 'Parcel not found');
        if (parcel.rows[0].rider_id !== riderId) throw new HttpError(403, 'forbidden', 'You have not accepted this parcel');

        // Row lock: concurrent guesses queue here, so every attempt sees the previous attempt's count.
        const row = await tx.query('SELECT hash, salt, failed_attempts, used, locked FROM delivery_codes WHERE parcel_id = $1 FOR UPDATE', [id]);
        const r = row.rows[0];
        if (!r) throw new HttpError(404, 'not_found', 'Parcel not found');
        const record: CodeRecord = {
          hash: r.hash,
          salt: r.salt,
          failedAttempts: r.failed_attempts,
          used: r.used,
          locked: r.locked,
        };
        if (record.locked) return { kind: 'locked' };

        // A guess is only an attempt when the parcel is actually in the rider's hands.
        const events = await loadEvents(tx, id);
        const delivered: CustodyEvent = { type: 'delivered', at: new Date().toISOString(), actor: 'recipient' };
        try {
          appendEvent(events, delivered);
        } catch (err) {
          if (err instanceof IllegalTransitionError) throw new HttpError(409, 'illegal_transition', err.message);
          throw err;
        }

        const result = checkCode(record, code);
        await tx.query('UPDATE delivery_codes SET failed_attempts = $2, used = $3, locked = $4 WHERE parcel_id = $1', [
          id,
          result.record.failedAttempts,
          result.record.used,
          result.record.locked,
        ]);
        if (!result.ok) {
          if (result.record.locked) return { kind: 'locked' };
          return { kind: 'wrong', attemptsLeft: Math.max(0, 3 - result.record.failedAttempts) };
        }
        await insertEvent(tx, id, delivered);
        return { kind: 'delivered' };
      });

      // The transaction has committed, so wrong attempts are persisted before we refuse.
      if (outcome.kind === 'locked') {
        throw new HttpError(423, 'code_locked', 'Too many wrong codes. This delivery is locked, contact Tuma support.');
      }
      if (outcome.kind === 'wrong') {
        throw new HttpError(403, 'invalid_code', 'That code is wrong', { attemptsLeft: outcome.attemptsLeft });
      }
      return { ok: true };
    });
  };
