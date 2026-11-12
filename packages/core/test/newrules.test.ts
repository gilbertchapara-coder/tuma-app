import { describe, expect, it } from 'vitest';
import { classifyHour, quoteWithWeather, worstAhead } from '../src/weather';
import { isValidAsk, isWaiting, pickWinner } from '../src/auction';
import { canRequest, eligibility, repaymentCents, type LoyaltyStats } from '../src/lending';

describe('weather', () => {
  it('classifies hours', () => {
    expect(classifyHour({ mmPerHour: 0, chancePercent: 90 })).toBe('clear');
    expect(classifyHour({ mmPerHour: 1, chancePercent: 20 })).toBe('clear');
    expect(classifyHour({ mmPerHour: 1, chancePercent: 70 })).toBe('light_rain');
    expect(classifyHour({ mmPerHour: 6, chancePercent: 70 })).toBe('heavy_rain');
    expect(classifyHour({ mmPerHour: NaN, chancePercent: 70 })).toBe('clear');
  });
  it('finds the worst weather in the next hours only', () => {
    const f = [
      { at: '2026-11-12T10:00:00Z', mmPerHour: 0, chancePercent: 0 },
      { at: '2026-11-12T11:00:00Z', mmPerHour: 1, chancePercent: 80 },
      { at: '2026-11-12T15:00:00Z', mmPerHour: 9, chancePercent: 90 },
    ];
    expect(worstAhead(f, new Date('2026-11-12T10:30:00Z'), 3)).toBe('light_rain');
    expect(worstAhead(f, new Date('2026-11-12T10:30:00Z'), 6)).toBe('heavy_rain');
  });
  it('adds weather extra to express and standard, never to overnight', () => {
    expect(quoteWithWeather('Mbare', 'standard', 'heavy_rain')).toEqual({ baseCents: 130, surchargeCents: 25, totalCents: 155, weather: 'heavy_rain' });
    expect(quoteWithWeather('Mbare', 'overnight', 'heavy_rain').surchargeCents).toBe(0);
    expect(quoteWithWeather('Mbare', 'express', 'clear').totalCents).toBe(200);
  });
});

describe('auction', () => {
  const o = (riderId: string, askCents: number, at: string) => ({ riderId, askCents, at });
  const offers = [o('b', 100, '2026-11-12T10:00:02Z'), o('a', 90, '2026-11-12T10:00:05Z'), o('c', 90, '2026-11-12T10:00:03Z')];
  it('first come first served picks the earliest', () => expect(pickWinner('first', offers)?.riderId).toBe('b'));
  it('cheapest picks the lowest ask, earlier wins a tie', () => expect(pickWinner('cheapest', offers)?.riderId).toBe('c'));
  it('returns null with no valid offers', () => {
    expect(pickWinner('first', [])).toBeNull();
    expect(pickWinner('first', [o('x', 0, 'bad')])).toBeNull();
  });
  it('validates asks by mode', () => {
    expect(isValidAsk('cheapest', 80, 130)).toBe(true);
    expect(isValidAsk('cheapest', 49, 130)).toBe(false);
    expect(isValidAsk('cheapest', 131, 130)).toBe(false);
    expect(isValidAsk('first', 130, 130)).toBe(true);
    expect(isValidAsk('first', 100, 130)).toBe(false);
    expect(isValidAsk('cheapest', 1.5, 130)).toBe(false);
  });
  it('a cart place is not a win', () => {
    const w = pickWinner('first', offers);
    expect(isWaiting(offers, 'a', w)).toBe(true);
    expect(isWaiting(offers, 'b', w)).toBe(false);
    expect(isWaiting(offers, 'z', w)).toBe(false);
  });
});

describe('lending', () => {
  const ok: LoyaltyStats = { verified: true, accountAgeDays: 60, cleanParcels: 120, openFlags: 0, lateRepayments: 0, activeLoans: 0 };
  it('grants the step for the clean parcels', () => {
    expect(eligibility(ok)).toMatchObject({ eligible: true, limitCents: 2000, nextStepAt: 250 });
    expect(eligibility({ ...ok, cleanParcels: 300 })).toMatchObject({ limitCents: 5000, nextStepAt: null });
  });
  it('blocks and explains', () => {
    expect(eligibility({ ...ok, cleanParcels: 10 }).reasons[0]).toMatch(/30 clean parcels/);
    for (const bad of [{ verified: false }, { accountAgeDays: 5 }, { openFlags: 1 }, { lateRepayments: 1 }, { activeLoans: 1 }]) {
      const e = eligibility({ ...ok, ...bad });
      expect(e.eligible).toBe(false);
      expect(e.limitCents).toBe(0);
    }
  });
  it('computes repayment and request checks', () => {
    expect(repaymentCents(1000, 500)).toBe(1050);
    expect(repaymentCents(333, 500)).toBe(333 + 17);
    expect(() => repaymentCents(0, 5)).toThrow();
    const e = eligibility(ok);
    expect(canRequest(e, 2000)).toBe(true);
    expect(canRequest(e, 2001)).toBe(false);
    expect(canRequest(eligibility({ ...ok, activeLoans: 1 }), 100)).toBe(false);
  });
});
