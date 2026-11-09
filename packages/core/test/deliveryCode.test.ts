import { describe, expect, it, vi } from 'vitest';

const forced = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomInt: ((...args: unknown[]) =>
      forced.value ?? (actual.randomInt as (...a: unknown[]) => number)(...args)) as typeof actual.randomInt,
  };
});

import { MAX_CODE_ATTEMPTS, checkCode, issueCode, type CodeRecord } from '../src/deliveryCode';

describe('issueCode', () => {
  it('issues a 6-digit code and never stores it in the record', () => {
    for (let i = 0; i < 50; i++) {
      const { code, record } = issueCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(JSON.stringify(record)).not.toContain(code);
      expect(record).toMatchObject({ failedAttempts: 0, used: false, locked: false });
    }
  });
  it('uses a fresh salt per code', () => {
    expect(issueCode().record.salt).not.toBe(issueCode().record.salt);
  });
  it('exposes the attempt limit as 3', () => {
    expect(MAX_CODE_ATTEMPTS).toBe(3);
  });
});

describe('checkCode', () => {
  it('accepts the correct code and marks it used', () => {
    const { code, record } = issueCode();
    const r = checkCode(record, code);
    expect(r.ok).toBe(true);
    expect(r.record.used).toBe(true);
  });
  it('rejects reuse of a used code', () => {
    const { code, record } = issueCode();
    const used = checkCode(record, code).record;
    expect(checkCode(used, code).ok).toBe(false);
  });
  it('locks after 3 wrong attempts and then rejects the correct code', () => {
    const { code, record } = issueCode();
    const wrong = code === '111111' ? '222222' : '111111';
    let r = checkCode(record, wrong);
    expect(r.record.failedAttempts).toBe(1);
    r = checkCode(r.record, wrong);
    expect(r.record.locked).toBe(false);
    r = checkCode(r.record, wrong);
    expect(r.record.locked).toBe(true);
    const after = checkCode(r.record, code);
    expect(after.ok).toBe(false);
    expect(after.record.used).toBe(false);
  });
  it('does not mutate the old record', () => {
    const { code, record } = issueCode();
    const snap = { ...record };
    checkCode(record, code === '111111' ? '222222' : '111111');
    checkCode(record, code);
    expect(record).toEqual(snap);
  });
  it('counts wrong-length or non-digit input as a wrong attempt without throwing', () => {
    const { record } = issueCode();
    for (const bad of ['', '123', '1234567', 'abcdef', '12 456', '１２３４５６', 'é'.repeat(6)]) {
      const r = checkCode(record, bad);
      expect(r.ok).toBe(false);
      expect(r.record.failedAttempts).toBe(1);
    }
    expect(() => checkCode(record, undefined as unknown as string)).not.toThrow();
  });
  it('zero-pads to 6 digits (000123 is possible)', () => {
    forced.value = 123;
    const { code, record } = issueCode();
    forced.value = undefined;
    expect(code).toBe('000123');
    expect(checkCode(record, '000123').ok).toBe(true);
  });
});
