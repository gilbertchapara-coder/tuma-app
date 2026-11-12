import { COUNTRIES, findSuburbEntryFor, priceCentsFor, UnknownSuburbError } from './countries';
import type { Run, Suburb } from './suburbs';

export type { Run };
export { UnknownSuburbError };
export type ServiceLevel = 'express' | 'standard' | 'overnight';

/**
 * Zimbabwe lookups, kept for code that has no country yet. Anything country-aware uses
 * findSuburbEntryFor / priceCentsFor from ./countries with the user's country.
 */
export function findSuburbEntry(name: string): { name: string; suburb: Suburb } {
  return findSuburbEntryFor(COUNTRIES.ZW, name);
}

export function findSuburb(name: string): Suburb {
  return findSuburbEntry(name).suburb;
}

export function priceCents(suburb: string, level: ServiceLevel): number {
  return priceCentsFor(COUNTRIES.ZW, suburb, level);
}
