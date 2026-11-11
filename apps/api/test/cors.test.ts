import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { migrate } from '../src/db';
import { FakeNotifier, FakeOtp } from './helpers';

const WEB = 'https://tuma-web.example.test';

describe('CORS for the web page', () => {
  let withCors: FastifyInstance;
  let without: FastifyInstance;
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
    const base = { pool, otp: new FakeOtp(), notifier: new FakeNotifier(), jwtSecret: 'j'.repeat(40), publicBaseUrl: 'https://example.test' };
    withCors = await buildApp({ ...base, corsOrigins: [WEB] });
    without = await buildApp(base);
  });

  afterAll(async () => {
    await withCors.close();
    await without.close();
    await pool.end();
  });

  it('lets the listed web origin read the tracking lookup', async () => {
    const res = await withCors.inject({ method: 'GET', url: '/track/nope', headers: { origin: WEB } });
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
  });

  it('answers the preflight for the dashboard call with the Authorization header', async () => {
    const res = await withCors.inject({
      method: 'OPTIONS',
      url: '/admin/metrics',
      headers: { origin: WEB, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('authorization');
  });

  it('gives no access to any other origin', async () => {
    const res = await withCors.inject({ method: 'GET', url: '/track/nope', headers: { origin: 'https://evil.example.test' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not allow cross-site writes even from the listed origin', async () => {
    const res = await withCors.inject({
      method: 'OPTIONS',
      url: '/parcels',
      headers: { origin: WEB, 'access-control-request-method': 'POST' },
    });
    expect(String(res.headers['access-control-allow-methods'] ?? '')).not.toMatch(/POST/);
  });

  it('sends no CORS headers when no origin is configured', async () => {
    const res = await without.inject({ method: 'GET', url: '/track/nope', headers: { origin: WEB } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
