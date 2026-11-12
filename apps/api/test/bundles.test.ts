import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, book, buildBundles, createCtx, makeRider, type TestCtx } from './helpers';

let ctx: TestCtx;
let shop: { token: string; id: string };

beforeAll(async () => {
  ctx = await createCtx();
  shop = await ctx.signIn('+263771100001', 'shop');
});
afterAll(async () => ctx.close());

const accept = (bundleId: string, token: string) =>
  ctx.app.inject({ method: 'POST', url: `/bundles/${bundleId}/accept`, headers: auth(token) });
const fees = async (riderId: string) =>
  (await ctx.pool.query(`SELECT job_id, cents FROM ledger_entries WHERE rider_id = $1 AND type = 'fee'`, [riderId])).rows;
const bundleOf = async (parcelId: string): Promise<string> =>
  (await ctx.pool.query('SELECT bundle_id FROM bundle_parcels WHERE parcel_id = $1', [parcelId])).rows[0].bundle_id;

describe('POST /bundles/build', () => {
  it('needs the admin role and pools standard parcels by run', async () => {
    const rider = await makeRider(ctx, '+263773100001');
    const denied = await ctx.app.inject({ method: 'POST', url: '/bundles/build', headers: auth(rider.token), payload: {} });
    expect(denied.statusCode).toBe(403);
    const a = await book(ctx, shop.token, { suburb: 'Avenues' });
    const b = await book(ctx, shop.token, { suburb: 'Avondale' });
    const built = await buildBundles(ctx);
    const mine = built.find((x) => x.parcelIds.includes(a.parcelId));
    expect(mine?.parcelIds.sort()).toEqual([a.parcelId, b.parcelId].sort());
    expect(mine?.dropOrder).toEqual(['Avenues', 'Avondale']);
    expect(mine?.id).toBeTruthy();
    // building again does not re-bundle the same parcels
    expect((await buildBundles(ctx)).flatMap((x) => x.parcelIds)).not.toContain(a.parcelId);
  });

  it('concurrent builds never put a parcel in two bundles', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Waterfalls', level: 'overnight' });
    const admin = await ctx.adminToken();
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        ctx.app.inject({ method: 'POST', url: '/bundles/build', headers: auth(admin), payload: {} }),
      ),
    );
    expect(runs.every((r) => r.statusCode === 200)).toBe(true);
    const n = await ctx.pool.query('SELECT count(*)::int n FROM bundle_parcels WHERE parcel_id = $1', [p.parcelId]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('POST /bundles/:id/accept', () => {
  it('two riders accepting at once: exactly one 200, one 409, exactly one fee entry', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Mbare', level: 'express' });
    const r1 = await makeRider(ctx, '+263773200001', { topupCents: 500 });
    const r2 = await makeRider(ctx, '+263773200002', { topupCents: 500 });
    const bundleId = await bundleOf(p.parcelId);
    const [x, y] = await Promise.all([accept(bundleId, r1.token), accept(bundleId, r2.token)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.statusCode === 200)?.json()).toEqual({ ok: true });
    expect([x, y].find((r) => r.statusCode === 409)?.json().error).toBe('taken');
    const all = await ctx.pool.query(`SELECT rider_id FROM ledger_entries WHERE type = 'fee' AND job_id = $1`, [p.parcelId]);
    expect(all.rows).toHaveLength(1);
  });

  it('many riders racing for one bundle still gives one winner', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express' });
    const riders = await Promise.all(
      Array.from({ length: 6 }, (_, i) => makeRider(ctx, `+26377330000${i}`, { topupCents: 500 })),
    );
    const bundleId = await bundleOf(p.parcelId);
    const results = await Promise.all(riders.map((r) => accept(bundleId, r.token)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(5);
    const n = await ctx.pool.query(`SELECT count(*)::int n FROM ledger_entries WHERE type='fee' AND job_id=$1`, [p.parcelId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('a new rider on a $31 parcel gets 403 over_cap and is charged nothing', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', valueCents: 3100 });
    const rider = await makeRider(ctx, '+263773400001', { topupCents: 500 });
    const bundleId = await bundleOf(p.parcelId);
    const res = await accept(bundleId, rider.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('over_cap');
    expect(await fees(rider.id)).toHaveLength(0);
    const b = await ctx.pool.query('SELECT status FROM bundles WHERE id = $1', [bundleId]);
    expect(b.rows[0].status).toBe('open');
  });

  it('an unverified rider cannot accept anything (cap 0)', async () => {
    const p = await book(ctx, shop.token, { suburb: 'Avenues', level: 'express', valueCents: 500 });
    const rider = await makeRider(ctx, '+263773400002', { verified: false, topupCents: 500 });
    expect((await accept(await bundleOf(p.parcelId), rider.token)).statusCode).toBe(403);
  });

  it('insufficient float: 402 and nothing charged, bundle stays open', async () => {
    const shopB = await ctx.signIn('+263771100002', 'shop');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await book(ctx, shopB.token, { suburb: 'Waterfalls', valueCents: 1000 })).parcelId);
    const built = await buildBundles(ctx);
    const bundle = built.find((b) => b.parcelIds.includes(ids[0] as string));
    expect(bundle?.parcelIds).toHaveLength(3);
    const rider = await makeRider(ctx, '+263773400003', { topupCents: 60 }); // three fees at 20% of the price come to more than 60
    const res = await accept(bundle!.id, rider.token);
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('insufficient_float');
    expect(await fees(rider.id)).toHaveLength(0);
    const topped = await ctx.app.inject({
      method: 'POST',
      url: `/riders/${rider.id}/topup`,
      headers: auth(await ctx.adminToken()),
      payload: { cents: 100 },
    });
    expect(topped.statusCode).toBe(200);
    expect((await accept(bundle!.id, rider.token)).statusCode).toBe(200);
    expect(await fees(rider.id)).toHaveLength(3);
    const me = await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth(rider.token) });
    const feeTotal = (await ctx.pool.query(`SELECT coalesce(sum(cents),0)::int AS n FROM ledger_entries WHERE rider_id = $1 AND type = 'fee'`, [rider.id])).rows[0].n as number;
    expect(me.json()).toMatchObject({ tier: 'new', balanceCents: 160 - feeTotal });
  });

  it('one rider accepting several bundles at once cannot overspend the float', async () => {
    const parcels = await Promise.all(
      Array.from({ length: 5 }, () => book(ctx, shop.token, { suburb: 'Avenues', level: 'express', valueCents: 1000 })),
    );
    const fee = Math.round(parcels[0]!.priceCents * 0.2);
    const rider = await makeRider(ctx, '+263773500001', { topupCents: fee * 2 + 1 }); // two fees only
    const bundleIds = await Promise.all(parcels.map((p) => bundleOf(p.parcelId)));
    const results = await Promise.all(bundleIds.map((id) => accept(id, rider.token)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 402)).toHaveLength(3);
    expect(await fees(rider.id)).toHaveLength(2);
  });

  it('the ledger is append-only', async () => {
    await expect(ctx.pool.query(`UPDATE ledger_entries SET cents = 1`)).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/append-only/);
  });

  it('unknown or malformed bundle id: 400/404, and shops cannot accept', async () => {
    const rider = await makeRider(ctx, '+263773500002', { topupCents: 100 });
    expect((await accept('not-a-uuid', rider.token)).statusCode).toBe(400);
    expect((await accept('11111111-1111-4111-8111-111111111111', rider.token)).statusCode).toBe(404);
    expect((await accept('11111111-1111-4111-8111-111111111111', shop.token)).statusCode).toBe(403);
  });
});
