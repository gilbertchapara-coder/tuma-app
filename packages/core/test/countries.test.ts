import { describe, expect, it } from 'vitest';
import {
  COUNTRIES,
  countryFromPhone,
  formatMoney,
  getCountry,
  isCountryConfigured,
  percentFeeCents,
  priceCentsFor,
  findSuburbEntryFor,
  withOverrides,
} from '../src/countries';

describe('countryFromPhone', () => {
  it('reads the country from the dial code', () => {
    expect(countryFromPhone('+263771234567')).toBe('ZW');
    expect(countryFromPhone('+260971234567')).toBe('ZM');
  });
  it('returns null for an unsupported or malformed number', () => {
    expect(countryFromPhone('+27821234567')).toBeNull();
    expect(countryFromPhone('0771234567')).toBeNull();
  });
});

describe('country registry', () => {
  it('keeps Zimbabwe on the locked USD table', () => {
    const zw = getCountry('ZW');
    expect(zw.currency).toBe('USD');
    expect(priceCentsFor(zw, 'Mbare', 'standard')).toBe(130);
    expect(isCountryConfigured(zw)).toBe(true);
  });
  it('does not invent a Zambia price table', () => {
    const zm = getCountry('ZM');
    expect(zm.currency).toBe('ZMW');
    expect(isCountryConfigured(zm)).toBe(false);
    expect(() => findSuburbEntryFor(zm, 'Kabulonga')).toThrow(/Unknown suburb/);
  });
  it('has no Tuma percentage until the owner sets one', () => {
    expect(COUNTRIES.ZW.platformBps).toBeNull();
    expect(COUNTRIES.ZM.platformBps).toBeNull();
  });
  it('applies owner overrides without touching the registry', () => {
    const zm = withOverrides(getCountry('ZM'), {
      suburbs: { Kabulonga: { band: 'A', run: 'north' } },
      prices: { A: [3000, 2000, 1500] },
      platformBps: 1000,
    });
    expect(isCountryConfigured(zm)).toBe(true);
    expect(priceCentsFor(zm, 'kabulonga', 'express')).toBe(3000);
    expect(zm.platformBps).toBe(1000);
    expect(COUNTRIES.ZM.platformBps).toBeNull();
  });
});

describe('percentFeeCents', () => {
  it('is zero when no percentage is set', () => {
    expect(percentFeeCents(130, null)).toBe(0);
  });
  it('takes basis points of the run price, rounded to a whole cent', () => {
    expect(percentFeeCents(1000, 1000)).toBe(100);
    expect(percentFeeCents(130, 1000)).toBe(13);
    expect(percentFeeCents(125, 1000)).toBe(13);
  });
  it('rejects a percentage outside 0 to 100 percent', () => {
    expect(() => percentFeeCents(100, -1)).toThrow();
    expect(() => percentFeeCents(100, 10001)).toThrow();
  });
});

describe('formatMoney', () => {
  it('uses the country currency', () => {
    expect(formatMoney(getCountry('ZW'), 130)).toBe('$1.30');
    expect(formatMoney(getCountry('ZM'), 1250)).toBe('K12.50');
  });
});
