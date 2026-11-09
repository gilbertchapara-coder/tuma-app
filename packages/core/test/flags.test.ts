import { describe, expect, it } from 'vitest';
import {
  OFF_ROUTE_KM,
  STALLED_METERS,
  MAX_GPS_GAP_MS,
  STALLED_MINUTES,
  routeFlags,
  type GpsPoint,
} from '../src/flags';

const CBD = { lat: -17.8292, lng: 31.0522 };
const WATERFALLS = { lat: -17.9, lng: 31.0 };
const NOW = '2026-11-10T10:00:00Z';
const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 8, min)).toISOString();
const pt = (lat: number, lng: number, min: number): GpsPoint => ({ lat, lng, at: at(min) });
const minutes = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const mid = { lat: (CBD.lat + WATERFALLS.lat) / 2, lng: (CBD.lng + WATERFALLS.lng) / 2 };

describe('constants', () => {
  it('exports the placeholder thresholds', () => {
    expect(OFF_ROUTE_KM).toBe(1.5);
    expect(STALLED_MINUTES).toBe(10);
    expect(STALLED_METERS).toBe(20);
    expect(MAX_GPS_GAP_MS).toBe(3 * 60_000);
  });
});

describe('routeFlags', () => {
  const stops = [CBD, WATERFALLS];

  it('returns [] for a trail on the planned line', () => {
    const trail = [pt(CBD.lat, CBD.lng, 0), pt(mid.lat, mid.lng, 10), pt(WATERFALLS.lat, WATERFALLS.lng, 20)];
    expect(routeFlags(trail, stops, NOW)).toEqual([]);
  });

  it('flags a point 2 km off the line as off_route', () => {
    // ~2.2 km east of the midpoint (0.02 deg lng at this latitude is ~2.1 km)
    const trail = [pt(CBD.lat, CBD.lng, 0), pt(mid.lat, mid.lng + 0.02, 10)];
    expect(routeFlags(trail, stops, NOW)).toEqual(['off_route']);
  });

  it('uses segment distance, not distance to stop points', () => {
    // midpoint is ~4 km from both stops but on the line
    expect(routeFlags([pt(mid.lat, mid.lng, 0)], stops, NOW)).toEqual([]);
  });

  it('uses distance to the stop when only one stop is planned', () => {
    expect(routeFlags([pt(CBD.lat + 0.005, CBD.lng, 0)], [CBD], NOW)).toEqual([]);
    expect(routeFlags([pt(CBD.lat + 0.03, CBD.lng, 0)], [CBD], NOW)).toEqual(['off_route']);
  });

  it('never returns off_route with no planned stops', () => {
    expect(routeFlags([pt(0, 0, 0)], [], NOW)).toEqual([]);
  });

  it('flags 12 minutes of near-identical points as stalled', () => {
    const trail = minutes(0, 12).map((m) => pt(CBD.lat + m * 1e-7, CBD.lng, m));
    expect(routeFlags(trail, stops, at(12))).toEqual(['stalled']);
  });

  it('does not flag a stop shorter than 10 minutes', () => {
    const trail = minutes(0, 9).map((m) => pt(CBD.lat, CBD.lng, m));
    expect(routeFlags(trail, stops, at(9))).toEqual([]);
  });

  it('does not flag 12 minutes when the rider keeps moving', () => {
    const trail = minutes(0, 12).map((m) => pt(CBD.lat - m * 0.0005, CBD.lng, m));
    expect(routeFlags(trail, stops, at(12))).toEqual([]);
  });

  it('returns [] for an empty trail without throwing', () => {
    expect(routeFlags([], stops, NOW)).toEqual([]);
  });

  it('sorts points by time before checking, without mutating the input', () => {
    const trail = [12, 3, 0, 8, 1, 5, 10, 2, 4, 6, 7, 9, 11].map((m) => pt(CBD.lat, CBD.lng, m));
    const copy = trail.map((p) => ({ ...p }));
    expect(routeFlags(trail, stops, at(12))).toEqual(['stalled']);
    expect(trail).toEqual(copy);
  });

  it('ignores invalid coordinates and unparseable times', () => {
    const trail = [
      pt(NaN, 31, 0),
      pt(95, 31, 1),
      pt(-17, 200, 2),
      { lat: CBD.lat, lng: CBD.lng, at: 'nonsense' },
      pt(CBD.lat, CBD.lng, 3),
    ];
    expect(routeFlags(trail, stops, NOW)).toEqual([]);
  });

  it('returns flags once each, in order off_route then stalled', () => {
    const far = mid.lng + 0.05;
    const trail = minutes(0, 18).map((m) => pt(mid.lat, far, m));
    expect(routeFlags(trail, stops, at(18))).toEqual(['off_route', 'stalled']);
  });

  describe('stall timing', () => {
    const still = (ms: number[]) => ms.map((m) => pt(CBD.lat, CBD.lng, m));

    it('flags a stall in progress (pings every minute for 12 minutes, now = last ping)', () => {
      expect(routeFlags(still(minutes(0, 12)), stops, at(12))).toEqual(['stalled']);
    });

    it('does not flag a stall that ended earlier (rider moved, now is later)', () => {
      const trail = [...still(minutes(0, 12)), ...minutes(13, 20).map((m) => pt(CBD.lat - (m - 12) * 0.0005, CBD.lng, m))];
      expect(routeFlags(trail, stops, at(20))).toEqual([]);
    });

    it('does not flag when now is 30 minutes after the last ping', () => {
      expect(routeFlags(still(minutes(0, 12)), stops, at(42))).toEqual([]);
    });

    it('does not treat a 15 minute GPS gap as a stall', () => {
      expect(routeFlags(still([0, 15]), stops, at(15))).toEqual([]);
    });

    it('resets the stretch at a gap (5 min still, 15 min gap, 5 min still)', () => {
      expect(routeFlags(still([...minutes(0, 5), ...minutes(20, 25)]), stops, at(25))).toEqual([]);
    });

    it('flags a stretch of exactly 10 minutes with pings every minute', () => {
      expect(routeFlags(still(minutes(0, 10)), stops, at(10))).toEqual(['stalled']);
    });

    it('accepts pings exactly MAX_GPS_GAP_MS apart', () => {
      expect(routeFlags(still([0, 3, 6, 9, 12]), stops, at(12))).toEqual(['stalled']);
      expect(MAX_GPS_GAP_MS).toBe(180_000);
    });

    it('does not throw and gives no stall flag for an unparseable nowIso', () => {
      expect(routeFlags(still(minutes(0, 12)), stops, 'not a date')).toEqual([]);
    });
  });
});
