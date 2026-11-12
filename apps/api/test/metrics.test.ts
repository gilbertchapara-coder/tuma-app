import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, book, createCtx, type TestCtx } from './helpers';

let ctx: TestCtx;
let shop: { token: string; id: string };

beforeAll(async () => {
  ctx = await createCtx();
  shop = await ctx.signIn('+263771500001', 'shop');
});
afterAll(async () => ctx.close());

const metrics = async (token: string) =>
  ctx.app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(token) });

describe('GET /admin/metrics', () => {
  it('is admin only', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/metrics' })).statusCode).toBe(401);
    expect((await metrics(shop.token)).statusCode).toBe(403);
  });

  it('starts empty', async () => {
    const res = await metrics(await ctx.adminToken());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parcelsPerRun: [], ridersActive: 0, feesCents: 0, feesByCountry: [] });
  });

  it('counts parcels per run per day, from the suburb table', async () => {
    await book(ctx, shop.token, { suburb: 'Avenues' });
    await book(ctx, shop.token, { suburb: 'Milton Park' });
    await book(ctx, shop.token, { suburb: 'Mbare' });
    const body = (await metrics(await ctx.adminToken())).json();
    const today = new Date().toISOString().slice(0, 10);
    const rows = body.parcelsPerRun as Array<{ run: string; date: string; count: number }>;
    expect(rows).toContainEqual({ run: 'north', date: today, count: 2 });
    expect(rows).toContainEqual({ run: 'southwest', date: today, count: 1 });
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))).toBe(true);
  });

  it('never returns phones, contents or tokens', async () => {
    const res = await metrics(await ctx.adminToken());
    expect(res.body).not.toMatch(/\+263|Phone case|track/i);
  });
});

describe('GET /track/:token extras', () => {
  it('returns the run and only the last 3 digits of the phone', async () => {
    const p = await book(ctx, shop.token, {
      suburb: 'Waterfalls',
      recipientPhone: '+263772000123',
      recipientPhoneConfirm: '+263772000123',
    });
    const token = p.trackingUrl.replace('https://tuma.test/track/', '');
    const res = await ctx.app.inject({ method: 'GET', url: `/track/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run).toBe('south');
    expect(body.phoneLast3).toBe('123');
    expect(res.body).not.toContain('+263772000123');
    expect(res.body).not.toContain('263772000');
  });
});
