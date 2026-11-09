import { describe, expect, it } from 'vitest';
import { bundleRuns, InvalidDateError, type BookedParcel } from '../src/batching';
import { UnknownSuburbError } from '../src/pricing';

const CUTOFF = '2026-11-10T12:00:00Z';
const before = '2026-11-10T08:00:00Z';
const after = '2026-11-10T13:00:00Z';

const p = (
  id: string,
  suburb: string,
  level: BookedParcel['level'] = 'standard',
  bookedAt = before,
): BookedParcel => ({ id, suburb, level, bookedAt });

describe('bundleRuns', () => {
  it('returns [] for an empty list', () => {
    expect(bundleRuns([], CUTOFF)).toEqual([]);
  });

  it('never bundles express parcels', () => {
    expect(bundleRuns([p('a', 'Mbare', 'express')], CUTOFF)).toEqual([]);
  });

  it('bundles southwest standard parcels, nearest suburb first', () => {
    const out = bundleRuns(
      [p('a', 'Houghton Park'), p('b', 'Mbare'), p('c', 'Houghton Park')],
      CUTOFF,
    );
    expect(out).toEqual([
      { run: 'southwest', level: 'standard', parcelIds: ['a', 'b', 'c'], dropOrder: ['Mbare', 'Houghton Park'] },
    ]);
  });

  it('excludes parcels booked after the cutoff', () => {
    const out = bundleRuns([p('a', 'Mbare'), p('b', 'Mbare', 'standard', after)], CUTOFF);
    expect(out[0]?.parcelIds).toEqual(['a']);
  });

  it('includes a parcel booked exactly at the cutoff', () => {
    const out = bundleRuns([p('a', 'Mbare', 'standard', CUTOFF)], CUTOFF);
    expect(out[0]?.parcelIds).toEqual(['a']);
  });

  it('keeps standard and overnight in separate bundles', () => {
    const out = bundleRuns([p('a', 'Mbare'), p('b', 'Mbare', 'overnight')], CUTOFF);
    expect(out.map((b) => [b.level, b.parcelIds])).toEqual([
      ['standard', ['a']],
      ['overnight', ['b']],
    ]);
  });

  it('splits north and south runs and sorts by run then level', () => {
    const out = bundleRuns([p('a', 'Waterfalls'), p('b', 'Avenues'), p('c', 'Mbare')], CUTOFF);
    expect(out.map((b) => b.run)).toEqual(['north', 'south', 'southwest']);
  });

  it('breaks same-band ties alphabetically and dedupes case-insensitively', () => {
    const out = bundleRuns([p('a', 'milton park'), p('b', 'Avenues'), p('c', 'Avenues')], CUTOFF);
    expect(out[0]?.dropOrder).toEqual(['Avenues', 'Milton Park']);
  });

  it('throws UnknownSuburbError for an unknown suburb', () => {
    expect(() => bundleRuns([p('a', 'Atlantis')], CUTOFF)).toThrow(UnknownSuburbError);
  });

  it('does not mutate its input', () => {
    const input = [p('a', 'Mbare'), p('b', 'Avenues')];
    const copy = structuredClone(input);
    bundleRuns(input, CUTOFF);
    expect(input).toEqual(copy);
  });

  it('throws InvalidDateError for an unparseable bookedAt, even on a later parcel', () => {
    const input = [p('a', 'Mbare'), p('b', 'Avenues', 'standard', 'not-a-date')];
    expect(() => bundleRuns(input, CUTOFF)).toThrow(InvalidDateError);
    expect(() => bundleRuns(input, CUTOFF)).toThrow(/bookedAt.*not-a-date/);
  });

  it('throws InvalidDateError for an unparseable bookedAt on an express parcel', () => {
    expect(() => bundleRuns([p('a', 'Mbare', 'express', '')], CUTOFF)).toThrow(InvalidDateError);
  });

  it('throws InvalidDateError for an unparseable cutoffAt', () => {
    expect(() => bundleRuns([p('a', 'Mbare')], 'tomorrow-ish')).toThrow(InvalidDateError);
    expect(() => bundleRuns([p('a', 'Mbare')], 'tomorrow-ish')).toThrow(/cutoffAt.*tomorrow-ish/);
  });

  it('skips a late valid parcel and an express parcel without error', () => {
    const out = bundleRuns(
      [p('a', 'Mbare'), p('b', 'Mbare', 'standard', after), p('c', 'Mbare', 'express')],
      CUTOFF,
    );
    expect(out).toEqual([
      { run: 'southwest', level: 'standard', parcelIds: ['a'], dropOrder: ['Mbare'] },
    ]);
  });
});
