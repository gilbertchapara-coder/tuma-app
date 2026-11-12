/**
 * MOCK SERVER for Tuma. A throwaway database, fake SMS (codes print here), fake top-up, clear weather, and Zambia
 * loaded with MOCK suburbs and prices so you can try the app in both countries.
 *   npm run mock:serve -w apps/api        then point the app at it: EXPO_PUBLIC_MOCK=1 EXPO_PUBLIC_API_URL=http://<this computer>:4880
 * Nothing here touches production. Every Zambia value and percentage below is MOCK; the owner's real ones replace them.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../src/app';
import { migrate } from '../src/db';
import { FakeTopupProvider } from '../src/topup/fakeProvider';
import { clearSkyProvider } from '../src/weather/provider';
import type { CodeNotifier, OtpProvider } from '../src/ports';

const require = createRequire(import.meta.url);
const EmbeddedPostgres = (require('embedded-postgres').default ?? require('embedded-postgres')) as typeof import('embedded-postgres').default;

const PORT = Number(process.env.MOCK_PORT ?? 4880);
const PG_PORT = PORT + 1;
const ADMIN_PHONE = '+263770000001';

class ConsoleSms implements OtpProvider, CodeNotifier {
  async send(phone: string, code: string): Promise<void> {
    console.log(`[MOCK SMS] sign-in code for ${phone}: ${code}`);
  }
  async sendDeliveryCode(phone: string, code: string): Promise<void> {
    console.log(`[MOCK SMS] delivery code for ${phone}: ${code}`);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tuma-mock-serve-'));
  const db = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await db.initialise();
  await db.start();
  const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`, max: 10 });
  await migrate(pool);
  await pool.query(`INSERT INTO country_settings (country, platform_bps) VALUES ('ZW', 2000)`); // MOCK 20%
  await pool.query(
    `INSERT INTO country_settings (country, platform_bps, suburbs, prices) VALUES ('ZM', 1000, $1, $2)`, // MOCK values
    [JSON.stringify({ Kabulonga: { band: 'A', run: 'south' }, Woodlands: { band: 'A', run: 'south' } }), JSON.stringify({ A: [3000, 2000, 1500] })],
  ).catch(() => console.log('(Zambia mock settings not loaded: load them from the web dashboard Countries tab)'));
  const sms = new ConsoleSms();
  const app = await buildApp({
    pool, otp: sms, notifier: sms, jwtSecret: randomBytes(32).toString('hex'), publicBaseUrl: `http://localhost:${PORT}`,
    adminPhones: [ADMIN_PHONE], otpCooldownMs: 0, authRateLimitPerMinute: 1000,
    topupProvider: new FakeTopupProvider(), weatherProvider: clearSkyProvider,
  });
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`MOCK Tuma API on http://localhost:${PORT}. Sign in with any +263 or +260 number; codes print here. Ctrl+C to stop.`);
  const stop = async (): Promise<void> => {
    await app.close();
    await pool.end();
    await db.stop();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
