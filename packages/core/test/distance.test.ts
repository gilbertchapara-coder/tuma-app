import { describe, expect, it } from 'vitest';
import { distanceExtraCents, distanceKm, FREE_KM, MAX_DISTANCE_EXTRA_CENTS } from '../src';

describe('distance', () => {
  it('is zero for the same point and about right for a known pair', () => {
    expect(distanceKm({ lat: -17.83, lng: 31.05 }, { lat: -17.83, lng: 31.05 })).toBe(0);
    // 0.1 degree of latitude is about 11.1 km
    expect(distanceKm({ lat: -17.8, lng: 31 }, { lat: -17.9, lng: 31 })).toBeCloseTo(11.1, 0);
  });
  it('charges nothing inside the free distance, then per km, capped', () => {
    expect(distanceExtraCents(FREE_KM)).toBe(0);
    expect(distanceExtraCents(FREE_KM + 0.1)).toBe(10);
    expect(distanceExtraCents(FREE_KM + 3)).toBe(30);
    expect(distanceExtraCents(500)).toBe(MAX_DISTANCE_EXTRA_CENTS);
    expect(distanceExtraCents(Number.NaN)).toBe(0);
  });
});
