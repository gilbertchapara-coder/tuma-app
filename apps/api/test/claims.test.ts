import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFlagJob } from '../src/jobs/flagJob';
import { auth, book, createCtx, makeRider, type TestCtx } from './helpers';

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

async function accepted(opts: { valueCents?: number; topupCents?: number; depositCents?: number } = {}) {
  const phone = nextPhone('5');
  const p = await book(ctx, shop.token, {
    level: 'express',
    valueCents: opts.valueCents ?? 1500,
    recipientPhone: phone,
    recipientPhoneConfirm: phone,
  });
  const rider = await makeRider(ctx, nextPhone('6'), { topupCents: opts.topupCents ?? 500, depositCents: opts.depositCents ?? 2000 });
  expect((await accept(await bundleOf(p.parcelId), rider.token)).statusCode).toBe(200);
  return { p, rider };
}
async function pickedUp(opts: Parameters<typeof accepted>[0] = {}) {
  const a = await accepted(opts);
  expect((await event(a.p.parcelId, a.rider.token, 'pickup_confirmed', 'https://photos.test/pickup.jpg')).statusCode).toBe(201);
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

describe('location pings and runFlagJob', () => {
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

  it('raises one stalled flag and none twice for the same stall', async () => {
    const { p, rider } = await pickedUp();
    const now = new Date();
    for (let m = 12; m >= 0; m -= 2) {
      const at = new Date(now.getTime() - m * 60_000).toISOString();
      // On the way from the depot to Avenues, then stopped: same spot throughout.
      expect((await ping(rider.token, { lat: -17.834, lng: 31.048, at })).statusCode).toBe(204);
    }
    expect(await runFlagJob(now)).toBe(1);
    expect(await runFlagJob(now)).toBe(0);
    expect(await runFlagJob(new Date(now.getTime() + 30_000))).toBe(0);
    const rows = await ctx.pool.query('SELECT kind FROM flags WHERE parcel_id=$1', [p.parcelId]);
    expect(rows.rows).toEqual([{ kind: 'stalled' }]);
  });

  it('admin-only POST /admin/run-flag-job returns the new count', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/admin/run-flag-job', headers: auth(shop.token) })).statusCode).toBe(403);
    const res = await ctx.app.inject({ method: 'POST', url: '/admin/run-flag-job', headers: auth(await ctx.adminToken()) });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().raised).toBe('number');
  });
});
