import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { migrate } from '../src/db';
import type { OtpProvider, CodeNotifier } from '../src/ports';
import type { TopupProvider } from '../src/topup/provider';
import { FakeTopupProvider } from '../src/topup/fakeProvider';

export const ADMIN_PHONE = '+263770000001';

export class FakeOtp implements OtpProvider {
  readonly sent = new Map<string, string>();
  async send(phone: string, code: string): Promise<void> {
    this.sent.set(phone, code);
  }
}

export class FakeNotifier implements CodeNotifier {
  readonly codes = new Map<string, string>();
  async sendDeliveryCode(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

export interface TestCtx {
  app: FastifyInstance;
  pool: pg.Pool;
  otp: FakeOtp;
  notifier: FakeNotifier;
  signIn(phone: string, role?: 'shop' | 'rider'): Promise<{ token: string; id: string }>;
  adminToken(): Promise<string>;
  close(): Promise<void>;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** A fresh database per call, on the shared embedded Postgres. */
export async function createCtx(
  opts: {
    authRateLimitPerMinute?: number;
    topupProvider?: TopupProvider;
    topupMaxSingleCents?: number;
    topupMaxBalanceCents?: number;
  } = {},
): Promise<TestCtx> {
  const adminUrl = inject('pgAdminUrl');
  const dbName = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: adminUrl.replace(/\/postgres$/, `/${dbName}`), max: 30 });
  await migrate(pool);
  const otp = new FakeOtp();
  const notifier = new FakeNotifier();
  const app = await buildApp({
    pool,
    otp,
    notifier,
    jwtSecret: randomBytes(32).toString('hex'),
    publicBaseUrl: 'https://tuma.test',
    adminPhones: [ADMIN_PHONE],
    otpCooldownMs: 0,
    authRateLimitPerMinute: opts.authRateLimitPerMinute ?? 100_000,
    topupProvider: opts.topupProvider ?? new FakeTopupProvider(),
    topupMaxSingleCents: opts.topupMaxSingleCents,
    topupMaxBalanceCents: opts.topupMaxBalanceCents,
  });
  await app.ready();

  const signIn: TestCtx['signIn'] = async (phone, role = 'shop') => {
    const req = await app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone } });
    if (req.statusCode !== 200) throw new Error(`otp request failed ${req.statusCode} ${req.body}`);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: otp.sent.get(phone), role },
    });
    if (res.statusCode !== 200) throw new Error(`otp verify failed ${res.statusCode} ${res.body}`);
    const body = res.json();
    return { token: body.token, id: body.user.id };
  };

  let adminTokenPromise: Promise<string> | undefined;

  return {
    app,
    pool,
    otp,
    notifier,
    signIn,
    adminToken: () => (adminTokenPromise ??= signIn(ADMIN_PHONE).then((r) => r.token)),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export interface RiderSetup {
  verified?: boolean;
  hasGuarantor?: boolean;
  cleanDeliveries?: number;
  rating?: number;
  topupCents?: number;
  /** Held deposit; a rider needs $20 to reach the new tier. Default 2000. */
  depositCents?: number;
}

/** Signs a rider in and sets profile and float through the admin routes. */
export async function makeRider(ctx: TestCtx, phone: string, setup: RiderSetup = {}) {
  const rider = await ctx.signIn(phone, 'rider');
  const admin = await ctx.adminToken();
  const profile = await ctx.app.inject({
    method: 'PATCH',
    url: `/riders/${rider.id}/profile`,
    headers: auth(admin),
    payload: {
      verified: setup.verified ?? true,
      hasGuarantor: setup.hasGuarantor ?? true,
      cleanDeliveries: setup.cleanDeliveries ?? 0,
      rating: setup.rating ?? 5,
    },
  });
  if (profile.statusCode !== 200) throw new Error(`profile ${profile.statusCode} ${profile.body}`);
  const deposit = setup.depositCents ?? 2000;
  const topupTotal = (setup.topupCents ?? 0) + deposit;
  if (topupTotal > 0) {
    const top = await ctx.app.inject({
      method: 'POST',
      url: `/riders/${rider.id}/topup`,
      headers: auth(admin),
      payload: { cents: topupTotal },
    });
    if (top.statusCode !== 200) throw new Error(`topup ${top.statusCode} ${top.body}`);
  }
  if (deposit > 0) {
    const dep = await ctx.app.inject({
      method: 'POST',
      url: `/riders/${rider.id}/deposit`,
      headers: auth(admin),
      payload: { cents: deposit },
    });
    if (dep.statusCode !== 200) throw new Error(`deposit ${dep.statusCode} ${dep.body}`);
  }
  return rider;
}

export const bookingBody = (over: Record<string, unknown> = {}) => ({
  suburb: 'Avenues',
  level: 'standard',
  valueCents: 2000,
  contents: 'Phone case',
  recipientPhone: '+263771234567',
  recipientPhoneConfirm: '+263771234567',
  ...over,
});

/** Uploads a small real JPEG and returns the photo's URL, as the app does before booking or scanning. */
export async function uploadPhoto(ctx: TestCtx, token: string): Promise<string> {
  const jpeg = Buffer.alloc(1500, 7);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[jpeg.length - 2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;
  // Parallel uploads from one user get 429 by design (one at a time), so tests that book in parallel retry briefly.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await ctx.app.inject({ method: 'POST', url: '/photos', headers: { ...auth(token), 'content-type': 'image/jpeg' }, payload: jpeg });
    if (res.statusCode === 201) return (res.json() as { url: string }).url;
    if (res.statusCode !== 429 || !/still uploading/.test(res.body)) throw new Error(`photo ${res.statusCode} ${res.body}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('photo upload kept being busy');
}

/** Books a parcel with a real sealed photo, unless the caller sets sealedPhotoUrl themselves (even to undefined). */
export async function book(ctx: TestCtx, shopToken: string, over: Record<string, unknown> = {}) {
  const sealedPhotoUrl = 'sealedPhotoUrl' in over ? over.sealedPhotoUrl : await uploadPhoto(ctx, shopToken);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/parcels',
    headers: auth(shopToken),
    payload: bookingBody({ ...over, sealedPhotoUrl }),
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`book ${res.statusCode} ${res.body}`);
  return res.json() as { parcelId: string; priceCents: number; trackingUrl: string };
}

export async function buildBundles(ctx: TestCtx) {
  const admin = await ctx.adminToken();
  const res = await ctx.app.inject({ method: 'POST', url: '/bundles/build', headers: auth(admin), payload: {} });
  if (res.statusCode !== 200) throw new Error(`build ${res.statusCode} ${res.body}`);
  return res.json() as Array<{ id: string; run: string; level: string; parcelIds: string[]; dropOrder: string[] }>;
}
