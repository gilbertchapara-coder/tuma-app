import { SUBURBS, type Run, type Suburb } from './suburbs';

export type { Run };
export type ServiceLevel = 'express' | 'standard' | 'overnight';

export class UnknownSuburbError extends Error {
  constructor(suburb: string) {
    super(`Unknown suburb: ${suburb}`);
    this.name = 'UnknownSuburbError';
  }
}

/** Price table in integer cents: [express, standard, overnight] per band. */
const PRICES_BY_BAND: Record<string, readonly [number, number, number]> = {
  '2 km': [200, 120, 100],
  '3 km': [200, 130, 110],
  '4 to 5 km': [250, 150, 120],
  '6 to 7 km': [300, 180, 150],
  '8 to 10 km': [350, 200, 170],
};

const LEVEL_INDEX: Record<ServiceLevel, 0 | 1 | 2> = {
  express: 0,
  standard: 1,
  overnight: 2,
};

const DEFAULT_FEE_CENTS = 25;

const normalise = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Case-insensitive lookup returning the canonical suburb name and its entry. */
export function findSuburbEntry(name: string): { name: string; suburb: Suburb } {
  const key = normalise(name);
  for (const [canonical, info] of Object.entries(SUBURBS)) {
    if (normalise(canonical) === key) return { name: canonical, suburb: info };
  }
  throw new UnknownSuburbError(name);
}

export function findSuburb(name: string): Suburb {
  return findSuburbEntry(name).suburb;
}

export function priceCents(suburb: string, level: ServiceLevel): number {
  const { band } = findSuburb(suburb);
  const row = PRICES_BY_BAND[band];
  if (!row) throw new Error(`No price row for band: ${band}`);
  return row[LEVEL_INDEX[level]];
}

export function platformFeeCents(): number {
  const raw = process.env.PLATFORM_FEE_CENTS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_FEE_CENTS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_FEE_CENTS;
}
