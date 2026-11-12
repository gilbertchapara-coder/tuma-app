import { afterEach, describe, expect, it } from 'vitest';
import { SUBURBS } from '../src/suburbs';
import {
  UnknownSuburbError,
  priceCents,
  type ServiceLevel,
} from '../src/pricing';

const TABLE: Record<string, [number, number, number]> = {
  Avenues: [200, 120, 100],
  'Milton Park': [200, 120, 100],
  Mbare: [200, 130, 110],
  Avondale: [250, 150, 120],
  Workington: [250, 150, 120],
  'Houghton Park': [300, 180, 150],
  Waterfalls: [350, 200, 170],
  Plymouth: [350, 200, 170],
};
const LEVELS: ServiceLevel[] = ['express', 'standard', 'overnight'];

describe('priceCents', () => {
  it('spot checks', () => {
    expect(priceCents('Avenues', 'express')).toBe(200);
    expect(priceCents('Waterfalls', 'standard')).toBe(200);
    expect(priceCents('Houghton Park', 'overnight')).toBe(150);
  });

  it('returns the table value for all 8 suburbs and 3 levels', () => {
    expect(Object.keys(TABLE)).toHaveLength(8);
    for (const [suburb, row] of Object.entries(TABLE)) {
      LEVELS.forEach((level, i) => expect(priceCents(suburb, level)).toBe(row[i]));
    }
  });

  it('throws UnknownSuburbError for unknown suburbs', () => {
    expect(() => priceCents('Borrowdale', 'express')).toThrow(UnknownSuburbError);
  });

  it('ignores case and extra spaces', () => {
    expect(priceCents('  houghton   PARK ', 'express')).toBe(300);
    expect(priceCents('AVENUES', 'standard')).toBe(120);
  });
});

describe('SUBURBS', () => {
  it('assigns runs', () => {
    expect(SUBURBS['Avondale']?.run).toBe('north');
    expect(SUBURBS['Mbare']?.run).toBe('southwest');
    expect(SUBURBS['Plymouth']?.run).toBe('south');
  });
});

