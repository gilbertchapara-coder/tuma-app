import type { TopupProvider } from './provider';

/** Test and local stand-in. Records requests; confirms at once unless told not to. */
export class FakeTopupProvider implements TopupProvider {
  readonly requests: Array<{ phone: string; cents: number; ref: string }> = [];
  autoConfirm = true;
  failNext = false;
  private readonly paid = new Set<string>();
  private counter = 0;

  async requestTopup(phone: string, cents: number): Promise<{ ref: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider down');
    }
    const ref = `fake-${(this.counter += 1)}`;
    this.requests.push({ phone, cents, ref });
    if (this.autoConfirm) this.paid.add(ref);
    return { ref };
  }

  async confirmed(ref: string): Promise<boolean> {
    return this.paid.has(ref);
  }

  /** Mark a pending payment as paid. */
  confirm(ref: string): void {
    this.paid.add(ref);
  }
}
