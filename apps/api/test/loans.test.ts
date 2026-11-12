import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LendingPartner, PartnerDecision } from '../src/lending/partner';
import { auth, createCtx, makeRider, type TestCtx } from './helpers';

const calls: Array<{ loanId: string; principalCents: number }> = [];
let decision: PartnerDecision | Error = { ref: 'P-1', status: 'approved', feeBps: 500, termDays: 14 };
const partner: LendingPartner = {
  connected: true,
  quote: () => ({ feeBps: 500, termDays: 14 }),
  async request(input) {
    calls.push({ loanId: input.loanId, principalCents: input.principalCents });
    if (decision instanceof Error) throw decision;
    return decision;
  },
};

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createCtx({ lendingPartner: partner });
});
afterAll(async () => ctx.close());

const status = async (token: string) => (await ctx.app.inject({ method: 'GET', url: '/loans/status', headers: auth(token) })).json();
const ask = (token: string, principalCents: number) =>
  ctx.app.inject({ method: 'POST', url: '/loans', headers: auth(token), payload: { principalCents } });
const confirm = (token: string, id: string, code: string) =>
  ctx.app.inject({ method: 'POST', url: `/loans/${id}/confirm`, headers: auth(token), payload: { code } });

/** A rider with enough clean deliveries and an account that is old enough. */
async function loyalRider(phone: string, clean = 120) {
  const r = await makeRider(ctx, phone, { cleanDeliveries: clean });
  await ctx.pool.query(`UPDATE users SET created_at = now() - interval '90 days' WHERE id = $1`, [r.id]);
  return r;
}

describe('loans', () => {
  it('without a partner connected, asking answers not available', async () => {
    const bare = await createCtx();
    const r = await bare.signIn('+263773300001', 'rider');
    const res = await bare.app.inject({ method: 'POST', url: '/loans', headers: auth(r.token), payload: { principalCents: 500 } });
    expect(res.statusCode).toBe(503);
    expect((await bare.app.inject({ method: 'GET', url: '/loans/status', headers: auth(r.token) })).json().partnerConnected).toBe(false);
    await bare.close();
  });

  it('shows why a new rider cannot ask yet, and the next step', async () => {
    const r = await makeRider(ctx, '+263773300002', { cleanDeliveries: 5 });
    const s = await status(r.token);
    expect(s).toMatchObject({ eligible: false, limitCents: 0, cleanParcels: 5, nextStepAt: 30, partnerConnected: true });
    expect(s.partnerNote).toMatch(/licensed partner/);
    expect(s.reasons.length).toBeGreaterThan(0);
    expect((await ask(r.token, 500)).statusCode).toBe(403);
  });

  it('asks, needs the right code, then the partner decides; one live loan at a time', async () => {
    const r = await loyalRider('+263773300003');
    expect(await status(r.token)).toMatchObject({ eligible: true, limitCents: 2000 });
    expect((await ask(r.token, 2001)).statusCode).toBe(400);
    const res = await ask(r.token, 1000);
    expect(res.statusCode).toBe(201);
    const loan = res.json();
    expect(loan).toMatchObject({ principalCents: 1000, repayCents: 1050, feeBps: 500 });
    expect(loan.safetyNote).toMatch(/Nobody from Tuma/);
    expect(calls.some((c) => c.loanId === loan.loanId)).toBe(false); // the partner has heard nothing yet
    expect((await ask(r.token, 500)).statusCode).toBe(403);
    const code = ctx.otp.sent.get('+263773300003') as string;
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await confirm(r.token, loan.loanId, wrong)).statusCode).toBe(401);
    const ok = await confirm(r.token, loan.loanId, code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'active', repayCents: 1050 });
    expect(calls.filter((c) => c.loanId === loan.loanId)).toHaveLength(1);
    expect(await status(r.token)).toMatchObject({ eligible: false, loan: { status: 'active', principalCents: 1000 } });
    // the same code cannot be used twice
    expect((await confirm(r.token, loan.loanId, code)).statusCode).toBe(409);
  });

  it('locks after too many wrong codes', async () => {
    const r = await loyalRider('+263773300004');
    const loan = (await ask(r.token, 500)).json();
    const code = ctx.otp.sent.get('+263773300004') as string;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) expect((await confirm(r.token, loan.loanId, wrong)).statusCode).toBe(401);
    expect((await confirm(r.token, loan.loanId, code)).statusCode).toBe(401);
    expect(await status(r.token)).toMatchObject({ loan: null });
  });

  it('a declined or unreachable partner lends nothing and frees the person to try again', async () => {
    const r = await loyalRider('+263773300005');
    decision = { ref: 'P-2', status: 'declined', feeBps: 500, termDays: 14 };
    const l1 = (await ask(r.token, 500)).json();
    const d = await confirm(r.token, l1.loanId, ctx.otp.sent.get('+263773300005') as string);
    expect(d.json()).toEqual({ status: 'declined' });
    decision = new Error('down');
    const l2 = (await ask(r.token, 500)).json();
    const down = await confirm(r.token, l2.loanId, ctx.otp.sent.get('+263773300005') as string);
    expect(down.statusCode).toBe(502);
    decision = { ref: 'P-1', status: 'approved', feeBps: 500, termDays: 14 };
    expect((await ask(r.token, 500)).statusCode).toBe(201);
  });

  it('nobody else can confirm someone elses loan, and a pending loan can be cancelled', async () => {
    const a = await loyalRider('+263773300006');
    const b = await loyalRider('+263773300007');
    const loan = (await ask(a.token, 500)).json();
    expect((await confirm(b.token, loan.loanId, ctx.otp.sent.get('+263773300006') as string)).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: `/loans/${loan.loanId}/cancel`, headers: auth(a.token) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: `/loans/${loan.loanId}/cancel`, headers: auth(a.token) })).statusCode).toBe(409);
  });
});
