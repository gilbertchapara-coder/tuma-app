import { liableParty, type CustodyEvent } from '@tuma/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, book, buildBundles, createCtx, makeRider, type TestCtx, uploadPhoto } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createCtx();
});
afterAll(async () => ctx.close());

const SUBURBS = ['Mbare', 'Workington', 'Houghton Park'];

describe('pilot flow: South-West run, 3 Standard parcels', () => {
  it('books, bundles, accepts, picks up, delivers with codes, charges 3 x 24c', async () => {
    const shop = await ctx.signIn('+263771900001', 'shop');
    // A Trusted rider: verified, guarantor, $20 deposit, 30+ clean deliveries, rating 5, $5 float.
    const rider = await makeRider(ctx, '+263773900001', { cleanDeliveries: 40, topupCents: 500 });
    const summary = await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth(rider.token) });
    expect(summary.json()).toMatchObject({ tier: 'trusted', balanceCents: 500, depositCents: 2000 });

    // Shop books 3 Standard parcels, each to a different South-West suburb.
    const parcels: Array<{ parcelId: string; priceCents: number; trackingUrl: string; phone: string; suburb: string }> = [];
    for (const [i, suburb] of SUBURBS.entries()) {
      const phone = `+26377190${String(1000 + i)}`;
      const p = await book(ctx, shop.token, {
        suburb,
        level: 'standard',
        recipientPhone: phone,
        recipientPhoneConfirm: phone,
      });
      parcels.push({ ...p, phone, suburb });
    }

    // Admin builds bundles: all three pool into one South-West bundle.
    const built = await buildBundles(ctx);
    const bundle = built.find((b) => b.parcelIds.includes(parcels[0]!.parcelId));
    expect(bundle?.run).toBe('southwest');
    expect(bundle?.parcelIds.sort()).toEqual(parcels.map((p) => p.parcelId).sort());

    // The rider sees it in the open list, then accepts it.
    const open = await ctx.app.inject({ method: 'GET', url: '/bundles/open', headers: auth(rider.token) });
    expect(open.json().bundles.some((b: { id: string }) => b.id === bundle?.id)).toBe(true);
    const accept = await ctx.app.inject({
      method: 'POST',
      url: `/bundles/${bundle?.id}/accept`,
      headers: auth(rider.token),
    });
    expect(accept.statusCode).toBe(200);

    // Pickup scan for each, then deliver with the code the recipient was sent.
    for (const p of parcels) {
      const pk = await ctx.app.inject({
        method: 'POST',
        url: `/parcels/${p.parcelId}/events`,
        headers: auth(rider.token),
        payload: { type: 'pickup_confirmed', photoUrl: await uploadPhoto(ctx, rider.token) },
      });
      expect(pk.statusCode).toBe(201);
    }
    for (const p of parcels) {
      const code = ctx.notifier.codes.get(p.phone);
      expect(code).toMatch(/^\d{6}$/);
      const done = await ctx.app.inject({
        method: 'POST',
        url: `/parcels/${p.parcelId}/deliver`,
        headers: auth(rider.token),
        payload: { code },
      });
      expect(done.statusCode).toBe(200);
    }

    // Every parcel is delivered and the recipient, not the rider, is now liable.
    for (const p of parcels) {
      const token = p.trackingUrl.split('/track/')[1];
      const track = await ctx.app.inject({ method: 'GET', url: `/track/${token}` });
      expect(track.json()).toMatchObject({ status: 'delivered', stage: 'delivered' });
      const { rows } = await ctx.pool.query(
        'SELECT type, at, actor FROM custody_events WHERE parcel_id = $1 ORDER BY id',
        [p.parcelId],
      );
      const events: CustodyEvent[] = rows.map((r) => ({ type: r.type, at: new Date(r.at).toISOString(), actor: r.actor }));
      expect(liableParty(events)).toBe('recipient');
    }

    // Ledger: exactly 3 fees, each 20% of its parcel price, one per parcel.
    const fees = await ctx.pool.query(`SELECT job_id, cents FROM ledger_entries WHERE rider_id = $1 AND type = 'fee'`, [
      rider.id,
    ]);
    expect(fees.rows).toHaveLength(3);
    const expectedFees = parcels.map((p) => Math.round(p.priceCents * 0.2));
    expect(fees.rows.map((f) => Number(f.cents)).sort()).toEqual([...expectedFees].sort());
    const after = await ctx.app.inject({ method: 'GET', url: '/riders/me', headers: auth(rider.token) });
    expect(after.json().balanceCents).toBe(500 - expectedFees.reduce((a, b) => a + b, 0));
  });
});
