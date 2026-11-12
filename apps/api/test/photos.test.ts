import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, book, createCtx, makeRider, type TestCtx } from './helpers';

let ctx: TestCtx;
let shop: { token: string; id: string };
let otherShop: { token: string; id: string };

beforeAll(async () => {
  ctx = await createCtx();
  shop = await ctx.signIn('+263771300001', 'shop');
  otherShop = await ctx.signIn('+263771300002', 'shop');
});
afterAll(async () => ctx.close());

const jpeg = (size = 2000): Buffer => {
  const b = Buffer.alloc(size, 7);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
};
const upload = (token: string | null, body: Buffer, type = 'image/jpeg') =>
  ctx.app.inject({
    method: 'POST',
    url: '/photos',
    headers: { ...(token ? auth(token) : {}), 'content-type': type },
    payload: body,
  });
const fetchPhoto = (token: string | null, url: string) =>
  ctx.app.inject({ method: 'GET', url: new URL(url).pathname, headers: token ? auth(token) : {} });

describe('POST /photos', () => {
  it('needs a login', async () => {
    expect((await upload(null, jpeg())).statusCode).toBe(401);
  });

  it('stores a jpeg and returns its own https url', async () => {
    const res = await upload(shop.token, jpeg());
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toMatch(/^https:\/\/tuma\.test\/photos\/[0-9a-f-]{36}$/);
  });

  it('rejects other types, fake jpegs and empty bodies', async () => {
    expect((await upload(shop.token, jpeg(), 'image/png')).statusCode).toBe(415);
    expect((await upload(shop.token, Buffer.from('<script>alert(1)</script>'))).statusCode).toBe(400);
    expect((await upload(shop.token, Buffer.alloc(0))).statusCode).toBe(400);
    const truncated = jpeg();
    truncated[truncated.length - 1] = 0;
    expect((await upload(shop.token, truncated)).statusCode).toBe(400);
  });

  it('rejects a photo over 400 KB', async () => {
    expect((await upload(shop.token, jpeg(400 * 1024 + 1))).statusCode).toBe(413);
    expect((await upload(shop.token, jpeg(400 * 1024))).statusCode).toBe(201);
  });

  it('refuses a second upload that arrives while one is in progress for the same user', async () => {
    const racer = await ctx.signIn('+263771300004', 'shop');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => upload(racer.token, jpeg(500 + i))));
    const codes = results.map((r) => r.statusCode);
    expect(codes.every((c) => c === 201 || c === 429)).toBe(true);
    expect(codes).toContain(201);
  });

  it('limits how many photos one user can add in an hour', async () => {
    const busy = await ctx.signIn('+263771300003', 'shop');
    for (let i = 0; i < 60; i += 1) expect((await upload(busy.token, jpeg(300 + i))).statusCode).toBe(201);
    expect((await upload(busy.token, jpeg(999))).statusCode).toBe(429);
  });
});

describe('GET /photos/:id', () => {
  it('serves the bytes to the owner with safe headers', async () => {
    const { url } = (await upload(shop.token, jpeg(1234))).json();
    const res = await fetchPhoto(shop.token, url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.rawPayload.length).toBe(1234);
  });

  it('needs a login and hides the photo from strangers', async () => {
    const { url } = (await upload(shop.token, jpeg())).json();
    expect((await fetchPhoto(null, url)).statusCode).toBe(401);
    expect((await fetchPhoto(otherShop.token, url)).statusCode).toBe(404);
  });

  it('lets admin and the parcel rider see a photo that is on their parcel', async () => {
    const { url } = (await upload(shop.token, jpeg())).json();
    const p = await book(ctx, shop.token, { sealedPhotoUrl: url });
    const admin = await ctx.adminToken();
    expect((await fetchPhoto(admin, url)).statusCode).toBe(200);
    const rider = await makeRider(ctx, '+263773500001', { topupCents: 500 });
    expect((await fetchPhoto(rider.token, url)).statusCode).toBe(404);
    const bundleId = (await ctx.pool.query('SELECT bundle_id FROM bundle_parcels WHERE parcel_id = $1', [p.parcelId])).rows[0]?.bundle_id;
    if (bundleId) {
      await ctx.app.inject({ method: 'POST', url: `/bundles/${bundleId}/accept`, headers: auth(rider.token) });
      expect((await fetchPhoto(rider.token, url)).statusCode).toBe(200);
    }
  });

  it('404s on a malformed or unknown id', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/photos/not-a-uuid', headers: auth(shop.token) })).statusCode).toBe(404);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/photos/00000000-0000-4000-8000-000000000000', headers: auth(shop.token) })).statusCode,
    ).toBe(404);
  });
});

describe('photo urls on parcels', () => {
  it('only accepts a photo the shop uploaded itself', async () => {
    const mine = (await upload(shop.token, jpeg())).json().url as string;
    const theirs = (await upload(otherShop.token, jpeg())).json().url as string;
    const post = (url: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/parcels',
        headers: auth(shop.token),
        payload: {
          suburb: 'Avenues', level: 'standard', valueCents: 2000, contents: 'Phone case',
          recipientPhone: '+263771234567', recipientPhoneConfirm: '+263771234567', sealedPhotoUrl: url,
        },
      });
    expect((await post(mine)).statusCode).toBe(201);
    expect((await post(theirs)).statusCode).toBe(400);
    // An upper-case id is stored in the canonical lower-case form so the counterparty can see the evidence.
    const upper = mine.replace(/[0-9a-f-]{36}$/, (id) => id.toUpperCase());
    const res = await post(upper);
    expect(res.statusCode).toBe(201);
    const stored = await ctx.pool.query('SELECT photo_url FROM custody_events WHERE parcel_id = $1 AND type = $2', [res.json().parcelId, 'sealed']);
    expect(stored.rows[0].photo_url).toBe(mine);
    expect((await post('https://evil.test/photos/00000000-0000-4000-8000-000000000000')).statusCode).toBe(400);
    expect((await post('https://tuma.test/photos/00000000-0000-4000-8000-000000000000')).statusCode).toBe(400);
  });
});
