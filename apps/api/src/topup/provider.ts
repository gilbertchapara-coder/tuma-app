/**
 * Moves money from a rider's mobile wallet into Tuma. A real provider (EcoCash or similar) is a later task
 * and is blocked on the licensing decision in the spec (section 7).
 */
export interface TopupProvider {
  /** Ask the rider's wallet to pay `cents`. Returns a reference to check later. Throws if the service is down. */
  requestTopup(phone: string, cents: number): Promise<{ ref: string }>;
  /** True once the wallet payment for `ref` has gone through. */
  confirmed(ref: string): Promise<boolean>;
}

/** Pilot placeholders: keep float small while the model is being proven. */
export const DEFAULT_TOPUP_MAX_SINGLE_CENTS = 2000;
export const DEFAULT_TOPUP_MAX_BALANCE_CENTS = 5000;

/** Used until a real wallet provider is wired in: top-ups fail with a plain error and nothing is credited. */
export const noWalletProvider: TopupProvider = {
  async requestTopup(): Promise<{ ref: string }> {
    throw new Error('No wallet provider configured');
  },
  async confirmed(): Promise<boolean> {
    return false;
  },
};
