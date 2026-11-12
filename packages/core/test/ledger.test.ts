import { describe, expect, it } from 'vitest';
import {
  InsufficientFloatError,
  InvalidAmountError,
  balanceCents,
  chargeFee,
  depositCents,
  holdDeposit,
  payoutLoss,
  refundFee,
  topup,
  type Entry,
} from '../src/ledger';

const T = '2026-11-09T08:00:00Z';
/** A sample fee. The real fee is a percentage of the run price, worked out by the caller. */
const FEE = 25;
const funded = (cents: number): Entry[] => topup([], cents, T);

describe('topup and balance', () => {
  it('starts at zero and adds top-ups', () => {
    expect(balanceCents([])).toBe(0);
    expect(balanceCents(topup(funded(500), 200, T))).toBe(700);
  });
  it('rejects non-integer, zero and negative amounts', () => {
    for (const bad of [0, -5, 1.5, NaN, Infinity]) {
      expect(() => topup([], bad, T)).toThrow(InvalidAmountError);
      expect(() => holdDeposit(funded(500), bad, T)).toThrow(InvalidAmountError);
      expect(() => payoutLoss(funded(500), 'j', bad, T)).toThrow(InvalidAmountError);
    }
  });
});

describe('chargeFee', () => {
  it('charges 25 from a 500 top-up leaving 475', () => {
    const e = chargeFee(funded(500), 'job1', T, FEE);
    expect(balanceCents(e)).toBe(475);
    expect(e[e.length - 1]).toEqual({ type: 'fee', cents: 25, at: T, jobId: 'job1' });
  });
  it('takes whatever fee the caller worked out', () => {
    expect(balanceCents(chargeFee(funded(500), 'job1', T, 40))).toBe(460);
  });
  it('throws with balance 20 and leaves entries unchanged', () => {
    const e = funded(20);
    const snapshot = JSON.stringify(e);
    expect(() => chargeFee(e, 'job1', T, FEE)).toThrow(InsufficientFloatError);
    expect(JSON.stringify(e)).toBe(snapshot);
    expect(e).toHaveLength(1);
  });
  it('charges the same jobId once', () => {
    const once = chargeFee(funded(500), 'job1', T, FEE);
    const twice = chargeFee(once, 'job1', T, FEE);
    expect(twice).toBe(once);
    expect(balanceCents(twice)).toBe(475);
  });
  it('does not throw on a repeat charge even when float is now too low', () => {
    const once = chargeFee(funded(25), 'job1', T, FEE);
    expect(balanceCents(once)).toBe(0);
    expect(chargeFee(once, 'job1', T, FEE)).toBe(once);
  });
  it('never mutates its input', () => {
    const e = funded(500);
    const out = chargeFee(e, 'job1', T, FEE);
    expect(e).toHaveLength(1);
    expect(out).not.toBe(e);
  });
});

describe('chargeFee fee validation', () => {
  it.each([NaN, -5, 1.5, Infinity])('throws on fee %s and leaves entries unchanged', (bad) => {
    const e = funded(500);
    const snapshot = JSON.stringify(e);
    expect(() => chargeFee(e, 'job1', T, bad)).toThrow(InvalidAmountError);
    expect(JSON.stringify(e)).toBe(snapshot);
  });
  it('a zero fee records nothing and does not throw', () => {
    const e = funded(500);
    expect(chargeFee(e, 'job1', T, 0)).toBe(e);
  });
});

describe('refundFee', () => {
  it('restores 25', () => {
    const e = refundFee(chargeFee(funded(500), 'job1', T, FEE), 'job1', T);
    expect(balanceCents(e)).toBe(500);
  });
  it('refunds only once', () => {
    const once = refundFee(chargeFee(funded(500), 'job1', T, FEE), 'job1', T);
    const twice = refundFee(once, 'job1', T);
    expect(twice).toBe(once);
    expect(balanceCents(twice)).toBe(500);
  });
  it('returns entries unchanged when no fee was charged for that job', () => {
    const e = chargeFee(funded(500), 'job1', T, FEE);
    expect(refundFee(e, 'other', T)).toBe(e);
  });
  it('refunds the amount actually charged', () => {
    const charged = chargeFee(funded(500), 'job1', T, 40);
    expect(balanceCents(refundFee(charged, 'job1', T))).toBe(500);
  });
  it('does not re-charge a job whose fee was refunded', () => {
    const refunded = refundFee(chargeFee(funded(500), 'job1', T, FEE), 'job1', T);
    expect(chargeFee(refunded, 'job1', T, FEE)).toBe(refunded);
  });
  it('does not mutate its input', () => {
    const charged = chargeFee(funded(500), 'job1', T, FEE);
    const n = charged.length;
    refundFee(charged, 'job1', T);
    expect(charged).toHaveLength(n);
  });
});

describe('holdDeposit', () => {
  it('moves cents from float to the deposit pot', () => {
    const e = holdDeposit(funded(500), 200, T);
    expect(balanceCents(e)).toBe(300);
    expect(depositCents(e)).toBe(200);
  });
  it('throws when float is too low and leaves entries unchanged', () => {
    const e = funded(100);
    expect(() => holdDeposit(e, 101, T)).toThrow(InsufficientFloatError);
    expect(e).toHaveLength(1);
  });
});

describe('payoutLoss', () => {
  it('draws from the deposit first', () => {
    const e = holdDeposit(funded(500), 200, T);
    const r = payoutLoss(e, 'job1', 150, T);
    expect(r.paidCents).toBe(150);
    expect(r.shortfallCents).toBe(0);
    expect(depositCents(r.entries)).toBe(50);
    expect(balanceCents(r.entries)).toBe(300);
  });
  it('then the float when the deposit runs out', () => {
    const e = holdDeposit(funded(500), 200, T);
    const r = payoutLoss(e, 'job1', 350, T);
    expect(r.paidCents).toBe(350);
    expect(r.shortfallCents).toBe(0);
    expect(depositCents(r.entries)).toBe(0);
    expect(balanceCents(r.entries)).toBe(150);
    const payouts = r.entries.filter((x) => x.type === 'loss_payout');
    expect(payouts.map((x) => x.cents)).toEqual([200, 150]);
  });
  it('never goes below zero and reports the shortfall', () => {
    const e = holdDeposit(funded(500), 200, T);
    const r = payoutLoss(e, 'job1', 900, T);
    expect(r.paidCents).toBe(500);
    expect(r.shortfallCents).toBe(400);
    expect(r.paidCents + r.shortfallCents).toBe(900);
    expect(depositCents(r.entries)).toBe(0);
    expect(balanceCents(r.entries)).toBe(0);
  });
  it('pays nothing but records a settlement when both pots are empty', () => {
    const r = payoutLoss([], 'job1', 100, T);
    expect(r.paidCents).toBe(0);
    expect(r.shortfallCents).toBe(100);
    expect(r.entries).toEqual([{ type: 'loss_settled', cents: 0, at: T, jobId: 'job1' }]);
  });
  it('a zero payout is final: a later top-up is not taken on retry', () => {
    const first = payoutLoss([], 'job1', 100, T);
    const topped = topup(first.entries, 500, T);
    const again = payoutLoss(topped, 'job1', 100, T);
    expect(again.paidCents).toBe(0);
    expect(again.shortfallCents).toBe(100);
    expect(balanceCents(again.entries)).toBe(500);
    expect(again.entries).toBe(topped);
  });
  it('a partly paid loss repeated later never pays more', () => {
    const first = payoutLoss(holdDeposit(funded(100), 100, T), 'job1', 300, T);
    expect(first.paidCents).toBe(100);
    const topped = topup(first.entries, 500, T);
    const again = payoutLoss(topped, 'job1', 300, T);
    expect(again.paidCents).toBe(100);
    expect(again.shortfallCents).toBe(200);
    expect(balanceCents(again.entries)).toBe(500);
    expect(again.entries).toBe(topped);
  });
  it('loss_settled does not change either pot', () => {
    const e = holdDeposit(funded(500), 200, T);
    const settled: Entry[] = [...e, { type: 'loss_settled', cents: 0, at: T, jobId: 'x' }];
    expect(balanceCents(settled)).toBe(300);
    expect(depositCents(settled)).toBe(200);
  });
  it('is idempotent per jobId', () => {
    const e = holdDeposit(funded(500), 200, T);
    const first = payoutLoss(e, 'job1', 350, T);
    const second = payoutLoss(first.entries, 'job1', 350, T);
    expect(second.entries).toBe(first.entries);
    expect(second.paidCents).toBe(350);
    expect(second.shortfallCents).toBe(0);
    expect(balanceCents(second.entries)).toBe(150);
  });
  it('reports the earlier paid amount and the remaining shortfall on a repeat', () => {
    const first = payoutLoss(holdDeposit(funded(100), 100, T), 'job1', 300, T);
    const second = payoutLoss(first.entries, 'job1', 300, T);
    expect(second.paidCents).toBe(100);
    expect(second.shortfallCents).toBe(200);
  });
  it('does not mutate its input', () => {
    const e = holdDeposit(funded(500), 200, T);
    const n = e.length;
    payoutLoss(e, 'job1', 350, T);
    expect(e).toHaveLength(n);
  });
});

describe('property: pots never negative', () => {
  // Deterministic LCG so failures reproduce.
  const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;

  it('holds after any random sequence of operations', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      let e: Entry[] = [];
      for (let step = 0; step < 40; step++) {
        const job = `j${Math.floor(rand() * 6)}`;
        const amount = 1 + Math.floor(rand() * 300);
        const before = JSON.stringify(e);
        try {
          switch (Math.floor(rand() * 5)) {
            case 0:
              e = topup(e, amount, T);
              break;
            case 1:
              e = chargeFee(e, job, T, FEE);
              break;
            case 2:
              e = refundFee(e, job, T);
              break;
            case 3:
              e = holdDeposit(e, amount, T);
              break;
            default: {
              const r = payoutLoss(e, job, amount, T);
              expect(r.paidCents).toBeGreaterThanOrEqual(0);
              expect(r.shortfallCents).toBeGreaterThanOrEqual(0);
              expect(r.paidCents + r.shortfallCents).toBe(amount);
              e = r.entries;
            }
          }
        } catch (err) {
          expect(err).toBeInstanceOf(InsufficientFloatError);
          expect(JSON.stringify(e)).toBe(before);
        }
        expect(balanceCents(e)).toBeGreaterThanOrEqual(0);
        expect(depositCents(e)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
