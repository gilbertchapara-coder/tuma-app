/**
 * MOCK TEST for Tuma. Runs the whole journey against a throwaway database, with fake SMS, fake top-up and clear weather.
 *   npm run mock -w apps/api
 * Nothing here touches production. The Zambia suburbs, prices and the Tuma percentage below are MOCK values
 * so the flow can run; the owner's real values replace them through PUT /admin/countries/:code.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../src/app';
import { migrate } from '../src/db';
import { FakeTopupProvider } from '../src/topup/fakeProvider';
import { clearSkyProvider } from '../src/weather/provider';
import type { CodeNotifier, OtpProvider } from '../src/ports';

const require = createRequire(import.meta.url);
const EmbeddedPostgres = (require('embedded-postgres').default ?? require('embedded-postgres')) as typeof import('embedded-postgres').default;

const ADMIN_PHONE = '+263770000001';
const MOCK_ZW_BPS = 2000; // MOCK: 20%. The real percentage is the owner's.
const MOCK_ZM = {
  suburbs: { Kabulonga: { band: 'A', run: 'south' }, Woodlands: { band: 'A', run: 'south' } },
  prices: { A: [3000, 2000, 1500] }, // MOCK kwacha ngwee. The real prices are the owner's.
  platformBps: 1000,
};

class Sms implements OtpProvider, CodeNotifier {
  readonly otp = new Map<string, string>();
  readonly delivery = new Map<string, string>();
  async send(phone: string, code: string): Promise<void> {
    this.otp.set(phone, code);
  }
  async sendDeliveryCode(phone: string, code: string): Promise<void> {
    this.delivery.set(phone, code);
  }
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
}
const step = (title: string): void => console.log(`\n== ${title}`);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function main(): Promise<void> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'tuma-mock-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, max: 10 });
  await migrate(pool);
  const sms = new Sms();
  const app = await buildApp({
    pool,
    otp: sms,
    notifier: sms,
    jwtSecret: randomBytes(32).toString('hex'),
    publicBaseUrl: 'https://tuma.mock',
    adminPhones: [ADMIN_PHONE],
    otpCooldownMs: 0,
    authRateLimitPerMinute: 100_000,
    topupProvider: new FakeTopupProvider(),
    weatherProvider: clearSkyProvider,
  });
  await app.ready();

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, token?: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: token ? auth(token) : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, json: (res.body ? JSON.parse(res.body) : {}) as Record<string, any> };
  };
  const signIn = async (phone: string, role: 'shop' | 'rider' = 'shop') => {
    const req = await call('POST', '/auth/otp/request', undefined, { phone });
    if (req.status !== 200) throw new Error(`otp request ${phone} ${req.status}`);
    const res = await call('POST', '/auth/otp/verify', undefined, { phone, code: sms.otp.get(phone), role });
    if (res.status !== 200) throw new Error(`otp verify ${phone} ${res.status} ${JSON.stringify(res.json)}`);
    return { token: res.json.token as string, id: res.json.user.id as string, country: res.json.country as string | undefined };
  };
  const photo = async (token: string): Promise<string> => {
    const jpeg = Buffer.alloc(1500, 7);
    jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff; jpeg[jpeg.length - 2] = 0xff; jpeg[jpeg.length - 1] = 0xd9;
    const res = await app.inject({ method: 'POST', url: '/photos', headers: { ...auth(token), 'content-type': 'image/jpeg' }, payload: jpeg });
    if (res.statusCode !== 201) throw new Error(`photo ${res.statusCode}`);
    return (JSON.parse(res.body) as { url: string }).url;
  };
  const book = async (shopToken: string, over: Record<string, unknown>) =>
    call('POST', '/parcels', shopToken, {
      level: 'standard', valueCents: 2000, contents: 'Phone case',
      sealedPhotoUrl: await photo(shopToken), ...over,
    });

  try {
    step('0. Owner sets up (admin)');
    const admin = (await signIn(ADMIN_PHONE)).token;
    check('admin signs in', admin.length > 10);
    check('Tuma percentage (MOCK 20%) set for Zimbabwe', (await call('PUT', '/admin/countries/ZW', admin, { platformBps: MOCK_ZW_BPS })).status === 200);
    check('Zambia is closed until loaded', (await call('GET', '/quote?suburb=Kabulonga&level=standard&country=ZM')).status === 409);
    check('Zambia (MOCK suburbs, prices) loaded', (await call('PUT', '/admin/countries/ZM', admin, MOCK_ZM)).status === 200);

    step('1. Zimbabwe: shop books, rider delivers');
    const shop = await signIn('+263771900001');
    const rider = await signIn('+263773900001', 'rider');
    check('Zimbabwe number lands in Zimbabwe', (await call('GET', '/me', rider.token)).json.country?.code === 'ZW');
    await call('PATCH', `/riders/${rider.id}/profile`, admin, { verified: true, hasGuarantor: true, cleanDeliveries: 40, rating: 5 });
    const noFloat = await call('GET', '/bundles/open', rider.token);
    check('rider with no float sees the board', noFloat.status === 200);
    const recips = ['+263771900101', '+263771900102', '+263771900103'];
    const parcels: Array<{ id: string; phone: string; price: number }> = [];
    for (const [i, suburb] of ['Mbare', 'Workington', 'Houghton Park'].entries()) {
      const b = await book(shop.token, { suburb, recipientPhone: recips[i], recipientPhoneConfirm: recips[i] });
      check(`book to ${suburb} in dollars`, b.status < 300 && b.json.currencySymbol === '$', JSON.stringify(b.json));
      parcels.push({ id: b.json.parcelId, phone: recips[i]!, price: b.json.priceCents });
    }
    const built = await call('POST', '/bundles/build', admin, {});
    const bundle = (built.json as unknown as Array<{ id: string; parcelIds: string[] }>).find((x) => x.parcelIds.includes(parcels[0]!.id));
    check('parcels pooled into one bundle', Boolean(bundle));
    const tryNoFloat = await call('POST', `/bundles/${bundle?.id}/accept`, rider.token);
    check('NO FLOAT = cannot accept a ride', tryNoFloat.status === 402 || tryNoFloat.status === 403, String(tryNoFloat.status));
    await call('POST', `/riders/${rider.id}/topup`, admin, { cents: 4500 }); // 2000 of it is held as the deposit
    await call('POST', `/riders/${rider.id}/deposit`, admin, { cents: 2000 });
    check('rider accepts after topping up', (await call('POST', `/bundles/${bundle?.id}/accept`, rider.token)).status === 200);
    for (const p of parcels) {
      const pk = await call('POST', `/parcels/${p.id}/events`, rider.token, { type: 'pickup_confirmed', photoUrl: await photo(rider.token) });
      check('pickup confirmed with photo', pk.status === 201, JSON.stringify(pk.json));
    }
    for (const p of parcels) {
      const wrong = await call('POST', `/parcels/${p.id}/deliver`, rider.token, { code: '000000' });
      check('wrong delivery code refused', wrong.status !== 200);
      const done = await call('POST', `/parcels/${p.id}/deliver`, rider.token, { code: sms.delivery.get(p.phone) });
      check('delivered with the recipient code', done.status === 200, JSON.stringify(done.json));
    }
    const summary = await call('GET', '/riders/me', rider.token);
    const fees = parcels.reduce((a, p) => a + Math.round((p.price * MOCK_ZW_BPS) / 10_000), 0);
    check(`Tuma took its percentage from the float (${fees}c)`, summary.json.balanceCents === 2500 - fees, JSON.stringify(summary.json));
    const earn = await call('GET', '/riders/me/earnings', rider.token);
    check('earnings today counts 3 parcels', earn.json.parcelsDelivered === 3, JSON.stringify(earn.json));

    step('2. Rider travels to Zambia');
    const zmSignIn = await signIn('+260971000001', 'rider');
    check('Zambian number gets a Zambian account automatically', (await call('GET', '/me', zmSignIn.token)).json.country?.code === 'ZM');
    const sw = await call('POST', '/me/country', rider.token, { country: 'ZM' });
    check('Zimbabwe rider switches to Zambia', sw.status === 200 && sw.json.country?.currencySymbol === 'K', JSON.stringify(sw.json));
    const zmShop = await signIn('+260971000010');
    const zb = await book(zmShop.token, { suburb: 'Kabulonga', recipientPhone: '+260971234567', recipientPhoneConfirm: '+260971234567' });
    check('Zambian shop books in kwacha', zb.status < 300 && zb.json.currencySymbol === 'K' && zb.json.priceCents === 2000, JSON.stringify(zb.json));
    const zBuilt = await call('POST', '/bundles/build', admin, {});
    const zBundle = (zBuilt.json as unknown as Array<{ id: string; parcelIds: string[] }>).find((x) => x.parcelIds.includes(zb.json.parcelId));
    check('Zambian bundle built', Boolean(zBundle));
    const noZmFloat = await call('POST', `/bundles/${zBundle?.id}/accept`, rider.token);
    check('Zimbabwe float does not pay for Zambian rides', noZmFloat.status === 402 || noZmFloat.status === 403, String(noZmFloat.status));
    await call('POST', `/riders/${rider.id}/topup`, admin, { cents: 5000, country: 'ZM' });
    await call('POST', `/riders/${rider.id}/deposit`, admin, { cents: 2000, country: 'ZM' });
    check('rider accepts the Zambian ride', (await call('POST', `/bundles/${zBundle?.id}/accept`, rider.token)).status === 200);
    check('cannot leave Zambia with a parcel on the road', (await call('POST', '/me/country', rider.token, { country: 'ZW' })).status === 409);
    await call('POST', `/parcels/${zb.json.parcelId}/events`, rider.token, { type: 'pickup_confirmed', photoUrl: await photo(rider.token) });
    const zDone = await call('POST', `/parcels/${zb.json.parcelId}/deliver`, rider.token, { code: sms.delivery.get('+260971234567') });
    check('Zambian parcel delivered', zDone.status === 200, JSON.stringify(zDone.json));
    const back = await call('POST', '/me/country', rider.token, { country: 'ZW' });
    check('after delivery the rider can go home', back.status === 200);
    const home = await call('GET', '/riders/me', rider.token);
    check('Zimbabwe float untouched by the Zambian ride', home.json.balanceCents === 2500 - fees, JSON.stringify(home.json));

    step('3. Support');
    const ref = (await call('GET', `/admin/codes/locked`, admin)).status;
    check('support can list locked codes', ref === 200);
    const lookup = await call('GET', `/admin/parcels/lookup?ref=${encodeURIComponent('TUM-' + parcels[0]!.id.replace(/-/g, '').slice(0, 8).toUpperCase())}`, admin);
    check('support finds a parcel by its TUM- reference', lookup.status === 200 && lookup.json.parcels?.length === 1, JSON.stringify(lookup.json));
    check('shop phone is masked for support', /^\*\*\*\d{3}$/.test(String(lookup.json.parcels?.[0]?.shopPhone)), JSON.stringify(lookup.json));
    const track = await call('GET', `/track/${(await call('GET', `/parcels/${parcels[0]!.id}`, shop.token)).json.trackingUrl?.split('/track/')[1] ?? 'x'}`);
    check('tracking page shows delivered, no full phone', track.status === 200 && !JSON.stringify(track.json).includes(parcels[0]!.phone), JSON.stringify(track.json));
  } finally {
    await app.close();
    await pool.end();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
