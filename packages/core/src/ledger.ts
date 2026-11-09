import { platformFeeCents } from './pricing';

export type EntryType = 'topup' | 'fee' | 'fee_refund' | 'deposit_hold' | 'loss_payout' | 'loss_settled';

/** Which pot a loss_payout drew from. Absent means the float. */
export type Pot = 'deposit' | 'float';

export interface Entry {
  type: EntryType;
  /** Positive integer magnitude in cents (0 only on loss_settled); `type` decides the direction. */
  cents: number;
  at: string;
  jobId?: string;
  /** Only meaningful on loss_payout entries. */
  pot?: Pot;
}

export class InsufficientFloatError extends Error {
  constructor(neededCents: number, availableCents: number) {
    super(`Insufficient float: need ${neededCents}, have ${availableCents}`);
    this.name = 'InsufficientFloatError';
  }
}

export class InvalidAmountError extends Error {
  constructor(cents: number) {
    super(`Amount must be a positive integer number of cents: ${cents}`);
    this.name = 'InvalidAmountError';
  }
}

interface Pots {
  float: number;
  deposit: number;
}

function assertCents(cents: number): void {
  if (!Number.isInteger(cents) || cents <= 0) throw new InvalidAmountError(cents);
}

/** Folds the append-only entries into the two pots. Payouts never take a pot below zero. */
function pots(entries: readonly Entry[]): Pots {
  let float = 0;
  let deposit = 0;
  for (const e of entries) {
    switch (e.type) {
      case 'topup':
      case 'fee_refund':
        float += e.cents;
        break;
      case 'fee':
        float -= e.cents;
        break;
      case 'deposit_hold':
        float -= e.cents;
        deposit += e.cents;
        break;
      case 'loss_payout':
        if (e.pot === 'deposit') deposit = Math.max(0, deposit - e.cents);
        else float = Math.max(0, float - e.cents);
        break;
      case 'loss_settled':
        break;
    }
  }
  return { float, deposit };
}

/** Spendable float in cents. */
export function balanceCents(entries: readonly Entry[]): number {
  return pots(entries).float;
}

/** Held deposit in cents. */
export function depositCents(entries: readonly Entry[]): number {
  return pots(entries).deposit;
}

const find = (entries: readonly Entry[], type: EntryType, jobId: string): Entry | undefined =>
  entries.find((e) => e.type === type && e.jobId === jobId);

export function topup(entries: readonly Entry[], cents: number, at: string): Entry[] {
  assertCents(cents);
  return [...entries, { type: 'topup', cents, at }];
}

export function holdDeposit(entries: readonly Entry[], cents: number, at: string): Entry[] {
  assertCents(cents);
  const available = balanceCents(entries);
  if (available < cents) throw new InsufficientFloatError(cents, available);
  return [...entries, { type: 'deposit_hold', cents, at }];
}

/** Charges the platform fee once per job. A repeat call returns the same entries. */
export function chargeFee(entries: readonly Entry[], jobId: string, at: string): Entry[] {
  if (find(entries, 'fee', jobId)) return entries as Entry[];
  const fee = platformFeeCents();
  if (fee === 0) return entries as Entry[];
  assertCents(fee);
  const available = balanceCents(entries);
  if (available < fee) throw new InsufficientFloatError(fee, available);
  return [...entries, { type: 'fee', cents: fee, at, jobId }];
}

/** Refunds a charged fee once. Whether a refund is allowed is the caller's decision. */
export function refundFee(entries: readonly Entry[], jobId: string, at: string): Entry[] {
  const fee = find(entries, 'fee', jobId);
  if (!fee || find(entries, 'fee_refund', jobId)) return entries as Entry[];
  return [...entries, { type: 'fee_refund', cents: fee.cents, at, jobId }];
}

export interface PayoutResult {
  entries: Entry[];
  paidCents: number;
  shortfallCents: number;
}

/** Pays a loss from the deposit first, then the float, up to what the pots hold. Final on the first call: a loss_settled record blocks any later payout for the job. */
export function payoutLoss(
  entries: readonly Entry[],
  jobId: string,
  lossCents: number,
  at: string,
): PayoutResult {
  assertCents(lossCents);
  if (find(entries, 'loss_settled', jobId)) {
    const paid = Math.min(
      lossCents,
      entries
        .filter((e) => e.type === 'loss_payout' && e.jobId === jobId)
        .reduce((sum, e) => sum + e.cents, 0),
    );
    return { entries: entries as Entry[], paidCents: paid, shortfallCents: lossCents - paid };
  }
  const { float, deposit } = pots(entries);
  const fromDeposit = Math.min(lossCents, deposit);
  const fromFloat = Math.min(lossCents - fromDeposit, float);
  const appended: Entry[] = [];
  if (fromDeposit > 0) appended.push({ type: 'loss_payout', cents: fromDeposit, at, jobId, pot: 'deposit' });
  if (fromFloat > 0) appended.push({ type: 'loss_payout', cents: fromFloat, at, jobId, pot: 'float' });
  const paidCents = fromDeposit + fromFloat;
  appended.push({ type: 'loss_settled', cents: 0, at, jobId });
  return {
    entries: [...entries, ...appended],
    paidCents,
    shortfallCents: lossCents - paidCents,
  };
}
