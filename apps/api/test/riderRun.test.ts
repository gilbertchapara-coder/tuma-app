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
const accept = (bundleId: string, token: string) =>
  ctx.app.inject({ method: 'POST', url: `/bundles/${bundleId}/accept`, headers: auth(token) });
const run = (token: string) => ctx.app.inject({ method: 'GET', url: '/riders/me/run', headers: auth(token) });

describe('GET /riders/me/run', () => {
  it('is for riders only', async () => {
    expect((await run(shop.token)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/riders/me/run' })).statusCode).toBe(401);
  });

  it('is empty before the rider accepts anything', async () => {
    const rider = await makeRider(ctx, '+263773400001', { topupCents: 500 });
    const res = await run(rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parcels: [] });
  });

  it('lists the rider own accepted parcels as id and suburb, and no one else', async () => {
    const mine = await book(ctx, shop.token, { suburb: 'Mbare', level: 'express' });
    const theirs = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express' });
    const r1 = await makeRider(ctx, '+263773400002', { topupCents: 500 });
    const r2 = await makeRider(ctx, '+263773400003', { topupCents: 500 });
    expect((await accept(await bundleOf(mine.parcelId), r1.token)).statusCode).toBe(200);
    expect((await accept(await bundleOf(theirs.parcelId), r2.token)).statusCode).toBe(200);
    expect((await run(r1.token)).json()).toEqual({ parcels: [{ id: mine.parcelId, suburb: 'Mbare' }] });
    expect((await run(r2.token)).json()).toEqual({ parcels: [{ id: theirs.parcelId, suburb: 'Avenues' }] });
  });

  it('drops a parcel once it has ended', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Avondale', level: 'express' });
    const rider = await makeRider(ctx, '+263773400004', { topupCents: 500 });
    await accept(await bundleOf(p.parcelId), rider.token);
    expect((await run(rider.token)).json().parcels).toHaveLength(1);
    const end = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/events`,
      headers: auth(rider.token),
      payload: { type: 'cancelled' },
    });
    expect(end.statusCode).toBe(201);
    expect((await run(rider.token)).json()).toEqual({ parcels: [] });
  });
});
