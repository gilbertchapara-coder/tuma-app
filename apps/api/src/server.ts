import pg from 'pg';
import { buildApp } from './app';
import { migrate } from './db';
import type { CodeNotifier, OtpProvider } from './ports';
import { startOtpFailurePurge } from './jobs/purgeOtpFailures';
import { createSmokeTestSms } from './smokeTestSms';
import { clearSkyProvider, openMeteoProvider } from './weather/provider';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return v;
}

// No SMS provider is wired in yet; refuse to start with the console stand-in in production.
const consoleSms: OtpProvider & CodeNotifier = {
  async send(): Promise<void> {
    throw new Error('No SMS provider configured');
  },
  async sendDeliveryCode(): Promise<void> {
    throw new Error('No SMS provider configured');
  },
};


/** TRUST_PROXY=1 on Railway. Unset means do not trust forwarded headers. Anything but a small whole number stops the start. */
function trustProxyHops(): number | undefined {
  const raw = process.env.TRUST_PROXY;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    console.error('TRUST_PROXY must be a whole number from 0 to 5');
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  const jwtSecret = required('JWT_SECRET');
  const databaseUrl = required('DATABASE_URL');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  await migrate(pool);
  // TEST ONLY: both variables must be set. Only the listed phones get codes, readable with the key.
  const smokeKey = process.env.SMOKE_TEST_KEY;
  const adminPhones = (process.env.ADMIN_PHONES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // An admin phone must never be readable through the smoke-test route, even if it is listed by mistake.
  const smokePhones = (process.env.SMOKE_TEST_PHONES ?? '').split(',').map((s) => s.trim()).filter((p) => p && !adminPhones.includes(p));
  if (process.env.RAILWAY_ENVIRONMENT && process.env.TRUST_PROXY === undefined) {
    console.warn('TRUST_PROXY is not set on Railway: rate limits will see one shared IP. Set TRUST_PROXY=1.');
  }
  const smoke = smokeKey && smokePhones.length > 0 ? createSmokeTestSms(smokePhones) : undefined;
  if (smoke) console.warn(`SMOKE TEST MODE ON for ${smokePhones.length} phone(s). Remove SMOKE_TEST_KEY to turn it off.`);
  const app = await buildApp({
    pool,
    otp: smoke ? smoke.otp : consoleSms,
    notifier: smoke ? smoke.notifier : consoleSms,
    smokeTest: smoke && smokeKey ? { key: smokeKey, sms: smoke } : undefined,
    jwtSecret,
    // WEATHER=off turns the rain extra off (always clear). Only Harare's public coordinates are sent out.
    weatherProvider: process.env.WEATHER === 'off' ? clearSkyProvider : openMeteoProvider(),
    trustProxy: trustProxyHops(),
    publicBaseUrl: required('PUBLIC_BASE_URL'),
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    adminPhones,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization'],
      serializers: {
        // The tracking token is a capability; keep it out of logs.
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.replace(/\/track\/[^/?]+/, '/track/[redacted]'),
        }),
      },
    },
  });
  startOtpFailurePurge(pool, (msg) => app.log.warn(msg));
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' });
}

main().catch((err: unknown) => {
  console.error('Failed to start:', err instanceof Error ? err.name : 'error');
  process.exit(1);
});
