import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFlagJob } from '../src/jobs/flagJob';
import { auth, book, createCtx, makeRider, type TestCtx, uploadPhoto } from './helpers';

let ctx: TestCtx;
let shop: { token: string; id: string };
let seq = 0;
const nextPhone = (prefix: string) => `+26377${prefix}${String(200000 + seq++)}`;

beforeAll(async () => {
  ctx = await createCtx();
  shop = await ctx.signIn('+263771800001', 'shop');
});
afterAll(async () => ctx.close());

const bundleOf = async (parcelId: string): Promise<string> =>
  (await ctx.pool.query('SELECT bundle_id FROM bundle_parcels WHERE parcel_id = $1', [parcelId])).rows[0].bundle_id;
const accept = (bundleId: string, token: string) =>
  ctx.app.inject({ method: 'POST', url: `/bundles/${bundleId}/accept`, headers: auth(token) });
const event = (parcelId: string, token: string, type: string, photoUrl?: string) =>
  ctx.app.inject({ method: 'POST', url: `/parcels/${parcelId}/events`, headers: auth(token), payload: { type, photoUrl } });
const lost = (parcelId: string, token: string) =>
  ctx.app.inject({ method: 'POST', url: `/parcels/${parcelId}/report-lost`, headers: auth(token), payload: {} });
const lastEvent = async (parcelId: string) =>
  (await ctx.pool.query('SELECT type FROM custody_events WHERE parcel_id=$1 ORDER BY id DESC LIMIT 1', [parcelId])).rows[0].type as string;
const lossPaid = async (riderId: string) =>
  (await ctx.pool.query(`SELECT COALESCE(sum(cents),0)::int n FROM ledger_entries WHERE rider_id=$1 AND type='loss_payout'`, [riderId])).rows[0].n as number;
const riderStatus = async (riderId: string) =>
  (await ctx.pool.query('SELECT status FROM riders WHERE user_id=$1', [riderId])).rows[0].status as string;

async function accepted(opts: { valueCents?: number; topupCents?: number; depositCents?: number; suburb?: string } = {}) {
  const phone = nextPhone('5');
  const p = await book(ctx, shop.token, {
    level: 'express',
    suburb: opts.suburb ?? 'Avenues',
    valueCents: opts.valueCents ?? 1500,
    recipientPhone: phone,
    recipientPhoneConfirm: phone,
  });
  const rider = await makeRider(ctx, nextPhone('6'), { topupCents: opts.topupCents ?? 500, depositCents: opts.depositCents ?? 2000 });
  expect((await accept(await bundleOf(p.parcelId), rider.token)).statusCode).toBe(200);
  return { p, rider, phone };
}
async function pickedUp(opts: Parameters<typeof accepted>[0] = {}) {
  const a = await accepted(opts);
  expect((await event(a.p.parcelId, a.rider.token, 'pickup_confirmed', await uploadPhoto(ctx, a.rider.token))).statusCode).toBe(201);
  return a;
}

describe('POST /parcels/:id/report-lost', () => {
  it('lost after pickup names the rider and pays from the deposit first', async () => {
    const { p, rider } = await pickedUp();
    const res = await lost(p.parcelId, rider.token);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ liable: 'rider', payoutCents: 1500 });
    expect(await lastEvent(p.parcelId)).toBe('reported_lost');
    const pots = await ctx.pool.query(`SELECT pot, cents FROM ledger_entries WHERE rider_id=$1 AND type='loss_payout'`, [rider.id]);
    expect(pots.rows).toEqual([{ pot: 'deposit', cents: 1500 }]);
    expect(await riderStatus(rider.id)).toBe('active');
  });

  it('lost before pickup names the shop and draws nothing from the rider', async () => {
    const { p, rider } = await accepted();
    const res = await lost(p.parcelId, shop.token);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ liable: 'shop', payoutCents: 0 });
    expect(await lastEvent(p.parcelId)).toBe('reported_lost');
    expect(await lossPaid(rider.id)).toBe(0);
    expect(await riderStatus(rider.id)).toBe('active');
  });

  it('a loss larger than the deposit pays what exists and removes the rider, who then cannot accept', async () => {
    const { p, rider } = await pickedUp({ valueCents: 3000, topupCents: 100 });
    const res = await lost(p.parcelId, rider.token);
    expect(res.statusCode).toBe(201);
    const { liable, payoutCents } = res.json();
    expect(liable).toBe('rider');
    expect(payoutCents).toBeGreaterThan(2000);
    expect(payoutCents).toBeLessThan(3000);
    const me = (await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth(rider.token) })).json();
    expect(me.depositCents).toBe(0);
    expect(me.balanceCents).toBe(0);
    expect(await riderStatus(rider.id)).toBe('removed');
    const next = await book(ctx, shop.token, { level: 'express' });
    const acc = await accept(await bundleOf(next.parcelId), rider.token);
    expect(acc.statusCode).toBe(403);
  });

  it('two parallel reports pay once and return the same result', async () => {
    const { p, rider } = await pickedUp();
    const [a, b] = await Promise.all([lost(p.parcelId, rider.token), lost(p.parcelId, rider.token)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json()).toEqual({ liable: 'rider', payoutCents: 1500 });
    expect(b.json()).toEqual({ liable: 'rider', payoutCents: 1500 });
    expect(await lossPaid(rider.id)).toBe(1500);
    const n = (await ctx.pool.query(`SELECT count(*)::int n FROM custody_events WHERE parcel_id=$1 AND type='reported_lost'`, [p.parcelId])).rows[0].n;
    expect(n).toBe(1);
  });

  it('a repeat report returns the first result without paying again', async () => {
    const { p, rider } = await pickedUp();
    const first = await lost(p.parcelId, rider.token);
    const again = await lost(p.parcelId, rider.token);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await lossPaid(rider.id)).toBe(1500);
  });

  it('a shop claim after pickup opens a claim only: no event, no payout; admin resolves it', async () => {
    const { p, rider } = await pickedUp();
    const res = await lost(p.parcelId, shop.token);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'open' });
    expect((await lost(p.parcelId, shop.token)).statusCode).toBe(202);
    expect(await lastEvent(p.parcelId)).toBe('pickup_confirmed');
    expect(await lossPaid(rider.id)).toBe(0);

    const admin = await ctx.adminToken();
    const list = await ctx.app.inject({ method: 'GET', url: '/claims?status=open', headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    const mine = list.json().claims.filter((c: { parcelId: string }) => c.parcelId === p.parcelId);
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toMatch(/\+263/);
    expect((await ctx.app.inject({ method: 'GET', url: '/claims?status=open', headers: auth(shop.token) })).statusCode).toBe(403);

    const resolved = await lost(p.parcelId, admin);
    expect(resolved.statusCode).toBe(201);
    expect(resolved.json()).toEqual({ liable: 'rider', payoutCents: 1500 });
    expect(await lossPaid(rider.id)).toBe(1500);
    const after = await ctx.app.inject({ method: 'GET', url: '/claims?status=open', headers: auth(admin) });
    expect(after.json().claims.filter((c: { parcelId: string }) => c.parcelId === p.parcelId)).toHaveLength(0);
  });

  it('other shop gets 404, other rider 403, delivered parcel 409', async () => {
    const { p } = await pickedUp();
    const other = await ctx.signIn(nextPhone('3'), 'shop');
    expect((await lost(p.parcelId, other.token)).statusCode).toBe(404);
    const rider2 = await makeRider(ctx, nextPhone('6'), { topupCents: 100 });
    expect((await lost(p.parcelId, rider2.token)).statusCode).toBe(403);
    expect((await lost('00000000-0000-4000-8000-000000000000', rider2.token)).statusCode).toBe(404);
  });

  it('the generic events route no longer records reported_lost (it would skip the payout)', async () => {
    const { p, rider } = await pickedUp();
    expect((await event(p.parcelId, rider.token, 'reported_lost')).statusCode).toBe(403);
  });
});


describe('claim dismissal and auto-close', () => {
  it('admin dismisses an open claim: no payout, no event; only once; shop cannot', async () => {
    const { p, rider } = await pickedUp();
    expect((await lost(p.parcelId, shop.token)).statusCode).toBe(202);
    const admin = await ctx.adminToken();
    const id = (await ctx.pool.query('SELECT id FROM claims WHERE parcel_id=$1', [p.parcelId])).rows[0].id as string;
    const dismiss = (token: string) => ctx.app.inject({ method: 'POST', url: `/claims/${id}/dismiss`, headers: auth(token) });
    expect((await dismiss(shop.token)).statusCode).toBe(403);
    const res = await dismiss(admin);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'dismissed' });
    expect(await lastEvent(p.parcelId)).toBe('pickup_confirmed');
    expect(await lossPaid(rider.id)).toBe(0);
    expect((await dismiss(admin)).statusCode).toBe(409);
    const open = await ctx.app.inject({ method: 'GET', url: '/claims?status=open', headers: auth(admin) });
    expect(open.json().claims.filter((c: { parcelId: string }) => c.parcelId === p.parcelId)).toHaveLength(0);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/claims/00000000-0000-4000-8000-000000000000/dismiss', headers: auth(admin) })).statusCode,
    ).toBe(404);
    // The shop cannot reopen a dismissed claim.
    expect((await lost(p.parcelId, shop.token)).statusCode).toBe(409);
  });

  it('an open claim closes itself when the parcel is delivered', async () => {
    const { p, rider, phone } = await pickedUp();
    expect((await lost(p.parcelId, shop.token)).statusCode).toBe(202);
    const code = ctx.notifier.codes.get(phone) as string;
    const d = await ctx.app.inject({ method: 'POST', url: `/parcels/${p.parcelId}/deliver`, headers: auth(rider.token), payload: { code } });
    expect(d.statusCode).toBe(200);
    const row = (await ctx.pool.query('SELECT status FROM claims WHERE parcel_id=$1', [p.parcelId])).rows[0];
    expect(row.status).toBe('closed');
    expect(await lossPaid(rider.id)).toBe(0);
  });
});

const insertPing = (riderId: string, lat: number, lng: number, at: Date) =>
  ctx.pool.query('INSERT INTO gps_pings (rider_id, lat, lng, at) VALUES ($1, $2, $3, $4)', [riderId, lat, lng, at]);
const pickedAt = async (parcelId: string): Promise<Date> =>
  (await ctx.pool.query(`SELECT at FROM custody_events WHERE parcel_id=$1 AND type='pickup_confirmed'`, [parcelId])).rows[0].at as Date;
const flagKinds = async (parcelId: string) =>
  (await ctx.pool.query('SELECT kind FROM flags WHERE parcel_id=$1 ORDER BY id', [parcelId])).rows.map((r) => r.kind as string);
const WATERFALLS = { lat: -17.9, lng: 31.01 };
const MBARE = { lat: -17.86, lng: 31.045 };
const AVONDALE = { lat: -17.803, lng: 31.035 };
const AVENUES = { lat: -17.834, lng: 31.048 };

describe('location pings', () => {
  const ping = (token: string, body: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/riders/me/location', headers: auth(token), payload: body as object });

  it('validates pings', async () => {
    const rider = await makeRider(ctx, nextPhone('6'));
    expect((await ping(rider.token, { lat: 95, lng: 31 })).statusCode).toBe(400);
    expect((await ping(rider.token, { lat: -17.8, lng: 181 })).statusCode).toBe(400);
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at: 'yesterday' })).statusCode).toBe(400);
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at: new Date(Date.now() + 3_600_000).toISOString() })).statusCode).toBe(400);
    expect((await ping(rider.token, { lat: -17.8, lng: 31, extra: 1 })).statusCode).toBe(400);
    expect((await ping(rider.token, { lat: -17.8, lng: 31 })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'POST', url: '/riders/me/location', headers: auth(shop.token), payload: { lat: 1, lng: 1 } })).statusCode).toBe(403);
  });

  it('allows one ping per 10 seconds per rider; a retry of the same ping is harmless', async () => {
    const rider = await makeRider(ctx, nextPhone('6'));
    const at = new Date().toISOString();
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at })).statusCode).toBe(204);
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at })).statusCode).toBe(204);
    let limited = 0;
    for (let i = 1; i <= 3; i += 1) {
      const res = await ping(rider.token, { lat: -17.8, lng: 31, at: new Date(Date.now() + i * 1000).toISOString() });
      if (res.statusCode === 429) limited += 1;
    }
    expect(limited).toBe(3);
    const n = (await ctx.pool.query('SELECT count(*)::int n FROM gps_pings WHERE rider_id=$1', [rider.id])).rows[0].n;
    expect(n).toBe(1);
  });

  it('rejects pings stamped more than 5 minutes old, over 1 minute ahead, or earlier than the latest stored ping', async () => {
    const rider = await makeRider(ctx, nextPhone('6'));
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at: ago(2 * 3_600_000) })).statusCode).toBe(400);
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at: ago(6 * 60_000) })).statusCode).toBe(400);
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at: new Date(Date.now() + 2 * 60_000).toISOString() })).statusCode).toBe(400);
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at: ago(60_000) })).statusCode).toBe(204);
    await ctx.pool.query(`UPDATE gps_pings SET received_at = now() - interval '1 minute' WHERE rider_id=$1`, [rider.id]);
    expect((await ping(rider.token, { lat: -17.8, lng: 31, at: ago(120_000) })).statusCode).toBe(400);
  });
});

describe('runFlagJob', () => {
  async function inFlight(suburbs: string[], beforePickup?: (riderId: string) => Promise<void>) {
    const rider = await makeRider(ctx, nextPhone('6'), { topupCents: 500 });
    const parcels: string[] = [];
    for (const suburb of suburbs) {
      const phone = nextPhone('5');
      const p = await book(ctx, shop.token, { level: 'express', suburb, valueCents: 1500, recipientPhone: phone, recipientPhoneConfirm: phone });
      expect((await accept(await bundleOf(p.parcelId), rider.token)).statusCode).toBe(200);
      if (beforePickup && parcels.length === 0) await beforePickup(rider.id);
      expect((await event(p.parcelId, rider.token, 'pickup_confirmed', await uploadPhoto(ctx, rider.token))).statusCode).toBe(201);
      parcels.push(p.parcelId);
    }
    return { rider, parcels };
  }

  it('raises one stalled flag and none twice for the same stall', async () => {
    const { rider, parcels } = await inFlight(['Avenues']);
    const t0 = await pickedAt(parcels[0] as string);
    for (let m = 1; m <= 13; m += 2) await insertPing(rider.id, AVENUES.lat, AVENUES.lng, new Date(t0.getTime() + m * 60_000));
    const now = new Date(t0.getTime() + 13 * 60_000 + 20_000);
    await runFlagJob(now);
    await runFlagJob(now);
    await runFlagJob(new Date(now.getTime() + 30_000));
    expect(await flagKinds(parcels[0] as string)).toEqual(['stalled']);
  });

  it('a 5-hour continuous stall run every 30 minutes yields exactly one flag', async () => {
    const { rider, parcels } = await inFlight(['Avenues']);
    const t0 = await pickedAt(parcels[0] as string);
    for (let m = 1; m <= 5 * 60 + 10; m += 2) await insertPing(rider.id, AVENUES.lat, AVENUES.lng, new Date(t0.getTime() + m * 60_000));
    for (let m = 30; m <= 5 * 60; m += 30) await runFlagJob(new Date(t0.getTime() + m * 60_000 + 10_000));
    expect(await flagKinds(parcels[0] as string)).toEqual(['stalled']);
  });

  it('a new stall after the rider moved is a new episode', async () => {
    const { rider, parcels } = await inFlight(['Avenues']);
    const t0 = await pickedAt(parcels[0] as string);
    for (let m = 1; m <= 13; m += 2) await insertPing(rider.id, AVENUES.lat, AVENUES.lng, new Date(t0.getTime() + m * 60_000));
    await runFlagJob(new Date(t0.getTime() + 14 * 60_000));
    for (let m = 15; m <= 29; m += 2) await insertPing(rider.id, AVENUES.lat + 0.004, AVENUES.lng, new Date(t0.getTime() + m * 60_000));
    await runFlagJob(new Date(t0.getTime() + 30 * 60_000));
    expect(await flagKinds(parcels[0] as string)).toEqual(['stalled', 'stalled']);
  });

  it('pings from before pickup (riding from Waterfalls to the shop) do not flag the parcel off route', async () => {
    const { rider, parcels } = await inFlight(['Avenues'], async (riderId) => {
      await insertPing(riderId, WATERFALLS.lat, WATERFALLS.lng, new Date(Date.now() - 25 * 60_000));
      await insertPing(riderId, WATERFALLS.lat, WATERFALLS.lng, new Date(Date.now() - 15 * 60_000));
    });
    const t0 = await pickedAt(parcels[0] as string);
    await insertPing(rider.id, AVENUES.lat, AVENUES.lng, new Date(t0.getTime() + 60_000));
    await runFlagJob(new Date(t0.getTime() + 2 * 60_000));
    expect(await flagKinds(parcels[0] as string)).toEqual([]);
  });

  it('a rider with Mbare and Avondale parcels in flight is not flagged off route for either', async () => {
    const { rider, parcels } = await inFlight(['Mbare', 'Avondale']);
    const t0 = await pickedAt(parcels[1] as string);
    await insertPing(rider.id, MBARE.lat, MBARE.lng, new Date(t0.getTime() + 60_000));
    await insertPing(rider.id, AVONDALE.lat, AVONDALE.lng, new Date(t0.getTime() + 5 * 60_000));
    await runFlagJob(new Date(t0.getTime() + 6 * 60_000));
    for (const id of parcels) expect(await flagKinds(id)).toEqual([]);
  });

  it('still flags a rider who really leaves every planned route', async () => {
    const { rider, parcels } = await inFlight(['Avenues']);
    const t0 = await pickedAt(parcels[0] as string);
    await insertPing(rider.id, WATERFALLS.lat, WATERFALLS.lng, new Date(t0.getTime() + 60_000));
    await runFlagJob(new Date(t0.getTime() + 2 * 60_000));
    expect(await flagKinds(parcels[0] as string)).toEqual(['off_route']);
  });

  it('admin-only POST /admin/run-flag-job returns the new count', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/admin/run-flag-job', headers: auth(shop.token) })).statusCode).toBe(403);
    const res = await ctx.app.inject({ method: 'POST', url: '/admin/run-flag-job', headers: auth(await ctx.adminToken()) });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().raised).toBe('number');
  });
});
