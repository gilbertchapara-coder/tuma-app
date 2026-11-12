import { COUNTRIES, findSuburbEntryFor, type CountryConfig } from './countries';
import type { Run, ServiceLevel } from './pricing';

export interface BookedParcel {
  id: string;
  suburb: string;
  level: ServiceLevel;
  /** ISO 8601 timestamp. An unparseable value makes bundleRuns throw InvalidDateError. */
  bookedAt: string;
}

export interface Bundle {
  run: Run;
  level: 'standard' | 'overnight';
  parcelIds: string[];
  /** Distinct suburbs, nearest to the CBD first. */
  dropOrder: string[];
}

/** Distance rank of a band label ("2 km", "4 to 5 km"): its lower bound in km. */
const bandDistance = (band: string): number => Number.parseFloat(band);

export class InvalidDateError extends Error {
  constructor(field: 'bookedAt' | 'cutoffAt', value: string) {
    super(`Invalid ${field} (expected ISO 8601): ${JSON.stringify(value)}`);
    this.name = 'InvalidDateError';
  }
}

function parseDate(field: 'bookedAt' | 'cutoffAt', value: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new InvalidDateError(field, value);
  return time;
}

type PoolLevel = Bundle['level'];

const LEVEL_ORDER: Record<PoolLevel, number> = { standard: 0, overnight: 1 };
const RUN_ORDER: Record<Run, number> = { north: 0, south: 1, southwest: 2 };

/**
 * Groups standard and overnight parcels booked at or before `cutoffAt` into
 * bundles by (run, level). Express parcels never pool. Pure: inputs are not mutated.
 * `cutoffAt` and every `bookedAt` must be ISO 8601; all dates are validated before
 * grouping, and an unparseable one throws InvalidDateError (no partial result).
 */
export function bundleRuns(parcels: BookedParcel[], cutoffAt: string, country: CountryConfig = COUNTRIES.ZW): Bundle[] {
  const cutoff = parseDate('cutoffAt', cutoffAt);
  const bookedTimes = parcels.map((parcel) => parseDate('bookedAt', parcel.bookedAt));
  const groups = new Map<string, { run: Run; level: PoolLevel; ids: string[]; drops: Map<string, number> }>();

  for (const [index, parcel] of parcels.entries()) {
    if (parcel.level === 'express') continue;
    if ((bookedTimes[index] as number) > cutoff) continue;
    const { name, suburb } = findSuburbEntryFor(country, parcel.suburb);
    const key = `${suburb.run}|${parcel.level}`;
    let group = groups.get(key);
    if (!group) {
      group = { run: suburb.run, level: parcel.level, ids: [], drops: new Map() };
      groups.set(key, group);
    }
    group.ids.push(parcel.id);
    group.drops.set(name, bandDistance(suburb.band));
  }

  return [...groups.values()]
    .map((g) => ({
      run: g.run,
      level: g.level,
      parcelIds: g.ids,
      dropOrder: [...g.drops.entries()]
        .sort(([a, da], [b, db]) => da - db || a.localeCompare(b))
        .map(([name]) => name),
    }))
    .sort((a, b) => RUN_ORDER[a.run] - RUN_ORDER[b.run] || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
