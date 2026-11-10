import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTopupProvider } from '../src/topup/fakeProvider';
import { auth, createCtx, makeRider, type TestCtx } from './helpers';

let ctx: TestCtx;
let provider: FakeTopupProvider;

beforeAll(async () => {
  provider = new FakeTopupProvider();
  ctx = await createCtx({ topupProvider: provider, topupMaxSingleCents: 2000, topupMaxBalanceCents: 5000 });
});
afterAll(async () => ctx.close());

const topup = (token: string, cents: unknown) =>
  ctx.app.inject({ method: 'POST', url: '/riders/me/topup', headers: auth(token), payload: { cents } });
const balance = async (token: string) =>
  (await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth(token) })).json().balanceCents as number;

describe('POST /riders/me/topup', () => {
  it('refuses a top-up above the single maximum with a plain message', async () => {
    const r = await makeRider(ctx, '+263774100001', { depositCents: 0 });
    const res = await topup(r.token, 2001);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'topup_too_large', message: 'You can top up at most $20.00 at a time' });
    expect(await balance(r.token)).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it('refuses a top-up that would take the float above the maximum balance', async () => {
    const r = await makeRider(ctx, '+263774100002', { depositCents: 0, topupCents: 4500 });
    const res = await topup(r.token, 1000);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'balance_too_large', message: 'Your float cannot go above $50.00' });
    expect(await balance(r.token)).toBe(4500);
  });

  it('a confirmed top-up adds one topup entry', async () => {
    const r = await makeRider(ctx, '+263774100003', { depositCents: 0 });
    const res = await topup(r.token, 1500);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'confirmed' });
    expect(await balance(r.token)).toBe(1500);
    const n = await ctx.pool.query(`SELECT count(*)::int n FROM ledger_entries WHERE rider_id=$1 AND type='topup'`, [r.id]);
    expect(n.rows[0].n).toBe(1);
    expect(provider.requests.at(-1)).toMatchObject({ phone: '+263774100003', cents: 1500 });
  });

  it('an unconfirmed top-up adds nothing and says it is pending', async () => {
    provider.autoConfirm = false;
    const r = await makeRider(ctx, '+263774100004', { depositCents: 0 });
    const res = await topup(r.token, 1000);
    provider.autoConfirm = true;
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ok: false, status: 'pending' });
    expect(await balance(r.token)).toBe(0);
  });

  it('a provider failure adds nothing and gives a plain message', async () => {
    provider.failNext = true;
    const r = await makeRider(ctx, '+263774100005', { depositCents: 0 });
    const res = await topup(r.token, 1000);
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('We could not reach the payment service. Try again.');
    expect(await balance(r.token)).toBe(0);
  });

  it('needs a rider token and a positive whole-cent amount', async () => {
    const shop = await ctx.signIn('+263774100006', 'shop');
    expect((await topup(shop.token, 500)).statusCode).toBe(403);
    const r = await makeRider(ctx, '+263774100007', { depositCents: 0 });
    expect((await topup(r.token, 0)).statusCode).toBe(400);
    expect((await topup(r.token, 10.5)).statusCode).toBe(400);
  });
});
