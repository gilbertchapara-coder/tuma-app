/**
 * The licensed partner (mobile money provider or financial institution) that actually holds and lends the money.
 * Tuma never holds loan money. Until a partner is connected, every request answers "not available yet".
 */
export interface PartnerDecision {
  /** The partner's own reference for the loan. */
  ref: string;
  status: 'approved' | 'declined';
  /** Fee in basis points the partner charges on the principal. */
  feeBps: number;
  /** Days until repayment is due. */
  termDays: number;
}

export interface LendingPartner {
  readonly connected: boolean;
  /** Fee the partner will charge, shown before the person asks. */
  quote(principalCents: number): { feeBps: number; termDays: number };
  request(input: { loanId: string; userId: string; phone: string; principalCents: number }): Promise<PartnerDecision>;
}

export const noLendingPartner: LendingPartner = {
  connected: false,
  quote: () => ({ feeBps: 0, termDays: 0 }),
  async request() {
    throw new Error('No lending partner connected');
  },
};
