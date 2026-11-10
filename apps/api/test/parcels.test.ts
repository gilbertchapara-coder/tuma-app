import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, book, bookingBody, createCtx, makeRider, buildBundles, type TestCtx } from './helpers';

let ctx: TestCtx;
let shop: { token: string; id: string };

beforeAll(async () => {
  ctx = await createCtx();
  shop = await ctx.signIn('+263771000001', 'shop');
});
afterAll(async () => ctx.close());

const post = (payload: unknown, token = shop.token) =>
  ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(token), payload: payload as object });

const bundleOf = async (parcelId: string): Promise<string> =>
  (await ctx.pool.query('SELECT bundle_id FROM bundle_parcels WHERE parcel_id = $1', [parcelId])).rows[0].bundle_id;

describe('POST /parcels validation', () => {
  it('rejects an unknown suburb with a clear 400', async () => {
    const res = await post(bookingBody({ suburb: 'Narnia' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/suburb/i);
    expect(res.body).not.toMatch(/at .*\.ts/); // no stack traces
  });

  it.each([0, -5, 1.5, '20', null])('rejects valueCents %s', async (valueCents) => {
    const res = await post(bookingBody({ valueCents }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects mismatched recipient phones', async () => {
    const res = await post(bookingBody({ recipientPhoneConfirm: '+263771234568' }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown level, empty contents, unknown keys and a non-https photo', async () => {
    expect((await post(bookingBody({ level: 'teleport' }))).statusCode).toBe(400);
    expect((await post(bookingBody({ contents: '' }))).statusCode).toBe(400);
    expect((await post(bookingBody({ role: 'admin' }))).statusCode).toBe(400);
    expect((await post(bookingBody({ sealedPhotoUrl: 'javascript:alert(1)' }))).statusCode).toBe(400);
  });

  it('accepts suburb in any case and stores the canonical name', async () => {
    const res = await post(bookingBody({ suburb: '  milton   park ' }));
    expect(res.statusCode).toBe(201);
    const row = await ctx.pool.query('SELECT suburb FROM parcels WHERE id = $1', [res.json().parcelId]);
    expect(row.rows[0].suburb).toBe('Milton Park');
  });
});

describe('POST /parcels booking', () => {
  it('returns id, price from core and an unguessable tracking url', async () => {
    const res = await post(bookingBody({ suburb: 'Avenues', level: 'standard' }));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['parcelId', 'priceCents', 'trackingUrl']);
    expect(body.priceCents).toBe(120);
    const token = body.trackingUrl.replace('https://tuma.test/track/', '');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it('appends booked then sealed custody events and issues the delivery code to the recipient', async () => {
    const p = await book(ctx, shop.token, { recipientPhone: '+263772000111', recipientPhoneConfirm: '+263772000111' });
    const ev = await ctx.pool.query('SELECT type, actor, photo_url FROM custody_events WHERE parcel_id = $1 ORDER BY id', [
      p.parcelId,
    ]);
    expect(ev.rows.map((r) => r.type)).toEqual(['booked', 'sealed']);
    expect(ev.rows[1].photo_url).toBe('https://photos.test/sealed.jpg');
    expect(ctx.notifier.codes.get('+263772000111')).toMatch(/^[0-9]{6}$/);
  });

  it('creates a one-parcel express bundle for express parcels', async () => {
    const p = await book(ctx, shop.token, { level: 'express', suburb: 'Workington' });
    const rows = await ctx.pool.query(
      `SELECT b.level, b.run, b.status FROM bundles b JOIN bundle_parcels bp ON bp.bundle_id = b.id WHERE bp.parcel_id = $1`,
      [p.parcelId],
    );
    expect(rows.rows).toEqual([{ level: 'express', run: 'southwest', status: 'open' }]);
    const built = await buildBundles(ctx);
    expect(built.flatMap((b) => b.parcelIds)).not.toContain(p.parcelId);
  });

  it('requires a shop token', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/parcels', payload: bookingBody() })).statusCode).toBe(401);
    const rider = await makeRider(ctx, '+263773000001');
    expect((await post(bookingBody(), rider.token)).statusCode).toBe(403);
  });
});

describe('shop isolation', () => {
  it("a shop cannot read another shop's parcel", async () => {
    const other = await ctx.signIn('+263771000002', 'shop');
    const p = await book(ctx, shop.token);
    const mine = await ctx.app.inject({ method: 'GET', url: `/parcels/${p.parcelId}`, headers: auth(shop.token) });
    expect(mine.statusCode).toBe(200);
    expect(mine.body).not.toMatch(/"hash"|"salt"|delivery.?code/i);
    const theirs = await ctx.app.inject({ method: 'GET', url: `/parcels/${p.parcelId}`, headers: auth(other.token) });
    expect(theirs.statusCode).toBe(404);
    const list = await ctx.app.inject({ method: 'GET', url: '/parcels', headers: auth(other.token) });
    expect(list.json().parcels).toEqual([]);
    const ev = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/events`,
      headers: auth(other.token),
      payload: { type: 'cancelled' },
    });
    expect(ev.statusCode).toBe(404);
  });
});

describe('custody events', () => {
  it('a rider cannot confirm pickup of a parcel they did not accept', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Mbare' });
    const stranger = await makeRider(ctx, '+263773000002', { topupCents: 1000 });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/events`,
      headers: auth(stranger.token),
      payload: { type: 'pickup_confirmed', photoUrl: 'https://photos.test/pickup.jpg' },
    });
    expect(res.statusCode).toBe(403);
    const ev = await ctx.pool.query('SELECT count(*)::int AS n FROM custody_events WHERE parcel_id = $1', [p.parcelId]);
    expect(ev.rows[0].n).toBe(2);
  });

  it('the accepting rider can confirm pickup; a shop cannot record rider events', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Mbare', level: 'express' });
    const rider = await makeRider(ctx, '+263773000003', { topupCents: 1000 });
    const acc = await ctx.app.inject({
      method: 'POST',
      url: `/bundles/${await bundleOf(p.parcelId)}/accept`,
      headers: auth(rider.token),
    });
    expect(acc.statusCode).toBe(200);
    const asShop = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/events`,
      headers: auth(shop.token),
      payload: { type: 'pickup_confirmed' },
    });
    expect(asShop.statusCode).toBe(403);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/events`,
      headers: auth(rider.token),
      payload: { type: 'pickup_confirmed' },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/events`,
      headers: auth(rider.token),
      payload: { type: 'delivered' },
    });
    expect(bad.statusCode).toBe(403); // delivery only through the code
  });

  it('a parcel booked without a sealed photo cannot be accepted or picked up', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Mbare', level: 'express', sealedPhotoUrl: undefined });
    const rider = await makeRider(ctx, '+263773000004', { topupCents: 1000 });
    const acc = await ctx.app.inject({
      method: 'POST',
      url: `/bundles/${await bundleOf(p.parcelId)}/accept`,
      headers: auth(rider.token),
    });
    expect(acc.statusCode).toBe(409);
    const early = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/events`,
      headers: auth(rider.token),
      payload: { type: 'pickup_confirmed' },
    });
    expect(early.statusCode).toBe(403);
    // sealing without a photo is refused too
    const noPhoto = await ctx.app.inject({
      method: 'POST',
      url: `/parcels/${p.parcelId}/events`,
      headers: auth(shop.token),
      payload: { type: 'sealed' },
    });
    expect(noPhoto.statusCode).toBe(400);
  });
});

describe('GET /track/:token', () => {
  it('exposes only status, stage, suburb and rider first name/tier; never phone, code, value or address', async () => {
    const p = await book(ctx, shop.token, {
      suburb: 'Avondale',
      valueCents: 2999,
      contents: 'SECRET-CONTENTS',
      recipientPhone: '+263774555123',
      recipientPhoneConfirm: '+263774555123',
    });
    const token = p.trackingUrl.split('/track/')[1];
    const res = await ctx.app.inject({ method: 'GET', url: `/track/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'in_progress', stage: 'sealed', suburb: 'Avondale', rider: null });
    expect(Object.keys(body).sort()).toEqual(['events', 'phoneLast3', 'rider', 'run', 'stage', 'status', 'suburb']);
    expect(body.phoneLast3).toBe('123');
    const text = res.body;
    const code = ctx.notifier.codes.get('+263774555123') as string;
    for (const leak of ['+263774555123', '555123', '774555', code, '2999', 'SECRET-CONTENTS', p.parcelId, shop.id]) {
      expect(text).not.toContain(leak);
    }
  });

  it('shows the rider first name and tier once accepted', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express' });
    const rider = await makeRider(ctx, '+263773000005', { topupCents: 1000 });
    await ctx.pool.query('UPDATE users SET first_name = $2 WHERE id = $1', [rider.id, 'Tendai']);
    await ctx.app.inject({
      method: 'POST',
      url: `/bundles/${await bundleOf(p.parcelId)}/accept`,
      headers: auth(rider.token),
    });
    const res = await ctx.app.inject({ method: 'GET', url: `/track/${p.trackingUrl.split('/track/')[1]}` });
    expect(res.json().rider).toEqual({ firstName: 'Tendai', tier: 'new' });
  });

  it('404s for unknown or malformed tokens without detail', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/track/nope' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/track/${'A'.repeat(43)}` })).statusCode).toBe(404);
  });
});
