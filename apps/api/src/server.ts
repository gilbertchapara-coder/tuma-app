import pg from 'pg';
import { buildApp } from './app';
import { migrate } from './db';
import type { CodeNotifier, OtpProvider } from './ports';
import { createSmokeTestSms } from './smokeTestSms';

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


async function main(): Promise<void> {
  const jwtSecret = required('JWT_SECRET');
  const databaseUrl = required('DATABASE_URL');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  await migrate(pool);
  // TEST ONLY: both variables must be set. Only the listed phones get codes, readable with the key.
  const smokeKey = process.env.SMOKE_TEST_KEY;
  const smokePhones = (process.env.SMOKE_TEST_PHONES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const smoke = smokeKey && smokePhones.length > 0 ? createSmokeTestSms(smokePhones) : undefined;
  if (smoke) console.warn(`SMOKE TEST MODE ON for ${smokePhones.length} phone(s). Remove SMOKE_TEST_KEY to turn it off.`);
  const app = await buildApp({
    pool,
    otp: smoke ? smoke.otp : consoleSms,
    notifier: smoke ? smoke.notifier : consoleSms,
    smokeTest: smoke && smokeKey ? { key: smokeKey, sms: smoke } : undefined,
    jwtSecret,
    publicBaseUrl: required('PUBLIC_BASE_URL'),
    adminPhones: (process.env.ADMIN_PHONES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
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
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' });
}

main().catch((err: unknown) => {
  console.error('Failed to start:', err instanceof Error ? err.name : 'error');
  process.exit(1);
});
