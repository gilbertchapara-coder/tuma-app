import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { canRequest, eligibility, repaymentCents, type LoyaltyStats } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { centsSchema, parse, uuidParam } from '../validate';

const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const DAY_MS = 86_400_000;
const LIVE = `('pending_code', 'requested', 'active', 'late')`;

const requestBody = z.object({ principalCents: centsSchema }).strict();
const confirmBody = z.object({ code: z.string().regex(/^[0-9]{6}$/, 'must be the 6-digit code') }).strict();

const hashCode = (secret: string, loanId: string, code: string): Buffer =>
  createHmac('sha256', secret).update(`loan:${loanId}:${code}`).digest();

const SAFETY_NOTE = 'Nobody from Tuma will ever ask you for this code. Do not share it.';
const PARTNER_NOTE = 'Loans are provided by a licensed partner. Tuma does not lend or hold your money.';

export const loanRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const people = requireRole(deps.jwtSecret, 'shop', 'rider');

    async function loyalty(userId: string, role: string): Promise<LoyaltyStats> {
      const u = (await deps.pool.query('SELECT created_at FROM users WHERE id = $1', [userId])).rows[0];
      const ageDays = Math.floor((Date.now() - (u.created_at as Date).getTime()) / DAY_MS);
      const loans = (
        await deps.pool.query(
          `SELECT count(*) FILTER (WHERE status = 'late')::int AS late, count(*) FILTER (WHERE status IN ${LIVE})::int AS live FROM loans WHERE user_id = $1`,
          [userId],
        )
      ).rows[0];
      if (role === 'rider') {
        const r = (await deps.pool.query('SELECT verified, clean_deliveries FROM riders WHERE user_id = $1', [userId])).rows[0];
        const flags = (await deps.pool.query(`SELECT count(*)::int AS n FROM flags WHERE rider_id = $1 AND raised_at > now() - interval '30 days'`, [userId])).rows[0];
        const claims = (
          await deps.pool.query(`SELECT count(*)::int AS n FROM claims c JOIN parcels p ON p.id = c.parcel_id WHERE p.rider_id = $1 AND c.status = 'open'`, [userId])
        ).rows[0];
        return {
          verified: Boolean(r?.verified),
          accountAgeDays: ageDays,
          cleanParcels: r?.clean_deliveries ?? 0,
          openFlags: (flags.n as number) + (claims.n as number),
          lateRepayments: loans.late,
          activeLoans: loans.live,
        };
      }
      const clean = (
        await deps.pool.query(
          `SELECT count(*)::int AS n FROM parcels p
           WHERE p.shop_id = $1 AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.parcel_id = p.id)
             AND (SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1) = 'delivered'`,
          [userId],
        )
      ).rows[0];
      const open = (
        await deps.pool.query(`SELECT count(*)::int AS n FROM claims c JOIN parcels p ON p.id = c.parcel_id WHERE p.shop_id = $1 AND c.status = 'open'`, [userId])
      ).rows[0];
      return {
        verified: clean.n > 0, // a shop is trusted once a parcel of theirs has been delivered
        accountAgeDays: ageDays,
        cleanParcels: clean.n,
        openFlags: open.n,
        lateRepayments: loans.late,
        activeLoans: loans.live,
      };
    }

    app.get('/loans/status', { preHandler: people }, async (req) => {
      const user = userOf(req);
      const stats = await loyalty(user.id, user.role);
      const e = eligibility(stats);
      const current = (
        await deps.pool.query(
          `SELECT id, principal_cents, repay_cents, status, due_at FROM loans WHERE user_id = $1 AND status IN ${LIVE} ORDER BY created_at DESC LIMIT 1`,
          [user.id],
        )
      ).rows[0];
      return {
        partnerConnected: deps.lendingPartner.connected,
        partnerNote: PARTNER_NOTE,
        cleanParcels: stats.cleanParcels,
        eligible: e.eligible,
        limitCents: e.limitCents,
        reasons: e.reasons,
        nextStepAt: e.nextStepAt,
        loan: current
          ? {
              id: current.id as string,
              principalCents: current.principal_cents as number,
              repayCents: current.repay_cents as number,
              status: current.status as string,
              dueAt: current.due_at ? (current.due_at as Date).toISOString() : null,
            }
          : null,
      };
    });

    // Step 1: ask. Sends a 6-digit code to the person's own phone; nothing is requested from the partner yet.
    app.post('/loans', { preHandler: people }, async (req, reply) => {
      const { principalCents } = parse(requestBody, req.body);
      const user = userOf(req);
      if (!deps.lendingPartner.connected) {
        throw new HttpError(503, 'partner_unavailable', 'Loans are not available yet. A licensed partner has not been connected.');
      }
      const e = eligibility(await loyalty(user.id, user.role));
      if (!e.eligible) throw new HttpError(403, 'not_eligible', e.reasons[0] ?? 'You cannot ask for a loan yet');
      if (!canRequest(e, principalCents)) throw new HttpError(400, 'validation', `principalCents: the most you can ask for is ${e.limitCents}`);
      const { feeBps, termDays } = deps.lendingPartner.quote(principalCents);
      const repayCents = repaymentCents(principalCents, feeBps);
      const phone = (await deps.pool.query('SELECT phone FROM users WHERE id = $1', [user.id])).rows[0].phone as string;

      const loanId = await withTx(deps.pool, async (tx) => {
        const ins = await tx.query(
          `INSERT INTO loans (user_id, principal_cents, repay_cents, status) VALUES ($1, $2, $3, 'pending_code')
           ON CONFLICT DO NOTHING RETURNING id`,
          [user.id, principalCents, repayCents],
        );
        if (!ins.rows[0]) throw new HttpError(409, 'loan_exists', 'Pay your current loan first.');
        const id = ins.rows[0].id as string;
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await tx.query(
          `UPDATE loans SET code_hash = $2, code_expires_at = now() + $3 * interval '1 minute' WHERE id = $1`,
          [id, hashCode(deps.jwtSecret, id, code).toString('hex'), CODE_TTL_MINUTES],
        );
        try {
          await deps.otp.send(phone, code);
        } catch {
          throw new HttpError(502, 'otp_unavailable', 'Could not send the code, try again');
        }
        return id;
      });
      return reply.status(201).send({ loanId, principalCents, repayCents, feeBps, termDays, safetyNote: SAFETY_NOTE });
    });

    // Step 2: confirm with the code. Only now does the partner hear about it.
    app.post('/loans/:id/confirm', { preHandler: people }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const { code } = parse(confirmBody, req.body);
      const user = userOf(req);
      const result = await withTx(deps.pool, async (tx) => {
        const l = (await tx.query('SELECT * FROM loans WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, user.id])).rows[0];
        if (!l) throw new HttpError(404, 'not_found', 'Loan not found');
        if (l.status !== 'pending_code') throw new HttpError(409, 'wrong_state', 'This loan is not waiting for a code');
        const live = (await tx.query('SELECT $1::timestamptz > now() AS live', [l.code_expires_at])).rows[0].live as boolean;
        if (!live || l.code_attempts >= MAX_CODE_ATTEMPTS) {
          await tx.query(`UPDATE loans SET status = 'cancelled' WHERE id = $1`, [id]);
          return { cancelled: true as const };
        }
        const ok = timingSafeEqual(Buffer.from(l.code_hash as string, 'hex'), hashCode(deps.jwtSecret, id, code));
        if (!ok) {
          await tx.query('UPDATE loans SET code_attempts = code_attempts + 1 WHERE id = $1', [id]);
          return { wrong: true as const };
        }
        return { loan: l };
      });
      if ('cancelled' in result) throw new HttpError(401, 'invalid_code', 'That code has expired. Start again.');
      if ('wrong' in result) throw new HttpError(401, 'invalid_code', 'That code is wrong');

      const phone = (await deps.pool.query('SELECT phone FROM users WHERE id = $1', [user.id])).rows[0].phone as string;
      try {
        const decision = await deps.lendingPartner.request({ loanId: id, userId: user.id, phone, principalCents: result.loan.principal_cents });
        if (decision.status === 'declined') {
          await deps.pool.query(`UPDATE loans SET status = 'declined', partner_ref = $2 WHERE id = $1`, [id, decision.ref]);
          return { status: 'declined' as const };
        }
        const due = new Date(Date.now() + decision.termDays * DAY_MS).toISOString();
        await deps.pool.query(`UPDATE loans SET status = 'active', partner_ref = $2, due_at = $3 WHERE id = $1`, [id, decision.ref, due]);
        return { status: 'active' as const, dueAt: due, repayCents: result.loan.repay_cents as number };
      } catch {
        await deps.pool.query(`UPDATE loans SET status = 'cancelled' WHERE id = $1`, [id]);
        throw new HttpError(502, 'partner_unavailable', 'The lending partner did not answer. Nothing was lent. Try again later.');
      }
    });

    app.post('/loans/:id/cancel', { preHandler: people }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const done = await deps.pool.query(`UPDATE loans SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'pending_code'`, [id, userOf(req).id]);
      if (!done.rowCount) throw new HttpError(409, 'wrong_state', 'Only a loan waiting for its code can be cancelled');
      return { ok: true };
    });
  };
