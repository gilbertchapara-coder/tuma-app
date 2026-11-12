import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PHONE, auth, book, createCtx, makeRider, uploadPhoto, type TestCtx } from './helpers';

const NOW_HOUR = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
const rain = {
  async forecast() {
    return [{ at: NOW_HOUR, mmPerHour: 6, chancePercent: 90 }];
  },
};

let ctx: TestCtx;
let shop: { token: string; id: string };

beforeAll(async () => {
  ctx = await createCtx({ weatherProvider: rain });
  shop = await ctx.signIn('+263771200001', 'shop');
});
afterAll(async () => ctx.close());

const bundleOf = async (parcelId: string): Promise<string> =>
  (await ctx.pool.query('SELECT bundle_id FROM bundle_parcels WHERE parcel_id = $1', [parcelId])).rows[0].bundle_id;
const offer = (jobId: string, token: string, askCents: number) =>
  ctx.app.inject({ method: 'POST', url: `/board/${jobId}/offers`, headers: auth(token), payload: { askCents } });
const stateOf = async (token: string, job: string): Promise<string | undefined> => {
  const board = (await ctx.app.inject({ method: 'GET', url: '/board', headers: auth(token) })).json();
  return board.jobs.find((j: { id: string }) => j.id === job)?.state;
};
const rawBooking = (over: Record<string, unknown>) => ({
  suburb: 'Avenues',
  level: 'express',
  valueCents: 1000,
  contents: 'x',
  recipientPhone: '+263771234567',
  recipientPhoneConfirm: '+263771234567',
  ...over,
});

describe('weather', () => {
  it('reports rain and quotes the extra as its own line', async () => {
    const w = (await ctx.app.inject({ method: 'GET', url: '/weather' })).json();
    expect(w.weather).toBe('heavy_rain');
    const q = (await ctx.app.inject({ method: 'GET', url: '/quote?suburb=Mbare&level=standard' })).json();
    expect(q).toMatchObject({ baseCents: 130, surchargeCents: 25, totalCents: 155 });
    const night = (await ctx.app.inject({ method: 'GET', url: '/quote?suburb=Mbare&level=overnight' })).json();
    expect(night.surchargeCents).toBe(0);
    expect((await ctx.app.inject({ method: 'GET', url: '/quote?suburb=Nowhere&level=standard' })).statusCode).toBe(400);
  });
  it('locks the weather extra into the booked price', async () => {
    const b = await book(ctx, shop.token, { suburb: 'Mbare', level: 'standard' });
    expect(b.priceCents).toBe(155);
    expect((await ctx.pool.query('SELECT weather_cents FROM parcels WHERE id = $1', [b.parcelId])).rows[0].weather_cents).toBe(25);
  });
});

describe('customers and pickup requests', () => {
  it('a customer signs up, books a pickup from another suburb and pays cash', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: '+263771200050' } });
    expect(res.statusCode).toBe(200);
    const cust = await ctx.signIn('+263771200051', 'shop');
    const b = await ctx.app.inject({
      method: 'POST', url: '/parcels', headers: auth(cust.token),
      payload: rawBooking({ suburb: 'Avenues', pickup: { suburb: 'Mbare', note: 'Gate 3, ask for Tendai', lat: -17.85, lng: 31.03 }, payMethod: 'mobile_money' }),
    });
    expect(b.statusCode).toBe(201);
    expect(b.json().payMethod).toBe('mobile_money');
    const row = (await ctx.pool.query('SELECT pickup_suburb, pickup_note, pay_method FROM parcels WHERE id = $1', [b.json().parcelId])).rows[0];
    expect(row).toEqual({ pickup_suburb: 'Mbare', pickup_note: 'Gate 3, ask for Tendai', pay_method: 'mobile_money' });
  });
  it('the rider needs the sender pickup code to confirm pickup, and 3 wrong tries lock it', async () => {
    const c = await ctx.signIn('+263771200053', 'shop');
    const photo = await uploadPhoto(ctx, c.token);
    const b = (await ctx.app.inject({
      method: 'POST', url: '/parcels', headers: auth(c.token),
      payload: rawBooking({ pickup: { suburb: 'Mbare' }, sealedPhotoUrl: photo }),
    })).json();
    expect(b.pickupCode).toMatch(/^[0-9]{6}$/);
    expect(JSON.stringify((await ctx.app.inject({ method: 'GET', url: `/parcels/${b.parcelId}`, headers: auth(c.token) })).json())).not.toContain(b.pickupCode);
    const rider = await makeRider(ctx, '+263773200060', { topupCents: 500 });
    expect((await ctx.app.inject({ method: 'POST', url: `/bundles/${await bundleOf(b.parcelId)}/accept`, headers: auth(rider.token) })).statusCode).toBe(200);
    const pick = async (pickupCode?: string) =>
      ctx.app.inject({ method: 'POST', url: `/parcels/${b.parcelId}/events`, headers: auth(rider.token),
        payload: { type: 'pickup_confirmed', photoUrl: await uploadPhoto(ctx, rider.token), ...(pickupCode ? { pickupCode } : {}) } });
    expect((await pick()).statusCode).toBe(400);
    const wrong = b.pickupCode === '000000' ? '111111' : '000000';
    expect((await pick(wrong)).json()).toMatchObject({ error: 'invalid_code', attemptsLeft: 2 });
    expect((await pick(b.pickupCode)).statusCode).toBe(201);
    const d = (await ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(c.token),
      payload: rawBooking({ pickup: { suburb: 'Mbare' }, sealedPhotoUrl: await uploadPhoto(ctx, c.token) }) })).json();
    const r2 = await makeRider(ctx, '+263773200061', { topupCents: 500 });
    await ctx.app.inject({ method: 'POST', url: `/bundles/${await bundleOf(d.parcelId)}/accept`, headers: auth(r2.token) });
    const pick2 = async (code: string) =>
      ctx.app.inject({ method: 'POST', url: `/parcels/${d.parcelId}/events`, headers: auth(r2.token),
        payload: { type: 'pickup_confirmed', photoUrl: await uploadPhoto(ctx, r2.token), pickupCode: code } });
    const bad = d.pickupCode === '000000' ? '111111' : '000000';
    await pick2(bad); await pick2(bad);
    expect((await pick2(bad)).statusCode).toBe(423);
    expect((await pick2(d.pickupCode)).statusCode).toBe(423);
  });
  it('a lost pickup code can be re-issued, the old one dies, and admin can unlock a lock', async () => {
    const c = await ctx.signIn('+263771200054', 'shop');
    const other = await ctx.signIn('+263771200055', 'shop');
    const b = (await ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(c.token),
      payload: rawBooking({ pickup: { suburb: 'Mbare' }, sealedPhotoUrl: await uploadPhoto(ctx, c.token) }) })).json();
    const reissue = (token: string) => ctx.app.inject({ method: 'POST', url: `/parcels/${b.parcelId}/pickup-code/reissue`, headers: auth(token) });
    expect((await reissue(other.token)).statusCode).toBe(404);
    const fresh = (await reissue(c.token)).json().pickupCode as string;
    expect(fresh).toMatch(/^[0-9]{6}$/);
    const list = (await ctx.app.inject({ method: 'GET', url: '/parcels', headers: auth(c.token) })).json();
    expect(list.parcels.find((p: { id: string }) => p.id === b.parcelId).pickupCodeOpen).toBe(true);
    const rider = await makeRider(ctx, '+263773200062', { topupCents: 500 });
    await ctx.app.inject({ method: 'POST', url: `/bundles/${await bundleOf(b.parcelId)}/accept`, headers: auth(rider.token) });
    const pick = async (pickupCode: string) => ctx.app.inject({ method: 'POST', url: `/parcels/${b.parcelId}/events`, headers: auth(rider.token),
      payload: { type: 'pickup_confirmed', photoUrl: await uploadPhoto(ctx, rider.token), pickupCode } });
    const bad = fresh === '000000' ? '111111' : '000000';
    await pick(bad); await pick(bad); await pick(bad);
    expect((await reissue(c.token)).statusCode).toBe(423);
    const admin = await ctx.signIn(ADMIN_PHONE, 'shop');
    expect((await ctx.app.inject({ method: 'POST', url: `/admin/parcels/${b.parcelId}/unlock`, headers: auth(c.token), payload: { which: 'pickup' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/admin/parcels/${b.parcelId}/unlock`, headers: auth(admin.token), payload: { which: 'pickup' } })).statusCode).toBe(200);
    expect((await pick(fresh)).statusCode).toBe(201);
    expect((await reissue(c.token)).statusCode).toBe(409);
  });
  it('adds a distance charge only when both pins are given', async () => {
    const c = await ctx.signIn('+263771200056', 'shop');
    const book2 = async (over: Record<string, unknown>) => (await ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(c.token),
      payload: rawBooking({ sealedPhotoUrl: await uploadPhoto(ctx, c.token), ...over }) })).json();
    const near = await book2({ pickup: { suburb: 'Mbare', lat: -17.8, lng: 31 }, dropoff: { lat: -17.81, lng: 31 } });
    expect(near.distanceCents).toBe(0);
    const far = await book2({ pickup: { suburb: 'Mbare', lat: -17.8, lng: 31 }, dropoff: { lat: -17.95, lng: 31 } });
    expect(far.distanceKm).toBeGreaterThan(16);
    expect(far.distanceCents).toBeGreaterThan(0);
    expect(far.priceCents - near.priceCents).toBe(far.distanceCents);
    const noPin = await book2({ pickup: { suburb: 'Mbare' }, dropoff: { lat: -17.95, lng: 31 } });
    expect(noPin.distanceCents).toBeUndefined();
  });
  it('rejects half a pin and unknown pickup suburbs', async () => {
    const c = await ctx.signIn('+263771200052', 'shop');
    const post = (pickup: unknown) => ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(c.token), payload: rawBooking({ pickup }) });
    expect((await post({ suburb: 'Mbare', lat: -17.8 })).statusCode).toBe(400);
    expect((await post({ suburb: 'Nowhere' })).statusCode).toBe(400);
  });
});

describe('booking dispatch rules', () => {
  it('allows First and Cheapest only for Express and needs a max price for Cheapest', async () => {
    const std = await ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(shop.token), payload: rawBooking({ level: 'standard', dispatch: 'first' }) });
    expect(std.statusCode).toBe(400);
    const noMax = await ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(shop.token), payload: rawBooking({ dispatch: 'cheapest' }) });
    expect(noMax.statusCode).toBe(400);
    const tooHigh = await ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(shop.token), payload: rawBooking({ dispatch: 'cheapest', maxPriceCents: 99999 }) });
    expect(tooHigh.statusCode).toBe(400);
  });
});

describe('direction board', () => {
  it('first come first served: the first offer wins, the fee is charged, a later rider gets taken', async () => {
    const r1 = await makeRider(ctx, '+263773200001', { topupCents: 500 });
    const r2 = await makeRider(ctx, '+263773200002', { topupCents: 500 });
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'first' });
    const job = await bundleOf(p.parcelId);
    const board = (await ctx.app.inject({ method: 'GET', url: '/board?run=north', headers: auth(r1.token) })).json();
    expect(board.jobs.find((j: { id: string }) => j.id === job)).toMatchObject({ state: 'open', mode: 'first' });
    expect(board.note).toMatch(/not a guarantee/);
    // the plain accept route refuses auctioned jobs
    expect((await ctx.app.inject({ method: 'POST', url: `/bundles/${job}/accept`, headers: auth(r1.token) })).statusCode).toBe(409);
    expect((await offer(job, r1.token, p.priceCents)).json()).toEqual({ state: 'won' });
    expect((await offer(job, r2.token, p.priceCents)).statusCode).toBe(409);
    const fee = await ctx.pool.query(`SELECT cents FROM ledger_entries WHERE rider_id = $1 AND type = 'fee'`, [r1.id]);
    expect(fee.rows).toEqual([{ cents: Math.round(p.priceCents * 0.2) }]);
    expect(await stateOf(r2.token, job)).toBeUndefined();
  });

  it('first mode refuses an ask that is not the fixed price', async () => {
    const r = await makeRider(ctx, '+263773200003', { topupCents: 500 });
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'first' });
    expect((await offer(await bundleOf(p.parcelId), r.token, 60)).statusCode).toBe(400);
  });

  it('cheapest: offers wait, the lowest ask wins on award, price becomes the ask, a cart place is not a win', async () => {
    const a = await makeRider(ctx, '+263773200004', { topupCents: 500 });
    const b = await makeRider(ctx, '+263773200005', { topupCents: 500 });
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'cheapest', maxPriceCents: 250 });
    const job = await bundleOf(p.parcelId);
    expect((await offer(job, a.token, 200)).json()).toEqual({ state: 'in_cart' });
    expect((await offer(job, b.token, 150)).json()).toEqual({ state: 'in_cart' });
    expect((await offer(job, a.token, 251)).statusCode).toBe(400);
    expect((await offer(job, a.token, 10)).statusCode).toBe(400);
    const seen = (await ctx.app.inject({ method: 'GET', url: `/board/${job}/offers`, headers: auth(shop.token) })).json();
    expect(seen.offers.map((o: { askCents: number }) => o.askCents)).toEqual([150, 200]);
    expect(JSON.stringify(seen)).not.toMatch(/\+263/);
    expect(await stateOf(a.token, job)).toBe('in_cart');
    expect((await ctx.app.inject({ method: 'POST', url: `/board/${job}/award`, headers: auth(shop.token) })).statusCode).toBe(200);
    expect((await ctx.pool.query('SELECT rider_id, price_cents FROM parcels WHERE id = $1', [p.parcelId])).rows[0]).toEqual({ rider_id: b.id, price_cents: 150 });
    expect(await stateOf(a.token, job)).toBe('taken');
    expect(await stateOf(b.token, job)).toBe('won');
  });

  it('cheapest: the shop meter raises or lowers the ceiling, but not below an offer already made', async () => {
    const r = await makeRider(ctx, '+263773200041', { topupCents: 500 });
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'cheapest', maxPriceCents: 250 });
    const job = await bundleOf(p.parcelId);
    const setMax = (token: string, maxPriceCents: number) =>
      ctx.app.inject({ method: 'POST', url: `/board/${job}/ceiling`, headers: auth(token), payload: { maxPriceCents } });
    expect((await setMax(shop.token, 300)).json()).toEqual({ ceilingCents: 300 });
    expect((await offer(job, r.token, 280)).statusCode).toBe(201);
    expect((await setMax(shop.token, 200)).statusCode).toBe(409);
    expect((await setMax(shop.token, 10)).statusCode).toBe(400);
    expect((await setMax(r.token, 300)).statusCode).toBe(403);
  });

  it('cheapest: a winner with no float is skipped and the next offer wins', async () => {
    const poor = await makeRider(ctx, '+263773200006', { topupCents: 0 });
    const rich = await makeRider(ctx, '+263773200007', { topupCents: 500 });
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'cheapest', maxPriceCents: 250 });
    const job = await bundleOf(p.parcelId);
    expect((await offer(job, rich.token, 220)).statusCode).toBe(201);
    // the poor rider's cheaper offer goes straight in, as if their float dropped after offering
    await ctx.pool.query('INSERT INTO bundle_offers (bundle_id, rider_id, ask_cents) VALUES ($1, $2, 100)', [job, poor.id]);
    await ctx.app.inject({ method: 'POST', url: `/board/${job}/award`, headers: auth(shop.token) });
    expect((await ctx.pool.query('SELECT rider_id, price_cents FROM parcels WHERE id = $1', [p.parcelId])).rows[0]).toEqual({ rider_id: rich.id, price_cents: 220 });
  });

  it('cheapest: an expired window awards on the next board read', async () => {
    const r = await makeRider(ctx, '+263773200008', { topupCents: 500 });
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'cheapest', maxPriceCents: 250 });
    const job = await bundleOf(p.parcelId);
    await offer(job, r.token, 180);
    await ctx.pool.query(`UPDATE bundles SET auction_ends_at = now() - interval '1 minute' WHERE id = $1`, [job]);
    expect(await stateOf(r.token, job)).toBe('won');
  });

  it('a rider can leave the cart; another shop cannot read or award', async () => {
    const r = await makeRider(ctx, '+263773200009', { topupCents: 500 });
    const other = await ctx.signIn('+263771200002', 'shop');
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'cheapest', maxPriceCents: 250 });
    const job = await bundleOf(p.parcelId);
    await offer(job, r.token, 200);
    expect((await ctx.app.inject({ method: 'GET', url: `/board/${job}/offers`, headers: auth(other.token) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: `/board/${job}/award`, headers: auth(other.token) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/board/${job}/offers`, headers: auth(r.token) })).json()).toEqual({ removed: 1 });
    expect((await ctx.app.inject({ method: 'POST', url: `/board/${job}/award`, headers: auth(shop.token) })).statusCode).toBe(409);
  });

  it('a rider over their cap cannot join the cart', async () => {
    const newbie = await makeRider(ctx, '+263773200010', { topupCents: 500 });
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'first', valueCents: 5_000_00 });
    expect((await offer(await bundleOf(p.parcelId), newbie.token, p.priceCents)).statusCode).toBe(403);
  });
});

describe('messenger', () => {
  it('lets the shop and the assigned rider talk, blocks phone numbers, strangers and floods', async () => {
    const r = await makeRider(ctx, '+263773200011', { topupCents: 500 });
    const stranger = await makeRider(ctx, '+263773200012', { topupCents: 500 });
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', dispatch: 'first' });
    const job = await bundleOf(p.parcelId);
    const url = `/parcels/${p.parcelId}/messages`;
    // before a rider is assigned only the shop is a member
    expect((await ctx.app.inject({ method: 'GET', url, headers: auth(r.token) })).statusCode).toBe(404);
    await offer(job, r.token, p.priceCents);
    const send = (token: string, body: string) => ctx.app.inject({ method: 'POST', url, headers: auth(token), payload: { body } });
    expect((await send(r.token, 'I am at the gate')).statusCode).toBe(201);
    expect((await send(shop.token, 'Coming down')).statusCode).toBe(201);
    expect((await send(shop.token, 'call me on 0771 234 567')).statusCode).toBe(400);
    expect((await send(shop.token, 'x'.repeat(501))).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url, headers: auth(stranger.token) })).statusCode).toBe(404);
    expect((await send(stranger.token, 'hi')).statusCode).toBe(404);
    const unread = (await ctx.app.inject({ method: 'GET', url: '/messages/unread', headers: auth(shop.token) })).json();
    expect(unread.unread).toEqual([{ parcelId: p.parcelId, count: 1 }]);
    const list = (await ctx.app.inject({ method: 'GET', url, headers: auth(shop.token) })).json();
    expect(list.messages.map((m: { body: string; mine: boolean }) => [m.body, m.mine])).toEqual([
      ['I am at the gate', false],
      ['Coming down', true],
    ]);
    const none = (await ctx.app.inject({ method: 'GET', url: '/messages/unread', headers: auth(shop.token) })).json();
    expect(none.unread).toEqual([]);
    const after = (await ctx.app.inject({ method: 'GET', url: `${url}?after=${list.messages[0].id}`, headers: auth(r.token) })).json();
    expect(after.messages).toHaveLength(1);
    await expect(ctx.pool.query('DELETE FROM messages')).rejects.toThrow(/append-only/);
    for (let i = 0; i < 20; i += 1) await send(r.token, `m${i}`);
    expect((await send(r.token, 'one too many')).statusCode).toBe(429);
  });
});
