import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export interface CodeRecord {
  hash: string;
  salt: string;
  failedAttempts: number;
  used: boolean;
  locked: boolean;
}

export const MAX_CODE_ATTEMPTS = 3;
const CODE_LENGTH = 6;
const CODE_PATTERN = /^[0-9]{6}$/;

function hashCode(salt: string, code: string): Buffer {
  return createHash('sha256').update(`${salt}:${code}`, 'utf8').digest();
}

export function issueCode(): { code: string; record: CodeRecord } {
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  const salt = randomBytes(16).toString('hex');
  return {
    code,
    record: {
      hash: hashCode(salt, code).toString('hex'),
      salt,
      failedAttempts: 0,
      used: false,
      locked: false,
    },
  };
}

export function checkCode(record: CodeRecord, input: string): { ok: boolean; record: CodeRecord } {
  if (record.used || record.locked) return { ok: false, record: { ...record } };

  // Hash even malformed input so every attempt does the same work; malformed never matches.
  const text = typeof input === 'string' ? input : '';
  const expected = Buffer.from(record.hash, 'hex');
  const actual = hashCode(record.salt, text);
  const matches =
    CODE_PATTERN.test(text) && expected.length === actual.length && timingSafeEqual(expected, actual);

  if (matches) return { ok: true, record: { ...record, used: true } };

  const failedAttempts = record.failedAttempts + 1;
  return {
    ok: false,
    record: { ...record, failedAttempts, locked: failedAttempts >= MAX_CODE_ATTEMPTS },
  };
}
