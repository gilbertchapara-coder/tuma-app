import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createCtx, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createCtx();
});
afterAll(async () => ctx.close());

const HARARE = { lat: -17.83, lng: 31.05 };
const LUSAKA = { lat: -15.42, lng: 28.28 };
const detect = (token: string, body: unknown) =>
  ctx.app.inject({ method: 'POST', url: '/me/country/detect', headers: auth(token), payload: body as object });
const meCountry = async (token: string): Promise<string> =>
  (await ctx.app.inject({ method: 'GET', url: '/me', headers: auth(token) })).json().country.code;

describe('country from GPS', () => {
  it('moves a Zimbabwe rider to Zambia when they are in Lusaka, and back again in Harare', async () => {
    const rider = await ctx.signIn('+263771500001', 'rider');
    const toZm = await detect(rider.token, LUSAKA);
    expect(toZm.statusCode).toBe(200);
    expect(toZm.json()).toMatchObject({ changed: true, country: { code: 'ZM', currency: 'ZMW', currencySymbol: 'K' } });
    expect(await meCountry(rider.token)).toBe('ZM');
    const back = await detect(rider.token, HARARE);
    expect(back.json()).toMatchObject({ changed: true, country: { code: 'ZW', currencySymbol: '$' } });
  });

  it('changes nothing when the rider is already in that country', async () => {
    const rider = await ctx.signIn('+263771500002', 'rider');
    expect((await detect(rider.token, HARARE)).json()).toEqual({ changed: false, reason: 'same_country' });
  });

  it('changes nothing near a border or outside both countries', async () => {
    const rider = await ctx.signIn('+263771500003', 'rider');
    expect((await detect(rider.token, { lat: -17.93, lng: 25.85 })).json()).toEqual({ changed: false, reason: 'unclear' });
    expect((await detect(rider.token, { lat: -26.2, lng: 28.04 })).json()).toEqual({ changed: false, reason: 'unclear' });
    expect(await meCountry(rider.token)).toBe('ZW');
  });

  it('will not move a rider who is holding parcels', async () => {
    const rider = await ctx.signIn('+263771500004', 'rider');
    const shop = await ctx.signIn('+263771500005', 'shop');
    const parcel = await ctx.pool.query(
      `INSERT INTO parcels (shop_id, rider_id, suburb, level, value_cents, contents, recipient_phone, price_cents, track_token, country)
       VALUES ($1, $2, 'Avenues', 'standard', 1000, 'x', '+263771234567', 100, 'detect-busy', 'ZW') RETURNING id`,
      [shop.id, rider.id],
    );
    await ctx.pool.query(`INSERT INTO custody_events (parcel_id, type, at, actor) VALUES ($1, 'booked', now(), 'shop')`, [parcel.rows[0].id]);
    const res = await detect(rider.token, LUSAKA);
    expect(res.statusCode).toBe(409);
    expect(await meCountry(rider.token)).toBe('ZW');
  });

  it('is for riders only, and refuses nonsense coordinates', async () => {
    const shop = await ctx.signIn('+263771500006', 'shop');
    expect((await detect(shop.token, LUSAKA)).statusCode).toBe(403);
    const rider = await ctx.signIn('+263771500007', 'rider');
    expect((await detect(rider.token, { lat: 'north', lng: 28 })).statusCode).toBe(400);
    expect((await detect(rider.token, { lat: 120, lng: 28 })).statusCode).toBe(400);
    expect((await detect('bad', LUSAKA)).statusCode).toBe(401);
  });
});

describe('assigned parcel with no events yet', () => {
  it('still blocks leaving the country', async () => {
    const rider = await ctx.signIn('+263771500020', 'rider');
    const shop = await ctx.signIn('+263771500021', 'shop');
    await ctx.pool.query(
      `INSERT INTO parcels (shop_id, rider_id, suburb, level, value_cents, contents, recipient_phone, price_cents, track_token, country)
       VALUES ($1, $2, 'Avenues', 'standard', 1000, 'x', '+263771234567', 100, 'detect-noevents', 'ZW')`,
      [shop.id, rider.id],
    );
    expect((await detect(rider.token, LUSAKA)).statusCode).toBe(409);
  });
});
