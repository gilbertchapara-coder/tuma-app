import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, book, buildBundles, createCtx, makeRider, uploadPhoto, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createCtx({ platformBps: 2000 });
});
afterAll(async () => ctx.close());

const ZM_SETTINGS = {
  suburbs: { Kabulonga: { band: 'A', run: 'south' }, Woodlands: { band: 'A', run: 'south' } },
  prices: { A: [3000, 2000, 1500] },
  platformBps: 1000,
};
const zmBooking = (over: Record<string, unknown> = {}) => ({
  suburb: 'Kabulonga',
  level: 'standard',
  valueCents: 2000,
  contents: 'Phone case',
  recipientPhone: '+260971234567',
  recipientPhoneConfirm: '+260971234567',
  ...over,
});
const zwBooking = () => ({
  suburb: 'Avenues',
  level: 'standard',
  valueCents: 2000,
  contents: 'Phone case',
  recipientPhone: '+263771234567',
  recipientPhoneConfirm: '+263771234567',
});
const setZambia = async () =>
  ctx.app.inject({ method: 'PUT', url: '/admin/countries/ZM', headers: auth(await ctx.adminToken()), payload: ZM_SETTINGS });
const accept = (id: string, token: string) => ctx.app.inject({ method: 'POST', url: `/bundles/${id}/accept`, headers: auth(token) });

describe('country from the phone number', () => {
  it('a Zambian number gets a Zambian account; a Zimbabwean number a Zimbabwean one', async () => {
    const zm = await ctx.signIn('+260971000001', 'shop');
    const zw = await ctx.signIn('+263771000001', 'shop');
    const me = async (t: string) => (await ctx.app.inject({ method: 'GET', url: '/me', headers: auth(t) })).json();
    expect((await me(zm.token)).country).toMatchObject({ code: 'ZM', currency: 'ZMW', currencySymbol: 'K' });
    expect((await me(zw.token)).country).toMatchObject({ code: 'ZW', currency: 'USD' });
  });

  it('a number from a country Tuma does not serve cannot get a code', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: '+27821234567' } });
    expect(res.statusCode).toBe(400);
  });

  it('GET /countries is public and lists both countries', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/countries' });
    expect(res.statusCode).toBe(200);
    expect(res.json().countries.map((c: { code: string }) => c.code)).toEqual(['ZW', 'ZM']);
  });
});

describe('Zambia before and after the owner loads it', () => {
  it('refuses bookings until prices and suburbs are loaded, and invents nothing', async () => {
    const shop = await ctx.signIn('+260971000002', 'shop');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/parcels',
      headers: auth(shop.token),
      payload: zmBooking({ sealedPhotoUrl: await uploadPhoto(ctx, shop.token) }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('country_not_open');
  });

  it('only an admin can set country settings, and a band without a price is refused', async () => {
    const shop = await ctx.signIn('+260971000003', 'shop');
    expect((await ctx.app.inject({ method: 'PUT', url: '/admin/countries/ZM', headers: auth(shop.token), payload: ZM_SETTINGS })).statusCode).toBe(403);
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: '/admin/countries/ZM',
      headers: auth(await ctx.adminToken()),
      payload: { suburbs: { Kabulonga: { band: 'Z', run: 'south' } } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('working in Zambia', () => {
  it('prices in kwacha, holds a rider to their country, lets them switch and work, and takes the Zambian percentage', async () => {
    expect((await setZambia()).statusCode).toBe(200);
    const shop = await ctx.signIn('+260971000010', 'shop');
    const p = await book(ctx, shop.token, zmBooking());
    expect(p).toMatchObject({ priceCents: 2000, country: 'ZM', currency: 'ZMW', currencySymbol: 'K' });
    const built = await buildBundles(ctx);
    const bundle = built.find((b) => b.parcelIds.includes(p.parcelId));
    expect(bundle).toBeDefined();

    // A Zimbabwe rider cannot see or take the Zambian bundle.
    const rider = await makeRider(ctx, '+263771000020', { topupCents: 5000 });
    const open = (await ctx.app.inject({ method: 'GET', url: '/bundles/open', headers: auth(rider.token) })).json();
    expect(open.bundles.some((b: { id: string }) => b.id === bundle!.id)).toBe(false);
    const refused = await accept(bundle!.id, rider.token);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('wrong_country');

    // The rider goes to Zambia: switch, top up Zambian float, work.
    const sw = await ctx.app.inject({ method: 'POST', url: '/me/country', headers: auth(rider.token), payload: { country: 'ZM' } });
    expect(sw.statusCode).toBe(200);
    // Float and deposit are kept per country, so a rider with only Zimbabwe money cannot take a Zambian job yet.
    expect((await accept(bundle!.id, rider.token)).statusCode).toBe(403);
    const admin = await ctx.adminToken();
    await ctx.app.inject({ method: 'POST', url: `/riders/${rider.id}/topup`, headers: auth(admin), payload: { cents: 3000 } });
    await ctx.app.inject({ method: 'POST', url: `/riders/${rider.id}/deposit`, headers: auth(admin), payload: { cents: 2000 } });
    expect((await accept(bundle!.id, rider.token)).statusCode).toBe(200);
    const fee = await ctx.pool.query(`SELECT cents, country FROM ledger_entries WHERE rider_id = $1 AND type = 'fee'`, [rider.id]);
    expect(fee.rows).toEqual([{ cents: 200, country: 'ZM' }]); // 10% of K20.00
    const me = (await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth(rider.token) })).json();
    expect(me).toMatchObject({ country: 'ZM', balanceCents: 800 });

    // While the Zambian parcel is on the road the rider cannot leave Zambia.
    expect((await ctx.app.inject({ method: 'POST', url: '/me/country', headers: auth(rider.token), payload: { country: 'ZW' } })).statusCode).toBe(409);
    await ctx.pool.query(`INSERT INTO custody_events (parcel_id, type, at, actor) VALUES ($1, 'delivered', now(), 'rider')`, [p.parcelId]);

    // Back in Zimbabwe the Zimbabwe float is untouched.
    await ctx.app.inject({ method: 'POST', url: '/me/country', headers: auth(rider.token), payload: { country: 'ZW' } });
    const home = (await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth(rider.token) })).json();
    expect(home).toMatchObject({ country: 'ZW', balanceCents: 5000 });
  });

  it('refuses a switch to a country that does not exist', async () => {
    const r = await makeRider(ctx, '+263771000021');
    const res = await ctx.app.inject({ method: 'POST', url: '/me/country', headers: auth(r.token), payload: { country: 'XX' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('Tuma percentage', () => {
  it('takes nothing while no percentage is set', async () => {
    const quiet = await createCtx({ platformBps: null });
    try {
      const shop = await quiet.signIn('+263771000030', 'shop');
      const p = await book(quiet, shop.token, {});
      const bundle = (await buildBundles(quiet)).find((b) => b.parcelIds.includes(p.parcelId));
      const rider = await makeRider(quiet, '+263771000031', { topupCents: 500 });
      expect((await quiet.app.inject({ method: 'POST', url: `/bundles/${bundle!.id}/accept`, headers: auth(rider.token) })).statusCode).toBe(200);
      const fees = await quiet.pool.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE rider_id = $1 AND type = 'fee'`, [rider.id]);
      expect(fees.rows[0].n).toBe(0);
    } finally {
      await quiet.close();
    }
  });

  it('rejects a percentage above 100%', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/admin/countries/ZW',
      headers: auth(await ctx.adminToken()),
      payload: { platformBps: 10001 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('guards from review', () => {
  it('asks for confirmation above 30% and caps prices', async () => {
    const admin = await ctx.adminToken();
    const put = (payload: object) => ctx.app.inject({ method: 'PUT', url: '/admin/countries/ZW', headers: auth(admin), payload });
    expect((await put({ platformBps: 3500 })).statusCode).toBe(400);
    expect((await put({ platformBps: 3500, confirmHighPercentage: true })).statusCode).toBe(200);
    expect((await put({ platformBps: 2000 })).statusCode).toBe(200);
    expect((await put({ prices: { A: [99_000_000, 1, 1] } })).statusCode).toBe(400);
  });

  it('refuses a price change that would leave an open country without a price for a band', async () => {
    const admin = await ctx.adminToken();
    const res = await ctx.app.inject({ method: 'PUT', url: '/admin/countries/ZW', headers: auth(admin), payload: { prices: { Z: [100, 100, 100] } } });
    expect(res.statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/quote?suburb=Avenues&level=standard', headers: auth(admin) })).statusCode).toBe(200);
  });

  it('quote refuses an unknown country', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/quote?suburb=Avenues&level=standard&country=XX' })).statusCode).toBe(400);
  });

  it('a rider with a parcel on the road cannot change country', async () => {
    const shop = await ctx.signIn('+263771000060', 'shop');
    const p = await book(ctx, shop.token, zwBooking());
    const built = await buildBundles(ctx);
    const bundle = built.find((b) => b.parcelIds.includes(p.parcelId));
    const rider = await makeRider(ctx, '+263771000061', { topupCents: 5000 });
    expect((await accept(bundle!.id, rider.token)).statusCode).toBe(200);
    const sw = await ctx.app.inject({ method: 'POST', url: '/me/country', headers: auth(rider.token), payload: { country: 'ZM' } });
    expect(sw.statusCode).toBe(409);
    expect(sw.json().error).toBe('parcels_in_progress');
  });
});

describe('earnings today', () => {
  it('starts at nothing for a rider with no deliveries', async () => {
    const rider = await makeRider(ctx, '+263771000040');
    const res = await ctx.app.inject({ method: 'GET', url: '/riders/me/earnings', headers: auth(rider.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ country: 'ZW', earnedCents: 0, parcelsDelivered: 0, runs: 0, currency: 'USD' });
  });
});

describe('locked codes for support', () => {
  it('finds a parcel by its reference and refuses a bad one', async () => {
    const shop = await ctx.signIn('+263771000050', 'shop');
    const p = await book(ctx, shop.token, {});
    const ref = `TUM-${p.parcelId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const admin = await ctx.adminToken();
    const found = await ctx.app.inject({ method: 'GET', url: `/admin/parcels/lookup?ref=${ref}`, headers: auth(admin) });
    expect(found.statusCode).toBe(200);
    expect(found.json().parcels[0]).toMatchObject({ id: p.parcelId, reference: ref, country: 'ZW' });
    expect(found.json().parcels[0].shopPhone).toMatch(/^\*\*\*\d{3}$/);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/parcels/lookup?ref=TUM-12', headers: auth(admin) })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/parcels/lookup?ref=TUM-FFFFFFFF', headers: auth(admin) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/admin/parcels/lookup?ref=${ref}`, headers: auth(shop.token) })).statusCode).toBe(403);
  });

  it('lists only parcels whose code is locked', async () => {
    const shop = await ctx.signIn('+263771000051', 'shop');
    const p = await book(ctx, shop.token, {});
    const admin = await ctx.adminToken();
    const none = (await ctx.app.inject({ method: 'GET', url: '/admin/codes/locked', headers: auth(admin) })).json();
    expect(none.parcels.some((x: { id: string }) => x.id === p.parcelId)).toBe(false);
    await ctx.pool.query('UPDATE delivery_codes SET locked = true WHERE parcel_id = $1', [p.parcelId]);
    const some = (await ctx.app.inject({ method: 'GET', url: '/admin/codes/locked', headers: auth(admin) })).json();
    expect(some.parcels.find((x: { id: string }) => x.id === p.parcelId).codes.delivery).toEqual({ locked: true, used: false });
  });
});
