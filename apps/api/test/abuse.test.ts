import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, bookingBody, createCtx, type TestCtx } from './helpers';

let ctx: TestCtx;
let shop: { token: string; id: string };

beforeAll(async () => {
  ctx = await createCtx();
  shop = await ctx.signIn('+263771300001', 'shop');
});
afterAll(async () => ctx.close());

const post = (over: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/parcels', headers: auth(shop.token), payload: bookingBody(over) });

describe('booking abuse limits', () => {
  it('refuses a recipient number outside Zimbabwe and Zambia, so no SMS is sent abroad', async () => {
    const res = await post({ recipientPhone: '+447911123456', recipientPhoneConfirm: '+447911123456' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_country');
  });

  it('stops one shop booking more than 60 parcels an hour', async () => {
    await ctx.pool.query(
      `INSERT INTO parcels (shop_id, suburb, level, value_cents, contents, recipient_phone, price_cents, track_token, country)
       SELECT $1, 'Avenues', 'standard', 1000, 'x', '+263771234567', 100, 'seed-' || g, 'ZW' FROM generate_series(1, 60) g`,
      [shop.id],
    );
    const res = await post({});
    expect(res.statusCode).toBe(429);
  });
});
