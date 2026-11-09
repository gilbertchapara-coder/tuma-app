import { describe, expect, it } from 'vitest';
import {
  MIN_RATING,
  NEW_MIN_DEPOSIT_CENTS,
  SENIOR_MIN_DEPOSIT_CENTS,
  TRUSTED_MIN_CLEAN,
  SENIOR_MIN_CLEAN,
  canCarry,
  capCents,
  riderTier,
  type RiderStats,
} from '../src/tiers';

const base: RiderStats = {
  verified: true,
  hasGuarantor: true,
  depositCents: 2000,
  cleanDeliveries: 0,
  rating: 0,
};
const rider = (o: Partial<RiderStats> = {}): RiderStats => ({ ...base, ...o });

describe('constants', () => {
  it('holds the owner placeholders', () => {
    expect(MIN_RATING).toBe(4.0);
    expect(NEW_MIN_DEPOSIT_CENTS).toBe(2000);
    expect(SENIOR_MIN_DEPOSIT_CENTS).toBe(5000);
    expect(TRUSTED_MIN_CLEAN).toBe(30);
    expect(SENIOR_MIN_CLEAN).toBe(100);
  });
});

describe('riderTier', () => {
  it('new: verified, guarantor, deposit 2000', () => {
    expect(riderTier(rider())).toBe('new');
  });
  it('unverified when deposit is 1999', () => {
    expect(riderTier(rider({ depositCents: 1999 }))).toBe('unverified');
  });
  it('unverified without ID or without guarantor', () => {
    expect(riderTier(rider({ verified: false }))).toBe('unverified');
    expect(riderTier(rider({ hasGuarantor: false }))).toBe('unverified');
  });
  it('trusted at 30 clean and rating 4.0', () => {
    expect(riderTier(rider({ cleanDeliveries: 30, rating: 4.0 }))).toBe('trusted');
  });
  it('29 clean deliveries stays new', () => {
    expect(riderTier(rider({ cleanDeliveries: 29, rating: 5 }))).toBe('new');
  });
  it('rating below 4.0 stays new', () => {
    expect(riderTier(rider({ cleanDeliveries: 200, rating: 3.9, depositCents: 5000 }))).toBe('new');
  });
  it('senior at 100 clean, rating 4.0, deposit 5000', () => {
    expect(riderTier(rider({ cleanDeliveries: 100, rating: 4.0, depositCents: 5000 }))).toBe('senior');
  });
  it('100 clean but deposit 4999 is trusted', () => {
    expect(riderTier(rider({ cleanDeliveries: 100, rating: 4.5, depositCents: 4999 }))).toBe('trusted');
  });
  it('trusted requires the new basics', () => {
    expect(riderTier(rider({ cleanDeliveries: 50, rating: 5, depositCents: 1000 }))).toBe('unverified');
  });
  it('does not mutate input', () => {
    const s = Object.freeze(rider({ cleanDeliveries: 100, rating: 4, depositCents: 5000 }));
    expect(() => riderTier(s)).not.toThrow();
  });
});

describe('capCents', () => {
  it('maps tiers to caps', () => {
    expect(capCents('unverified')).toBe(0);
    expect(capCents('new')).toBe(3000);
    expect(capCents('trusted')).toBe(10000);
    expect(capCents('senior')).toBe(30000);
  });
});

describe('canCarry', () => {
  const newR = rider();
  const senior = rider({ cleanDeliveries: 100, rating: 4, depositCents: 5000 });
  it('new rider at and over cap', () => {
    expect(canCarry(newR, 3000, false)).toBe(true);
    expect(canCarry(newR, 3001, false)).toBe(false);
  });
  it('insurance does not lift a new rider cap', () => {
    expect(canCarry(newR, 3001, true)).toBe(false);
  });
  it('senior above 30000 only if insured', () => {
    expect(canCarry(senior, 30000, false)).toBe(true);
    expect(canCarry(senior, 30001, false)).toBe(false);
    expect(canCarry(senior, 30001, true)).toBe(true);
  });
  it('non-senior never carries above 30000, even insured', () => {
    const trusted = rider({ cleanDeliveries: 30, rating: 4 });
    expect(canCarry(trusted, 30001, true)).toBe(false);
  });
  it('unverified carries nothing', () => {
    expect(canCarry(rider({ verified: false }), 1, false)).toBe(false);
    expect(canCarry(rider({ verified: false }), 1, true)).toBe(false);
  });
  it('rejects 0, negative, fractional, NaN, Infinity', () => {
    for (const v of [0, -1, 1.5, NaN, Infinity]) {
      expect(canCarry(senior, v, true)).toBe(false);
    }
  });
});
