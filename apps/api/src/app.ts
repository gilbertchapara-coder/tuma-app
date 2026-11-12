import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type pg from 'pg';
import { assertSecret } from './auth';
import { HttpError } from './errors';
import type { CodeNotifier, OtpProvider } from './ports';
import { authRoutes } from './routes/auth';
import { bindFlagJobPool } from './jobs/flagJob';
import { bundleRoutes } from './routes/bundles';
import { claimRoutes } from './routes/claims';
import { locationRoutes } from './routes/location';
import { metricsRoutes } from './routes/metrics';
import { codeRoutes } from './routes/codes';
import { parcelRoutes } from './routes/parcels';
import { photoRoutes } from './routes/photos';
import { riderRoutes } from './routes/riders';
import { topupRoutes } from './routes/topup';
import { smokeTestRoutes, type SmokeTestOptions } from './smokeTestSms';
import { DEFAULT_TOPUP_MAX_BALANCE_CENTS, DEFAULT_TOPUP_MAX_SINGLE_CENTS, noWalletProvider, type TopupProvider } from './topup/provider';

export interface AppOptions {
  pool: pg.Pool;
  otp: OtpProvider;
  notifier: CodeNotifier;
  /** Required; there is no default. */
  jwtSecret: string;
  publicBaseUrl: string;
  /** Phones that become admin on first sign-in. */
  adminPhones?: string[];
  /** Minimum gap between OTP requests for one phone. */
  otpCooldownMs?: number;
  /** Requests per minute per IP on /auth/*. Default 10. */
  authRateLimitPerMinute?: number;
  logger?: boolean | object;
  /** Wallet adapter for rider float top-ups. */
  topupProvider?: TopupProvider;
  /** Largest single top-up in cents. Default $20 (pilot placeholder). */
  topupMaxSingleCents?: number;
  /** Largest rider float in cents. Default $50 (pilot placeholder). */
  topupMaxBalanceCents?: number;
  /** TEST ONLY. Registers GET /smoke-test/code/:phone; leave unset in production use. */
  smokeTest?: SmokeTestOptions;
  /** Web page origins allowed to read the API from a browser (read-only: GET/HEAD). Empty means none. */
  corsOrigins?: string[];
}

export interface Deps {
  pool: pg.Pool;
  otp: OtpProvider;
  notifier: CodeNotifier;
  jwtSecret: string;
  publicBaseUrl: string;
  adminPhones: string[];
  otpCooldownMs: number;
  authRateLimitPerMinute: number;
  topupProvider: TopupProvider;
  topupMaxSingleCents: number;
  topupMaxBalanceCents: number;
}

const DEFAULT_OTP_COOLDOWN_MS = 30_000;
const DEFAULT_AUTH_RATE_LIMIT = 10;
const BODY_LIMIT_BYTES = 64 * 1024;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const deps: Deps = {
    pool: opts.pool,
    otp: opts.otp,
    notifier: opts.notifier,
    jwtSecret: assertSecret(opts.jwtSecret),
    publicBaseUrl: opts.publicBaseUrl.replace(/\/+$/, ''),
    adminPhones: opts.adminPhones ?? [],
    otpCooldownMs: opts.otpCooldownMs ?? DEFAULT_OTP_COOLDOWN_MS,
    authRateLimitPerMinute: opts.authRateLimitPerMinute ?? DEFAULT_AUTH_RATE_LIMIT,
    topupProvider: opts.topupProvider ?? noWalletProvider,
    topupMaxSingleCents: opts.topupMaxSingleCents ?? DEFAULT_TOPUP_MAX_SINGLE_CENTS,
    topupMaxBalanceCents: opts.topupMaxBalanceCents ?? DEFAULT_TOPUP_MAX_BALANCE_CENTS,
  };

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: BODY_LIMIT_BYTES });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', message: 'Invalid request' });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({ error: 'too_many_requests', message: 'Too many requests, slow down' });
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({ error: 'bad_request', message: 'The request could not be read' });
    }
    // Log the error class and code only: messages from the database can carry row values.
    const e = err as { name?: string; code?: string };
    req.log.error({ name: e.name, code: e.code }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  if (opts.corsOrigins && opts.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: opts.corsOrigins,
      methods: ['GET', 'HEAD'],
      allowedHeaders: ['authorization', 'content-type'],
      maxAge: 600,
    });
  }

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found' }));

  await app.register(authRoutes(deps));
  await app.register(riderRoutes(deps));
  await app.register(topupRoutes(deps));
  await app.register(photoRoutes(deps));
  await app.register(parcelRoutes(deps));
  await app.register(bundleRoutes(deps));
  await app.register(codeRoutes(deps));
  await app.register(claimRoutes(deps));
  await app.register(locationRoutes(deps));
  await app.register(metricsRoutes(deps));
  if (opts.smokeTest) await app.register(smokeTestRoutes(opts.smokeTest));
  bindFlagJobPool(deps.pool);
  return app;
}
