/**
 * Dispatch rules for the direction board.
 * fixed:    today's behaviour, the table price, riders accept a run.
 * first:    the sender's price is fixed, the first rider to put it in the cart wins.
 * cheapest: the sender sets the most they will pay, the lowest ask wins.
 * Being in a cart never guarantees the parcel; only pickWinner decides.
 */
export type DispatchMode = 'fixed' | 'first' | 'cheapest';

export interface Offer {
  riderId: string;
  askCents: number;
  /** ISO time the rider put the parcel in their cart. */
  at: string;
}

/** Lowest ask a rider may make, in cents. Owner placeholder. */
export const MIN_ASK_CENTS = 50;

export interface AskLimits {
  floorCents: number;
  ceilingCents: number;
}

/** Limits for a rider's ask. The ceiling is the sender's maximum (or the table price). */
export function askLimits(ceilingCents: number): AskLimits {
  return { floorCents: Math.min(MIN_ASK_CENTS, ceilingCents), ceilingCents };
}

export function isValidAsk(mode: DispatchMode, askCents: number, ceilingCents: number): boolean {
  if (!Number.isInteger(askCents) || !Number.isInteger(ceilingCents) || ceilingCents <= 0) return false;
  if (mode !== 'cheapest') return askCents === ceilingCents; // first and fixed: the price is the price
  const { floorCents } = askLimits(ceilingCents);
  return askCents >= floorCents && askCents <= ceilingCents;
}

const time = (o: Offer): number => Date.parse(o.at);

/** The winning offer, or null when there is none. Ties go to the earlier offer, then to the smaller rider id. */
export function pickWinner(mode: DispatchMode, offers: readonly Offer[]): Offer | null {
  const usable = offers.filter((o) => Number.isFinite(time(o)) && Number.isInteger(o.askCents) && o.askCents > 0);
  if (usable.length === 0) return null;
  const byTime = (a: Offer, b: Offer) => time(a) - time(b) || a.riderId.localeCompare(b.riderId);
  const order = mode === 'cheapest' ? (a: Offer, b: Offer) => a.askCents - b.askCents || byTime(a, b) : byTime;
  return [...usable].sort(order)[0] ?? null;
}

/** True when the rider holds a place in the cart for this parcel but has not won it. */
export function isWaiting(offers: readonly Offer[], riderId: string, winner: Offer | null): boolean {
  return winner?.riderId !== riderId && offers.some((o) => o.riderId === riderId);
}
