// Live smoke test for the Tuma API. Needs Node 20+.
//
// Railway variables on the API service (test only, remove SMOKE_TEST_KEY afterwards):
//   SMOKE_TEST_KEY     long random string (24+ chars)
//   SMOKE_TEST_PHONES  comma list: the admin, shop, rider and three recipient phones below
//   ADMIN_PHONES       the admin phone below
//
// Run (PowerShell):
//   $env:BASE_URL="https://your-api.up.railway.app"; $env:SMOKE_TEST_KEY="..."; node scripts/smoke.mjs
// Phones default to made-up +26377099xxxx numbers; override with ADMIN_PHONE, SHOP_PHONE, RIDER_PHONE.

const BASE = (process.env.BASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.SMOKE_TEST_KEY ?? '';
if (!BASE || !KEY) {
  console.error('Set BASE_URL and SMOKE_TEST_KEY first.');
  process.exit(2);
}
const ADMIN = process.env.ADMIN_PHONE ?? '+263770990001';
const SHOP = process.env.SHOP_PHONE ?? '+263770990002';
const RIDER = process.env.RIDER_PHONE ?? '+263770990003';
const RECIPIENTS = ['+263770990011', '+263770990012', '+263770990013'];
const SUBURBS = ['Mbare', 'Workington', 'Houghton Park'];

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) throw new Error(`stopped at: ${name}`);
}

// The API allows 10 /auth calls per minute per IP, so sign-ins are paced.
async function signIn(phone, role) {
  await sleep(8000);
  const req = await call('POST', '/auth/otp/request', { body: { phone } });
  check(`otp request ${phone}`, req.status === 200, `${req.status} ${JSON.stringify(req.json)}`);
  const peek = await call('GET', `/smoke-test/code/${encodeURIComponent(phone)}`, { headers: { 'x-smoke-key': KEY } });
  check(`read test code ${phone}`, peek.status === 200, `${peek.status} (is SMOKE_TEST_KEY set on Railway and phone listed?)`);
  await sleep(8000);
  const ver = await call('POST', '/auth/otp/verify', { body: { phone, code: peek.json.code, ...(role ? { role } : {}) } });
  check(`sign in ${phone} as ${ver.json?.user?.role}`, ver.status === 200, `${ver.status} ${JSON.stringify(ver.json)}`);
  return { token: ver.json.token, id: ver.json.user.id, role: ver.json.user.role };
}

async function main() {
  const t0 = Date.now();
  const track0 = await call('GET', '/track/not-a-real-token');
  check('unknown tracking link returns 404', track0.status === 404, String(track0.status));

  const admin = await signIn(ADMIN, undefined);
  check('admin phone became admin', admin.role === 'admin', `role was ${admin.role} (set ADMIN_PHONES)`);
  const shop = await signIn(SHOP, 'shop');
  const rider = await signIn(RIDER, 'rider');

  // The fake rider may already hold float from an earlier run, so compare against the balance before top-up.
  const before = await call('GET', '/riders/me', { token: rider.token });
  const balanceBefore = before.json.balanceCents ?? 0;
  const profile = await call('PATCH', `/riders/${rider.id}/profile`, {
    token: admin.token,
    body: { verified: true, hasGuarantor: true, cleanDeliveries: 40, rating: 5 },
  });
  check('admin set rider profile', profile.status === 200, JSON.stringify(profile.json));
  const top = await call('POST', `/riders/${rider.id}/topup`, { token: admin.token, body: { cents: 2500 } });
  check('admin topped up rider $25', top.status === 200, JSON.stringify(top.json));
  const dep = await call('POST', `/riders/${rider.id}/deposit`, { token: admin.token, body: { cents: 2000 } });
  check('admin held $20 deposit', dep.status === 200, JSON.stringify(dep.json));
  const me = await call('GET', '/riders/me', { token: rider.token });
  const startBalance = me.json.balanceCents;
  check('rider is Trusted with float', me.json.tier === 'trusted' && startBalance === balanceBefore + 500, JSON.stringify(me.json));

  // A bad booking is rejected, and three good ones are accepted.
  const bad = await call('POST', '/parcels', {
    token: shop.token,
    body: { suburb: 'Borrowdale', level: 'standard', valueCents: 1000, contents: 'x', recipientPhone: RECIPIENTS[0], recipientPhoneConfirm: RECIPIENTS[0], sealedPhotoUrl: 'https://photos.test/s.jpg' },
  });
  check('unknown suburb rejected', bad.status === 400 || bad.status === 422, String(bad.status));
  const mismatch = await call('POST', '/parcels', {
    token: shop.token,
    body: { suburb: 'Mbare', level: 'standard', valueCents: 1000, contents: 'x', recipientPhone: RECIPIENTS[0], recipientPhoneConfirm: RECIPIENTS[1], sealedPhotoUrl: 'https://photos.test/s.jpg' },
  });
  check('mismatched recipient phone rejected', mismatch.status === 400 || mismatch.status === 422, String(mismatch.status));

  const parcels = [];
  for (const [i, suburb] of SUBURBS.entries()) {
    const p = await call('POST', '/parcels', {
      token: shop.token,
      body: { suburb, level: 'standard', valueCents: 1500, contents: 'Smoke test parcel', recipientPhone: RECIPIENTS[i], recipientPhoneConfirm: RECIPIENTS[i], sealedPhotoUrl: 'https://photos.test/sealed.jpg' },
    });
    check(`book parcel to ${suburb}`, p.status === 200 || p.status === 201, `${p.status} ${JSON.stringify(p.json)}`);
    parcels.push({ ...p.json, phone: RECIPIENTS[i] });
  }

  const built = await call('POST', '/bundles/build', { token: admin.token, body: {} });
  const bundle = Array.isArray(built.json) ? built.json.find((b) => b.parcelIds.includes(parcels[0].parcelId)) : undefined;
  check('bundle built on the south-west run', built.status === 200 && bundle?.run === 'southwest', JSON.stringify(built.json).slice(0, 300));
  check('all three parcels pooled into it', parcels.every((p) => bundle.parcelIds.includes(p.parcelId)), JSON.stringify(bundle));

  const open = await call('GET', '/bundles/open', { token: rider.token });
  check('rider sees the bundle', open.json.bundles?.some((b) => b.id === bundle.id), JSON.stringify(open.json).slice(0, 200));
  const accept = await call('POST', `/bundles/${bundle.id}/accept`, { token: rider.token });
  check('rider accepts the bundle', accept.status === 200, `${accept.status} ${JSON.stringify(accept.json)}`);
  const second = await call('POST', `/bundles/${bundle.id}/accept`, { token: rider.token });
  check('second accept is refused', second.status === 409 || second.status === 403 || second.status === 400, String(second.status));

  for (const p of parcels) {
    const pk = await call('POST', `/parcels/${p.parcelId}/events`, {
      token: rider.token,
      body: { type: 'pickup_confirmed', photoUrl: 'https://photos.test/pickup.jpg' },
    });
    check(`pickup confirmed ${p.parcelId.slice(0, 8)}`, pk.status === 201, `${pk.status} ${JSON.stringify(pk.json)}`);
  }

  // Wrong code first, then the right one.
  const wrong = await call('POST', `/parcels/${parcels[0].parcelId}/deliver`, { token: rider.token, body: { code: '000000' } });
  check('wrong delivery code refused', wrong.status >= 400 && wrong.status < 500, String(wrong.status));
  for (const p of parcels) {
    const peek = await call('GET', `/smoke-test/code/${encodeURIComponent(p.phone)}`, { headers: { 'x-smoke-key': KEY } });
    check(`read delivery code for ${p.phone}`, peek.status === 200, String(peek.status));
    const done = await call('POST', `/parcels/${p.parcelId}/deliver`, { token: rider.token, body: { code: peek.json.code } });
    check(`delivered ${p.parcelId.slice(0, 8)} with code`, done.status === 200, `${done.status} ${JSON.stringify(done.json)}`);
  }

  for (const p of parcels) {
    const token = p.trackingUrl.split('/track/')[1];
    const tr = await call('GET', `/track/${token}`);
    const body = JSON.stringify(tr.json);
    check(`tracking shows delivered ${p.parcelId.slice(0, 8)}`, tr.json.status === 'delivered', body);
    check('tracking page hides the full phone number', !body.includes(p.phone), 'full phone leaked');
  }

  const after = await call('GET', '/riders/me', { token: rider.token });
  // Tuma's cut is a percentage set per country by the owner. Unset means no deduction yet.
  const cfg = await call('GET', '/admin/countries', { token: admin.token });
  const zw = (cfg.json.countries ?? []).find((c) => c.code === 'ZW');
  const bps = zw?.platformBps ?? null;
  const spent = startBalance - after.json.balanceCents;
  check(bps === null ? 'no Tuma percentage set: rider not charged' : 'rider was charged the Tuma percentage', bps === null ? spent === 0 : spent > 0, `${startBalance} -> ${after.json.balanceCents} (bps ${bps})`);
  const metrics = await call('GET', '/admin/metrics', { token: admin.token });
  check('admin metrics respond', metrics.status === 200, String(metrics.status));

  const webBase = (process.env.WEB_URL ?? '').replace(/\/+$/, '');
  if (webBase) {
    console.log('\nTracking pages for the delivered test parcels:');
    for (const p of parcels) console.log(`  ${webBase}/track/${p.trackingUrl.split('/track/')[1]}`);
  }

  console.log(`\nALL ${results.length} CHECKS PASSED in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((err) => {
  const failed = results.filter((r) => !r.ok).length;
  console.error(`\nSTOPPED after ${results.length} checks (${failed} failed): ${err.message}`);
  process.exit(1);
});
