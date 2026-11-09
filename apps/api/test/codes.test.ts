import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, book, createCtx, makeRider, type TestCtx } from './helpers';

let ctx: TestCtx;
let shop: { token: string; id: string };

beforeAll(async () => {
  ctx = await createCtx();
  shop = await ctx.signIn('+263771200001', 'shop');
});
afterAll(async () => ctx.close());

const bundleOf = async (parcelId: string): Promise<string> =>
  (await ctx.pool.query('SELECT bundle_id FROM bundle_parcels WHERE parcel_id = $1', [parcelId])).rows[0].bundle_id;

/** A parcel that the rider has accepted and picked up. */
async function pickedUp(n: number) {
  const phone = `+26377500${String(1000 + n)}`;
  const p = await book(ctx, shop.token, { level: 'express', recipientPhone: phone, recipientPhoneConfirm: phone });
  const rider = await makeRider(ctx, `+26377360${String(1000 + n)}`, { topupCents: 500 });
  const acc = await ctx.app.inject({
    method: 'POST',
    url: `/bundles/${await bundleOf(p.parcelId)}/accept`,
    headers: auth(rider.token),
  });
  expect(acc.statusCode).toBe(200);
  const pk = await ctx.app.inject({
    method: 'POST',
    url: `/parcels/${p.parcelId}/events`,
    headers: auth(rider.token),
    payload: { type: 'pickup_confirmed', photoUrl: 'https://photos.test/pickup.jpg' },
  });
  expect(pk.statusCode).toBe(201);
  return { p, rider, code: ctx.notifier.codes.get(phone) as string };
}

const deliver = (parcelId: string, token: string, code: unknown) =>
  ctx.app.inject({ method: 'POST', url: `/parcels/${parcelId}/deliver`, headers: auth(token), payload: { code } });
const wrongOf = (code: string) => (code === '000000' ? '111111' : '000000');
const deliveredCount = async (parcelId: string) =>
  (await ctx.pool.query(`SELECT count(*)::int n FROM custody_events WHERE parcel_id=$1 AND type='delivered'`, [parcelId])).rows[0].n;

describe('POST /parcels/:id/deliver', () => {
  it('delivers with the right code, once', async () => {
    const { p, rider, code } = await pickedUp(1);
    const res = await deliver(p.parcelId, rider.token, code);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const track = await ctx.app.inject({ method: 'GET', url: `/track/${p.trackingUrl.split('/track/')[1]}` });
    expect(track.json()).toMatchObject({ status: 'delivered', stage: 'delivered' });
    expect((await deliver(p.parcelId, rider.token, code)).statusCode).toBe(409);
  });

  it('the tracking token alone cannot deliver; a rider who did not accept cannot deliver', async () => {
    const { p, code } = await pickedUp(2);
    const token = p.trackingUrl.split('/track/')[1] as string;
    const anon = await ctx.app.inject({ method: 'POST', url: `/parcels/${p.parcelId}/deliver`, payload: { code } });
    expect(anon.statusCode).toBe(401);
    const asToken = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/deliver`,
      headers: auth(token),
      payload: { code },
    });
    expect(asToken.statusCode).toBe(401);
    const other = await makeRider(ctx, '+263773699999', { topupCents: 100 });
    expect((await deliver(p.parcelId, other.token, code)).statusCode).toBe(403);
    expect(await deliveredCount(p.parcelId)).toBe(0);
  });

  it('malformed code is rejected with 400 and does not count as an attempt', async () => {
    const { p, rider } = await pickedUp(3);
    expect((await deliver(p.parcelId, rider.token, 'abc')).statusCode).toBe(400);
    expect((await deliver(p.parcelId, rider.token, 123456)).statusCode).toBe(400);
    const row = await ctx.pool.query('SELECT failed_attempts FROM delivery_codes WHERE parcel_id=$1', [p.parcelId]);
    expect(row.rows[0].failed_attempts).toBe(0);
  });

  it('3 sequential wrong codes lock it; the correct code is then refused', async () => {
    const { p, rider, code } = await pickedUp(4);
    const wrong = wrongOf(code);
    expect((await deliver(p.parcelId, rider.token, wrong)).statusCode).toBe(403);
    expect((await deliver(p.parcelId, rider.token, wrong)).statusCode).toBe(403);
    expect((await deliver(p.parcelId, rider.token, wrong)).statusCode).toBe(423);
    const right = await deliver(p.parcelId, rider.token, code);
    expect(right.statusCode).toBe(423);
    expect(right.json().error).toBe('code_locked');
  });

  it('10 parallel wrong guesses count only 3 attempts, lock the record, and refuse even the right code', async () => {
    const { p, rider, code } = await pickedUp(5);
    const wrong = wrongOf(code);
    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(p.parcelId, rider.token, wrong)));
    const row = await ctx.pool.query('SELECT failed_attempts, locked, used FROM delivery_codes WHERE parcel_id=$1', [p.parcelId]);
    expect(row.rows[0]).toEqual({ failed_attempts: 3, locked: true, used: false });
    expect(results.filter((r) => r.statusCode === 403).length).toBeLessThanOrEqual(3);
    expect(results.every((r) => r.statusCode === 403 || r.statusCode === 423)).toBe(true);
    expect((await deliver(p.parcelId, rider.token, code)).statusCode).toBe(423);
    expect(await deliveredCount(p.parcelId)).toBe(0);
  });

  it('parallel correct code: exactly one delivery', async () => {
    const { p, rider, code } = await pickedUp(6);
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(p.parcelId, rider.token, code)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await deliveredCount(p.parcelId)).toBe(1);
  });

  it('a guess before pickup is refused without burning an attempt', async () => {
    const p = await book(ctx, shop.token, { level: 'express' });
    const rider = await makeRider(ctx, '+263773688888', { topupCents: 100 });
    await ctx.app.inject({
      method: 'POST',
      url: `/bundles/${await bundleOf(p.parcelId)}/accept`,
      headers: auth(rider.token),
    });
    const res = await deliver(p.parcelId, rider.token, '123456');
    expect(res.statusCode).toBe(409);
    const row = await ctx.pool.query('SELECT failed_attempts FROM delivery_codes WHERE parcel_id=$1', [p.parcelId]);
    expect(row.rows[0].failed_attempts).toBe(0);
  });

  it('stores only a hash of the code', async () => {
    const { p, code } = await pickedUp(7);
    const row = await ctx.pool.query('SELECT * FROM delivery_codes WHERE parcel_id=$1', [p.parcelId]);
    expect(JSON.stringify(row.rows[0])).not.toContain(code);
  });
});
