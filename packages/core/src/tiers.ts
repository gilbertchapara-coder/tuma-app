export type Tier = 'unverified' | 'new' | 'trusted' | 'senior';

export interface RiderStats {
  verified: boolean;
  hasGuarantor: boolean;
  depositCents: number;
  cleanDeliveries: number;
  rating: number;
}

// Owner's placeholders: change thresholds here, in one place.
export const NEW_MIN_DEPOSIT_CENTS = 2000;
export const SENIOR_MIN_DEPOSIT_CENTS = 5000;
export const TRUSTED_MIN_CLEAN = 30;
export const SENIOR_MIN_CLEAN = 100;
export const MIN_RATING = 4.0;

/** Binding value caps in cents. */
export const TIER_CAP_CENTS: Readonly<Record<Tier, number>> = {
  unverified: 0,
  new: 3000,
  trusted: 10000,
  senior: 30000,
};

export function riderTier(s: RiderStats): Tier {
  const isNew = s.verified && s.hasGuarantor && s.depositCents >= NEW_MIN_DEPOSIT_CENTS;
  if (!isNew) return 'unverified';
  const goodRating = s.rating >= MIN_RATING;
  if (goodRating && s.cleanDeliveries >= SENIOR_MIN_CLEAN && s.depositCents >= SENIOR_MIN_DEPOSIT_CENTS) {
    return 'senior';
  }
  if (goodRating && s.cleanDeliveries >= TRUSTED_MIN_CLEAN) return 'trusted';
  return 'new';
}

export function capCents(t: Tier): number {
  return TIER_CAP_CENTS[t];
}

/** Within the tier cap; only a senior may carry above their cap, and only insured parcels. */
export function canCarry(s: RiderStats, valueCents: number, insured: boolean): boolean {
  if (!Number.isInteger(valueCents) || valueCents <= 0) return false;
  const tier = riderTier(s);
  if (valueCents <= capCents(tier)) return true;
  return tier === 'senior' && insured;
}
