import { SUBURBS, type Suburb } from './suburbs';
import type { ServiceLevel } from './pricing';

export type CountryCode = 'ZW' | 'ZM';

/** [express, standard, overnight] in the smallest money unit (cents, ngwee). */
export type PriceRow = readonly [number, number, number];

export interface CountryConfig {
  code: CountryCode;
  name: string;
  /** International prefix including the plus sign. */
  dialCode: string;
  currency: string;
  currencySymbol: string;
  /** IANA zone, used for what counts as today. */
  timezone: string;
  suburbs: Readonly<Record<string, Suburb>>;
  prices: Readonly<Record<string, PriceRow>>;
  /**
   * Tuma's share of each run price, in basis points (1000 = 10%). Null until the owner sets it.
   * The value is deliberately not in code: it differs per country and is set by the owner.
   */
  platformBps: number | null;
}

const LEVEL_INDEX: Record<ServiceLevel, 0 | 1 | 2> = { express: 0, standard: 1, overnight: 2 };

const ZW_PRICES: Record<string, PriceRow> = {
  '2 km': [200, 120, 100],
  '3 km': [200, 130, 110],
  '4 to 5 km': [250, 150, 120],
  '6 to 7 km': [300, 180, 150],
  '8 to 10 km': [350, 200, 170],
};

/**
 * Launch countries. Zambia has NO suburbs or prices here on purpose: the owner has not supplied them,
 * and they must never be invented. They are loaded from the country settings (see withOverrides).
 */
export const COUNTRIES: Readonly<Record<CountryCode, CountryConfig>> = {
  ZW: {
    code: 'ZW',
    name: 'Zimbabwe',
    dialCode: '+263',
    currency: 'USD',
    currencySymbol: '$',
    timezone: 'Africa/Harare',
    suburbs: SUBURBS,
    prices: ZW_PRICES,
    platformBps: null,
  },
  ZM: {
    code: 'ZM',
    name: 'Zambia',
    dialCode: '+260',
    currency: 'ZMW',
    currencySymbol: 'K',
    timezone: 'Africa/Lusaka',
    suburbs: {},
    prices: {},
    platformBps: null,
  },
};

export const COUNTRY_CODES = Object.keys(COUNTRIES) as CountryCode[];

export const isCountryCode = (s: string): s is CountryCode => Object.prototype.hasOwnProperty.call(COUNTRIES, s);

export function getCountry(code: CountryCode): CountryConfig {
  return COUNTRIES[code];
}

/** The country a phone number belongs to, from its dial code. Null when the country is not supported. */
export function countryFromPhone(phone: string): CountryCode | null {
  const hit = COUNTRY_CODES.map((c) => COUNTRIES[c]).find((c) => phone.startsWith(c.dialCode));
  return hit ? hit.code : null;
}

export type CountryOverrides = Partial<Pick<CountryConfig, 'suburbs' | 'prices' | 'platformBps'>>;

/** A copy of a country with the owner's settings laid over it. The registry is never changed. */
export function withOverrides(base: CountryConfig, o: CountryOverrides): CountryConfig {
  return {
    ...base,
    suburbs: o.suburbs ?? base.suburbs,
    prices: o.prices ?? base.prices,
    platformBps: o.platformBps === undefined ? base.platformBps : o.platformBps,
  };
}

/** A country can take bookings only once it has at least one suburb and a price row for every band in use. */
export function isCountryConfigured(c: CountryConfig): boolean {
  const entries = Object.values(c.suburbs);
  return entries.length > 0 && entries.every((s) => c.prices[s.band] !== undefined);
}

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

export class UnknownSuburbError extends Error {
  constructor(suburb: string) {
    super(`Unknown suburb: ${suburb}`);
    this.name = 'UnknownSuburbError';
  }
}

export function findSuburbEntryFor(c: CountryConfig, name: string): { name: string; suburb: Suburb } {
  const key = norm(name);
  for (const [canonical, info] of Object.entries(c.suburbs)) {
    if (norm(canonical) === key) return { name: canonical, suburb: info };
  }
  throw new UnknownSuburbError(name);
}

export function priceCentsFor(c: CountryConfig, suburb: string, level: ServiceLevel): number {
  const { band } = findSuburbEntryFor(c, suburb).suburb;
  const row = c.prices[band];
  if (!row) throw new Error(`No price row for band: ${band}`);
  return row[LEVEL_INDEX[level]];
}

/** Tuma's share of a run price in whole cents. Zero when no percentage is set. */
export function percentFeeCents(totalCents: number, bps: number | null): number {
  if (bps === null) return 0;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError(`Percentage must be 0 to 10000 basis points: ${bps}`);
  return Math.round((totalCents * bps) / 10_000);
}

export function formatMoney(c: Pick<CountryConfig, 'currencySymbol'>, cents: number): string {
  return `${c.currencySymbol}${(cents / 100).toFixed(2)}`;
}
