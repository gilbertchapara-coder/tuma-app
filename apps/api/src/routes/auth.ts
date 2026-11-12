import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { countryFromPhone } from '@tuma/core';
import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { issueToken, type Role } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { parse, phoneSchema } from '../validate';

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const LOCK_AFTER_FAILURES = 10;
const FAILURE_WINDOW_HOURS = 24;
const LOCK_HOURS = 24;

const requestBody = z.object({ phone: phoneSchema }).strict();
const verifyBody = z
  .object({
    phone: phoneSchema,
    code: z.string().regex(/^[0-9]{6}$/, 'must be 6 digits'),
    role: z.enum(['shop', 'rider']).optional(),
    // A sender who is not a shop signs up as a customer. Same booking powers, different label.
    kind: z.enum(['shop', 'customer']).optional(),
  })
  .strict();

const hashOtp = (secret: string, phone: string, code: string): Buffer =>
  createHmac('sha256', secret).update(`otp:${phone}:${code}`).digest();

const invalidOtp = (): HttpError => new HttpError(401, 'invalid_otp', 'That code is wrong or has expired');

export const authRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    // Per-IP limit on every /auth route (this plugin is encapsulated, so it covers only these routes).
    await app.register(rateLimit, { max: deps.authRateLimitPerMinute, timeWindow: '1 minute' });

    app.post('/auth/otp/request', async (req) => {
      const { phone } = parse(requestBody, req.body);
      // A valid number is one from a country Tuma works in. Its dial code decides the country on sign-in.
      if (!countryFromPhone(phone)) throw new HttpError(400, 'unsupported_country', 'Tuma is not available for this phone number yet');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const hash = hashOtp(deps.jwtSecret, phone, code).toString('hex');
      const cooldown = deps.otpCooldownMs;
      const { rowCount } = await deps.pool.query(
        `INSERT INTO otp_challenges (phone, code_hash, expires_at, attempts, created_at)
         VALUES ($1, $2, now() + $3 * interval '1 millisecond', 0, now())
         ON CONFLICT (phone) DO UPDATE
           SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()
           WHERE otp_challenges.created_at <= now() - $4 * interval '1 millisecond'`,
        [phone, hash, OTP_TTL_MS, cooldown],
      );
      if (rowCount === 0) throw new HttpError(429, 'too_many_requests', 'Please wait before asking for another code');
      try {
        await deps.otp.send(phone, code);
      } catch {
        throw new HttpError(502, 'otp_unavailable', 'Could not send the code, try again');
      }
      return { ok: true };
    });

    app.post('/auth/otp/verify', async (req) => {
      const body = parse(verifyBody, req.body);
      const outcome = await withTx(deps.pool, async (tx) => {
        // Failure counter per phone, kept across new code requests. Locked phones fail like a wrong code.
        await tx.query('INSERT INTO otp_failures (phone) VALUES ($1) ON CONFLICT DO NOTHING', [body.phone]);
        const f = (
          await tx.query(
            `SELECT failures, window_start < now() - $2 * interval '1 hour' AS window_over,
                    locked_until IS NOT NULL AND locked_until > now() AS locked,
                    locked_until IS NOT NULL AND locked_until <= now() AS lock_over
             FROM otp_failures WHERE phone = $1 FOR UPDATE`,
            [body.phone, FAILURE_WINDOW_HOURS],
          )
        ).rows[0];
        if (f.locked) return { ok: false as const };
        if (f.window_over || f.lock_over) {
          await tx.query('UPDATE otp_failures SET failures = 0, window_start = now(), locked_until = NULL WHERE phone = $1', [body.phone]);
        }
        const recordFailure = async (): Promise<void> => {
          // Admin phones are throttled by the per-code limit and the request cooldown but never locked out for a day.
          if (deps.adminPhones.includes(body.phone)) return;
          await tx.query(
            `UPDATE otp_failures SET failures = failures + 1,
               locked_until = CASE WHEN failures + 1 >= $2 THEN now() + $3 * interval '1 hour' ELSE locked_until END
             WHERE phone = $1`,
            [body.phone, LOCK_AFTER_FAILURES, LOCK_HOURS],
          );
        };

        const { rows } = await tx.query(
          'SELECT code_hash, attempts, expires_at > now() AS live FROM otp_challenges WHERE phone = $1 FOR UPDATE',
          [body.phone],
        );
        const ch = rows[0];
        if (!ch) return { ok: false as const };
        if (!ch.live) return { ok: false as const };
        if (ch.attempts >= OTP_MAX_ATTEMPTS) {
          await recordFailure();
          return { ok: false as const };
        }
        const expected = Buffer.from(ch.code_hash as string, 'hex');
        const actual = hashOtp(deps.jwtSecret, body.phone, body.code);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          await tx.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE phone = $1', [body.phone]);
          await recordFailure();
          return { ok: false as const };
        }
        await tx.query('DELETE FROM otp_failures WHERE phone = $1', [body.phone]);
        await tx.query('DELETE FROM otp_challenges WHERE phone = $1', [body.phone]);

        const existing = await tx.query('SELECT id, role, kind, country FROM users WHERE phone = $1', [body.phone]);
        if (existing.rows[0]) return { ok: true as const, id: existing.rows[0].id as string, role: existing.rows[0].role as Role, kind: existing.rows[0].kind as string, country: existing.rows[0].country as string };

        const role: Role | undefined = deps.adminPhones.includes(body.phone) ? 'admin' : body.role;
        if (!role) throw new HttpError(400, 'validation', 'role: choose shop or rider to create an account');
        const kind = role === 'shop' ? (body.kind ?? 'shop') : 'shop';
        const country = countryFromPhone(body.phone) ?? 'ZW';
        const created = await tx.query('INSERT INTO users (phone, role, kind, country) VALUES ($1, $2, $3, $4) RETURNING id', [body.phone, role, kind, country]);
        const id = created.rows[0].id as string;
        if (role === 'rider') await tx.query('INSERT INTO riders (user_id) VALUES ($1)', [id]);
        return { ok: true as const, id, role, kind, country };
      });
      if (!outcome.ok) throw invalidOtp();
      return { token: issueToken(deps.jwtSecret, { id: outcome.id, role: outcome.role }), user: { id: outcome.id, role: outcome.role, kind: outcome.kind, country: outcome.country } };
    });
  };
