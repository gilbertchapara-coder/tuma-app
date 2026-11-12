/**
 * Loyalty-based lending rules. Tuma never holds or lends money itself:
 * a licensed partner (mobile money or a financial institution) does. These rules only decide who may ASK.
 * All numbers are owner placeholders; the partner's rules always win.
 */
export interface LoyaltyStats {
  verified: boolean;
  accountAgeDays: number;
  /** Delivered parcels with no claim or flag. */
  cleanParcels: number;
  openFlags: number;
  lateRepayments: number;
  activeLoans: number;
}

export interface LendingStep {
  minCleanParcels: number;
  limitCents: number;
}

export const MIN_ACCOUNT_AGE_DAYS = 30;
export const LENDING_STEPS: readonly LendingStep[] = [
  { minCleanParcels: 30, limitCents: 500 },
  { minCleanParcels: 100, limitCents: 2000 },
  { minCleanParcels: 250, limitCents: 5000 },
];

export interface Eligibility {
  eligible: boolean;
  limitCents: number;
  /** Plain reasons, empty when eligible. */
  reasons: string[];
  /** Clean parcels needed for the next step; null at the top. */
  nextStepAt: number | null;
}

export function eligibility(s: LoyaltyStats): Eligibility {
  const reasons: string[] = [];
  if (!s.verified) reasons.push('Your account is not verified yet.');
  if (s.accountAgeDays < MIN_ACCOUNT_AGE_DAYS) reasons.push(`Your account must be ${MIN_ACCOUNT_AGE_DAYS} days old.`);
  if (s.openFlags > 0) reasons.push('There is an open problem on your account.');
  if (s.lateRepayments > 0) reasons.push('You have a late repayment.');
  if (s.activeLoans > 0) reasons.push('Pay your current loan first.');
  const first = LENDING_STEPS[0];
  const step = [...LENDING_STEPS].reverse().find((x) => s.cleanParcels >= x.minCleanParcels);
  if (!step && first) reasons.push(`Complete ${first.minCleanParcels} clean parcels to unlock lending.`);
  const next = LENDING_STEPS.find((x) => s.cleanParcels < x.minCleanParcels);
  const ok = reasons.length === 0 && step !== undefined;
  return { eligible: ok, limitCents: ok && step ? step.limitCents : 0, reasons, nextStepAt: next ? next.minCleanParcels : null };
}

/** Amount to pay back: principal plus a flat fee in basis points set by the partner. */
export function repaymentCents(principalCents: number, feeBps: number): number {
  if (!Number.isInteger(principalCents) || principalCents <= 0) throw new Error('principal must be a positive whole number of cents');
  if (!Number.isInteger(feeBps) || feeBps < 0) throw new Error('feeBps must be a whole number of 0 or more');
  return principalCents + Math.ceil((principalCents * feeBps) / 10_000);
}

export function canRequest(e: Eligibility, requestCents: number): boolean {
  return e.eligible && Number.isInteger(requestCents) && requestCents > 0 && requestCents <= e.limitCents;
}
