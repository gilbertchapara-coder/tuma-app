import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeOtpFailures } from '../src/jobs/purgeOtpFailures';
import { auth, book, createCtx, makeRider, uploadPhoto, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createCtx();
});
afterAll(async () => ctx.close());

describe('GET /health', () => {
  it('answers ok without a login', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('purgeOtpFailures', () => {
  it('removes old unlocked rows and keeps recent or locked ones', async () => {
    await ctx.pool.query(
      `INSERT INTO otp_failures (phone, failures, window_start, locked_until) VALUES
       ('+263700000001', 2, now() - interval '3 days', NULL),
       ('+263700000002', 2, now() - interval '3 days', now() + interval '1 hour'),
       ('+263700000003', 1, now() - interval '1 hour', NULL)`,
    );
    expect(await purgeOtpFailures(ctx.pool)).toBe(1);
    const left = (await ctx.pool.query('SELECT phone FROM otp_failures ORDER BY phone')).rows.map((r) => r.phone);
    expect(left).toEqual(['+263700000002', '+263700000003']);
  });
});

describe('photo evidence rules', () => {
  it('refuses to reuse a photo that is already on a parcel', async () => {
    const shop = await ctx.signIn('+263771400001', 'shop');
    const url = await uploadPhoto(ctx, shop.token);
    await book(ctx, shop.token, { sealedPhotoUrl: url });
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/parcels',
      headers: auth(shop.token),
      payload: {
        suburb: 'Avenues', level: 'standard', valueCents: 2000, contents: 'Phone case',
        recipientPhone: '+263771234567', recipientPhoneConfirm: '+263771234567', sealedPhotoUrl: url,
      },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toMatch(/already used/);
  });

  it('refuses a photo older than a day', async () => {
    const shop = await ctx.signIn('+263771400002', 'shop');
    const url = await uploadPhoto(ctx, shop.token);
    await ctx.pool.query("UPDATE photos SET created_at = now() - interval '2 days' WHERE owner_id = $1", [shop.id]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/parcels',
      headers: auth(shop.token),
      payload: {
        suburb: 'Avenues', level: 'standard', valueCents: 2000, contents: 'Phone case',
        recipientPhone: '+263771234567', recipientPhoneConfirm: '+263771234567', sealedPhotoUrl: url,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/too old/);
    void makeRider;
  });
});
