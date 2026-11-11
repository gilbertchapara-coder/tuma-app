import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { migrate } from '../src/db';
import { createSmokeTestSms } from '../src/smokeTestSms';

const KEY = 'k'.repeat(32);
const LISTED = '+263770000111';
const OTHER = '+263770000222';

describe('smoke-test sms stand-in', () => {
  let app: FastifyInstance;
  let appOff: FastifyInstance;
  let pool: pg.Pool;

  beforeAll(async () => {
    const adminUrl = inject('pgAdminUrl');
    const dbName = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: adminUrl.replace(/\/postgres$/, `/${dbName}`), max: 5 });
    await migrate(pool);
    const sms = createSmokeTestSms([LISTED]);
    const base = { pool, jwtSecret: 'j'.repeat(40), publicBaseUrl: 'https://example.test', otpCooldownMs: 0 };
    app = await buildApp({ ...base, otp: sms.otp, notifier: sms.notifier, smokeTest: { key: KEY, sms } });
    appOff = await buildApp({ ...base, otp: sms.otp, notifier: sms.notifier });
  });

  afterAll(async () => {
    await app.close();
    await appOff.close();
    await pool.end();
  });

  it('sends a code to a listed phone and returns it only with the right key', async () => {
    const req = await app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: LISTED } });
    expect(req.statusCode).toBe(200);
    const ok = await app.inject({ method: 'GET', url: `/smoke-test/code/${encodeURIComponent(LISTED)}`, headers: { 'x-smoke-key': KEY } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().code).toMatch(/^\d{6}$/);
    const bad = await app.inject({ method: 'GET', url: `/smoke-test/code/${encodeURIComponent(LISTED)}`, headers: { 'x-smoke-key': 'x'.repeat(32) } });
    expect(bad.statusCode).toBe(404);
    const none = await app.inject({ method: 'GET', url: `/smoke-test/code/${encodeURIComponent(LISTED)}` });
    expect(none.statusCode).toBe(404);
  });

  it('still refuses to send to a phone that is not listed', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: OTHER } });
    expect(res.statusCode).toBe(502);
    const peek = await app.inject({ method: 'GET', url: `/smoke-test/code/${encodeURIComponent(OTHER)}`, headers: { 'x-smoke-key': KEY } });
    expect(peek.statusCode).toBe(404);
  });

  it('has no code route at all when smoke-test mode is off', async () => {
    const res = await appOff.inject({ method: 'GET', url: `/smoke-test/code/${encodeURIComponent(LISTED)}`, headers: { 'x-smoke-key': KEY } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a short key when building the route', async () => {
    const sms = createSmokeTestSms([LISTED]);
    await expect(
      buildApp({ pool, jwtSecret: 'j'.repeat(40), publicBaseUrl: 'https://example.test', otp: sms.otp, notifier: sms.notifier, smokeTest: { key: 'short', sms } }),
    ).rejects.toThrow();
  });
});
