import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { auth, createCtx, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createCtx();
});
afterAll(async () => ctx.close());

describe('startup', () => {
  it('refuses to build without a JWT secret', async () => {
    const base = { pool: ctx.pool, otp: ctx.otp, notifier: ctx.notifier, publicBaseUrl: 'https://x.test' };
    await expect(buildApp({ ...base, jwtSecret: undefined as unknown as string })).rejects.toThrow(/JWT_SECRET/);
    await expect(buildApp({ ...base, jwtSecret: 'short' })).rejects.toThrow(/JWT_SECRET/);
  });
});

describe('phone OTP', () => {
  it('signs in with the OTP and never returns it', async () => {
    const phone = '+263776000001';
    const req = await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    expect(req.statusCode).toBe(200);
    const code = ctx.otp.sent.get(phone) as string;
    expect(req.body).not.toContain(code);
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code, role: 'shop' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('shop');
    expect(res.json().token).toBeTruthy();
    // code is single use
    const again = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code, role: 'shop' } });
    expect(again.statusCode).toBe(401);
  });

  it('locks the OTP after 5 wrong tries, even for the right code', async () => {
    const phone = '+263776000002';
    await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    const code = ctx.otp.sent.get(phone) as string;
    const wrong = code === '000000' ? '111111' : '000000';
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: wrong, role: 'shop' } }),
      ),
    );
    expect(rs.every((r) => r.statusCode === 401)).toBe(true);
    const right = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code, role: 'shop' } });
    expect(right.statusCode).toBe(401);
  });

  it('a new user must choose shop or rider; admin cannot be self-selected', async () => {
    const phone = '+263776000003';
    await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    const code = ctx.otp.sent.get(phone);
    const asAdmin = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code, role: 'admin' } });
    expect(asAdmin.statusCode).toBe(400);
    const none = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } });
    expect(none.statusCode).toBe(400);
  });

  it('an existing user keeps their role whatever role they ask for', async () => {
    const rider = await ctx.signIn('+263776000004', 'rider');
    const again = await ctx.signIn('+263776000004', 'shop');
    expect(again.id).toBe(rider.id);
    const me = await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth(again.token) });
    expect(me.statusCode).toBe(200);
  });
});

describe('bearer tokens', () => {
  it('rejects missing, garbage, tampered and forged tokens', async () => {
    const s = await ctx.signIn('+263776000005', 'shop');
    const get = (h?: Record<string, string>) => ctx.app.inject({ method: 'GET', url: '/parcels', headers: h });
    expect((await get()).statusCode).toBe(401);
    expect((await get(auth('garbage'))).statusCode).toBe(401);
    const [payload, sig] = s.token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: s.id, role: 'admin', exp: 9999999999, iat: 1 })).toString('base64url');
    expect((await get(auth(`${forged}.${sig}`))).statusCode).toBe(401);
    expect((await get(auth(`${payload}.${randomBytes(32).toString('base64url')}`))).statusCode).toBe(401);
    expect((await get(auth(s.token))).statusCode).toBe(200);
  });

  it('role gates: rider routes need rider, shop routes need shop, admin routes need admin', async () => {
    const shop = await ctx.signIn('+263776000006', 'shop');
    const rider = await ctx.signIn('+263776000007', 'rider');
    expect((await ctx.app.inject({ method: 'GET', url: '/bundles/open', headers: auth(shop.token) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/parcels', headers: auth(rider.token) })).statusCode).toBe(403);
    const topup = await ctx.app.inject({
      method: 'POST',
      url: `/riders/${rider.id}/topup`,
      headers: auth(rider.token),
      payload: { cents: 100000 },
    });
    expect(topup.statusCode).toBe(403);
  });

  it('bad JSON returns a generic body without internals', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/parcels',
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });
    expect([400, 401]).toContain(res.statusCode);
    expect(res.body).not.toMatch(/node_modules|\.ts:|SyntaxError/);
  });
});
