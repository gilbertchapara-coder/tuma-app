import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from './errors';
import type { CodeNotifier, OtpProvider } from './ports';

/**
 * TEST ONLY. A stand-in for SMS that holds the latest code for a short allow-list of phones
 * so a scripted test can read it. Any other phone is refused like the real "no provider" case.
 * It is wired in only when SMOKE_TEST_KEY and SMOKE_TEST_PHONES are both set.
 */
export interface SmokeTestSms {
  otp: OtpProvider;
  notifier: CodeNotifier;
  peek(phone: string): string | undefined;
}

export function createSmokeTestSms(phones: readonly string[]): SmokeTestSms {
  const allowed = new Set(phones);
  const latest = new Map<string, string>();
  const store = async (phone: string, code: string): Promise<void> => {
    if (!allowed.has(phone)) throw new Error('No SMS provider configured');
    latest.set(phone, code);
  };
  return {
    otp: { send: store },
    notifier: { sendDeliveryCode: store },
    peek: (phone) => (allowed.has(phone) ? latest.get(phone) : undefined),
  };
}

export const MIN_SMOKE_KEY_LENGTH = 24;

const sameKey = (given: unknown, expected: string): boolean => {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export interface SmokeTestOptions {
  key: string;
  sms: SmokeTestSms;
}

/** GET /smoke-test/code/:phone with header x-smoke-key. Any failure is a plain 404. */
export const smokeTestRoutes =
  (opts: SmokeTestOptions): FastifyPluginAsync =>
  async (app) => {
    if (opts.key.length < MIN_SMOKE_KEY_LENGTH) {
      throw new Error(`SMOKE_TEST_KEY must be at least ${MIN_SMOKE_KEY_LENGTH} characters`);
    }
    app.get<{ Params: { phone: string } }>('/smoke-test/code/:phone', async (req) => {
      const code = sameKey(req.headers['x-smoke-key'], opts.key) ? opts.sms.peek(req.params.phone) : undefined;
      if (!code) throw new HttpError(404, 'not_found', 'Not found');
      return { code };
    });
  };
