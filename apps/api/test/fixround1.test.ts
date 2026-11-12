import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { auth, book, createCtx, makeRider, type TestCtx, uploadPhoto } from './helpers';

let ctx: TestCtx;
let shop: { token: string; id: string };
let seq = 0;
const nextPhone = (prefix: string) => `+26377${prefix}${String(100000 + seq++)}`;

beforeAll(async () => {
  ctx = await createCtx();
  shop = await ctx.signIn('+263771900001', 'shop');
});
afterAll(async () => ctx.close());

const bundleOf = async (parcelId: string): Promise<string> =>
  (await ctx.pool.query('SELECT bundle_id FROM bundle_parcels WHERE parcel_id = $1', [parcelId])).rows[0].bundle_id;
const accept = (parcelBundle: string, token: string) =>
  ctx.app.inject({ method: 'POST', url: `/bundles/${parcelBundle}/accept`, headers: auth(token) });
const event = (parcelId: string, token: string, type: string, photoUrl?: string) =>
  ctx.app.inject({ method: 'POST', url: `/parcels/${parcelId}/events`, headers: auth(token), payload: { type, photoUrl } });
const lost = (parcelId: string, token: string) =>
  ctx.app.inject({ method: 'POST', url: `/parcels/${parcelId}/report-lost`, headers: auth(token), payload: {} });
const deliver = (parcelId: string, token: string, code: string) =>
  ctx.app.inject({ method: 'POST', url: `/parcels/${parcelId}/deliver`, headers: auth(token), payload: { code } });
const ledger = async (riderId: string, type: string) =>
  (await ctx.pool.query('SELECT count(*)::int n FROM ledger_entries WHERE rider_id=$1 AND type=$2', [riderId, type])).rows[0].n as number;
const balance = async (riderId: string) =>
  ((await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth((riders.get(riderId) as string)) })).json().balanceCents) as number;
const riders = new Map<string, string>();

async function accepted(level: 'express' = 'express') {
  const phone = nextPhone('5');
  const p = await book(ctx, shop.token, { level, recipientPhone: phone, recipientPhoneConfirm: phone });
  const rider = await makeRider(ctx, nextPhone('6'), { topupCents: 500 });
  riders.set(rider.id, rider.token);
  expect((await accept(await bundleOf(p.parcelId), rider.token)).statusCode).toBe(200);
  return { p, rider, code: ctx.notifier.codes.get(phone) as string };
}
async function pickedUp() {
  const a = await accepted();
  expect((await event(a.p.parcelId, a.rider.token, 'pickup_confirmed', await uploadPhoto(ctx, a.rider.token))).statusCode).toBe(201);
  return a;
}
const terminalCount = async (parcelId: string) =>
  (await ctx.pool.query(`SELECT count(*)::int n FROM custody_events WHERE parcel_id=$1 AND type IN ('delivered','reported_lost','cancelled')`, [parcelId])).rows[0].n as number;

describe('1. accept vs cancel, refund', () => {
  it('shop cancel after accept refunds the fee exactly once; a repeat cancel does not refund twice', async () => {
    const { p, rider } = await accepted();
    const before = await balance(rider.id);
    expect((await event(p.parcelId, shop.token, 'cancelled')).statusCode).toBe(201);
    expect(await ledger(rider.id, 'fee_refund')).toBe(1);
    expect(await balance(rider.id)).toBe(before + Math.round(p.priceCents * 0.2));
    expect((await event(p.parcelId, shop.token, 'cancelled')).statusCode).toBe(409);
    expect(await ledger(rider.id, 'fee_refund')).toBe(1);
  });

  it('cancel of a parcel nobody accepted refunds nothing and works', async () => {
    const p = await book(ctx, shop.token, { level: 'express' });
    expect((await event(p.parcelId, shop.token, 'cancelled')).statusCode).toBe(201);
    expect((await ctx.pool.query(`SELECT count(*)::int n FROM ledger_entries WHERE type='fee_refund' AND job_id=$1`, [p.parcelId])).rows[0].n).toBe(0);
  });

  it('parallel accept and cancel always end consistent: nobody out of pocket', async () => {
    for (let i = 0; i < 8; i += 1) {
      const p = await book(ctx, shop.token, { level: 'express' });
      const rider = await makeRider(ctx, nextPhone('7'), { topupCents: 500 });
      riders.set(rider.id, rider.token);
      const start = await balance(rider.id);
      const [a, c] = await Promise.all([accept(await bundleOf(p.parcelId), rider.token), event(p.parcelId, shop.token, 'cancelled')]);
      expect(c.statusCode).toBe(201);
      expect([200, 409]).toContain(a.statusCode);
      expect(await balance(rider.id)).toBe(start);
      expect(await ledger(rider.id, 'fee')).toBe(await ledger(rider.id, 'fee_refund'));
      expect(await ledger(rider.id, 'fee')).toBe(a.statusCode === 200 ? 1 : 0);
    }
  });
});

describe('2. deliver vs reported_lost race', () => {
  it('never leaves two terminal events in the chain', async () => {
    for (let i = 0; i < 6; i += 1) {
      const { p, rider, code } = await pickedUp();
      const [d, l] = await Promise.all([deliver(p.parcelId, rider.token, code), lost(p.parcelId, rider.token)]);
      expect([d.statusCode, l.statusCode].filter((s) => s === 200 || s === 201)).toHaveLength(1);
      expect(await terminalCount(p.parcelId)).toBe(1);
    }
  });
});

describe('3. who may end a parcel', () => {
  it('before pickup: shop and admin may cancel or report lost', async () => {
    const admin = await ctx.adminToken();
    const a = await book(ctx, shop.token, { level: 'express' });
    expect((await lost(a.parcelId, shop.token)).statusCode).toBe(201);
    const b = await book(ctx, shop.token, { level: 'express' });
    expect((await event(b.parcelId, admin, 'cancelled')).statusCode).toBe(201);
    const c = await book(ctx, shop.token, { level: 'express' });
    expect((await lost(c.parcelId, admin)).statusCode).toBe(201);
  });

  it('after pickup_confirmed: shop and admin cannot cancel (409), a shop loss claim only opens a claim, the assigned rider may report lost', async () => {
    const admin = await ctx.adminToken();
    const { p, rider } = await pickedUp();
    expect((await event(p.parcelId, shop.token, 'cancelled')).statusCode).toBe(409);
    expect((await event(p.parcelId, admin, 'cancelled')).statusCode).toBe(409);
    // A shop claim after pickup is only a review request: no custody event.
    expect((await lost(p.parcelId, shop.token)).statusCode).toBe(202);
    expect(await terminalCount(p.parcelId)).toBe(0);
    expect((await lost(p.parcelId, rider.token)).statusCode).toBe(201);
  });

  it('after in_transit: shop and admin cannot cancel (409), a shop loss claim only opens a claim, the assigned rider may report lost', async () => {
    const admin = await ctx.adminToken();
    const { p, rider } = await pickedUp();
    expect((await event(p.parcelId, rider.token, 'in_transit')).statusCode).toBe(201);
    expect((await event(p.parcelId, shop.token, 'cancelled')).statusCode).toBe(409);
    expect((await event(p.parcelId, admin, 'cancelled')).statusCode).toBe(409);
    // A shop claim after pickup is only a review request: no custody event.
    expect((await lost(p.parcelId, shop.token)).statusCode).toBe(202);
    expect((await lost(p.parcelId, rider.token)).statusCode).toBe(201);
  });

  it('a different rider cannot end it either', async () => {
    const { p } = await pickedUp();
    const other = await makeRider(ctx, nextPhone('8'), { topupCents: 100 });
    expect((await lost(p.parcelId, other.token)).statusCode).toBe(403);
  });
});

describe('4. OTP lockout', () => {
  const request = (phone: string) => ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
  const verify = (phone: string, code: string) =>
    ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code, role: 'shop' } });
  const wrongOf = (code: string) => (code === '000000' ? '111111' : '000000');

  it('10 wrong codes across fresh requests lock the phone: the correct code is then refused, new requests do not lift it', async () => {
    const phone = '+263776100001';
    for (let round = 0; round < 2; round += 1) {
      await request(phone);
      const wrong = wrongOf(ctx.otp.sent.get(phone) as string);
      for (let i = 0; i < 5; i += 1) expect((await verify(phone, wrong)).statusCode).toBe(401);
    }
    await request(phone);
    const code = ctx.otp.sent.get(phone) as string;
    const locked = await verify(phone, code);
    expect(locked.statusCode).toBe(401);
    const generic = (await verify(phone, wrongOf(code))).json();
    expect(locked.json()).toEqual(generic); // no oracle
    await request(phone);
    expect((await verify(phone, ctx.otp.sent.get(phone) as string)).statusCode).toBe(401);
  });

  it('a different phone is unaffected', async () => {
    const phone = '+263776100002';
    await request(phone);
    expect((await verify(phone, ctx.otp.sent.get(phone) as string)).statusCode).toBe(200);
  });

  it('a successful verify clears the count', async () => {
    const phone = '+263776100003';
    await request(phone);
    const wrong = wrongOf(ctx.otp.sent.get(phone) as string);
    for (let i = 0; i < 3; i += 1) await verify(phone, wrong);
    expect((await verify(phone, ctx.otp.sent.get(phone) as string)).statusCode).toBe(200);
    const row = await ctx.pool.query('SELECT 1 FROM otp_failures WHERE phone = $1', [phone]);
    expect(row.rowCount).toBe(0);
  });

  it('the lock lasts 24 hours and the failure window resets after 24 hours', async () => {
    const phone = '+263776100004';
    await ctx.pool.query(`INSERT INTO otp_failures (phone, failures, window_start, locked_until) VALUES ($1, 10, now(), now() + interval '24 hours')`, [phone]);
    await request(phone);
    expect((await verify(phone, ctx.otp.sent.get(phone) as string)).statusCode).toBe(401);
    await ctx.pool.query(`UPDATE otp_failures SET window_start = now() - interval '25 hours', locked_until = now() - interval '1 hour' WHERE phone = $1`, [phone]);
    await request(phone);
    expect((await verify(phone, ctx.otp.sent.get(phone) as string)).statusCode).toBe(200);
  });

  it('rate limits /auth/* per IP with 429', async () => {
    const limited = await buildApp({
      pool: ctx.pool,
      otp: ctx.otp,
      notifier: ctx.notifier,
      jwtSecret: randomBytes(32).toString('hex'),
      publicBaseUrl: 'https://tuma.test',
      otpCooldownMs: 0,
      authRateLimitPerMinute: 3,
    });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await limited.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: `+26377620000${i}` } })).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    await limited.close();
  });
});

describe('/bundles/open', () => {
  it('does not list an express job whose parcel has no sealed photo', async () => {
    const unsealed = await book(ctx, shop.token, { level: 'express', sealedPhotoUrl: undefined });
    const sealed = await book(ctx, shop.token, { level: 'express' });
    const rider = await makeRider(ctx, nextPhone('9'), { topupCents: 100 });
    const res = await ctx.app.inject({ method: 'GET', url: '/bundles/open', headers: auth(rider.token) });
    const ids = res.json().bundles.map((b: { id: string }) => b.id);
    expect(ids).toContain(await bundleOf(sealed.parcelId));
    expect(ids).not.toContain(await bundleOf(unsealed.parcelId));
  });
});
