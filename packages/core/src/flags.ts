export interface GpsPoint {
  lat: number;
  lng: number;
  /** ISO 8601 timestamp. Points with an unparseable value are ignored. */
  at: string;
}

/**
 * `late` is part of the type but routeFlags never returns it: it has no
 * deadline input, so there is nothing to compare `nowIso` against.
 */
export type Flag = 'off_route' | 'stalled' | 'late';

interface LatLng {
  lat: number;
  lng: number;
}

/** Placeholder thresholds set by the owner; to be tuned with pilot data. */
export const OFF_ROUTE_KM = 1.5;
export const STALLED_MINUTES = 10;
export const STALLED_METERS = 20;

const EARTH_RADIUS_KM = 6371;
const MS_PER_MINUTE = 60_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

const isValid = (p: LatLng): boolean =>
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  p.lat >= -90 &&
  p.lat <= 90 &&
  p.lng >= -180 &&
  p.lng <= 180;

/** Great-circle distance in km (haversine). */
function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Shortest distance in km from p to the segment a-b. Uses an equirectangular
 * projection centred on p (accurate to well under 1% at city scale), then
 * measures the projected foot point with haversine.
 */
function segmentDistanceKm(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = Math.cos(toRad(p.lat));
  const ax = (a.lng - p.lng) * kx;
  const ay = a.lat - p.lat;
  const dx = (b.lng - a.lng) * kx;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const foot = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
  return haversineKm(p, foot);
}

function distanceToRouteKm(p: LatLng, stops: LatLng[]): number {
  const [first] = stops;
  if (first === undefined) return Infinity;
  if (stops.length === 1) return haversineKm(p, first);
  let best = Infinity;
  stops.slice(1).forEach((b, i) => {
    best = Math.min(best, segmentDistanceKm(p, stops[i] ?? first, b));
  });
  return best;
}

interface TimedPoint extends LatLng {
  time: number;
}

/** True when some stretch of at least STALLED_MINUTES stays within STALLED_METERS of its first point. */
function hasStall(points: TimedPoint[]): boolean {
  return points.some((start, i) => {
    for (const next of points.slice(i + 1)) {
      if (haversineKm(start, next) * 1000 >= STALLED_METERS) return false;
      if (next.time - start.time >= STALLED_MINUTES * MS_PER_MINUTE) return true;
    }
    return false;
  });
}

/**
 * Flags for a rider's GPS trail against the planned stops. Pure: the trail is
 * copied before sorting. Invalid coordinates and unparseable times are
 * ignored. Each flag appears at most once, ordered off_route, stalled, late.
 * `nowIso` is accepted for the contract but unused until a deadline input
 * exists (see Flag).
 */
export function routeFlags(trail: GpsPoint[], plannedStops: LatLng[], _nowIso: string): Flag[] {
  const points: TimedPoint[] = trail
    .map((p) => ({ lat: p.lat, lng: p.lng, time: Date.parse(p.at) }))
    .filter((p) => isValid(p) && !Number.isNaN(p.time))
    .sort((a, b) => a.time - b.time);
  const stops = plannedStops.filter(isValid);

  const flags: Flag[] = [];
  if (stops.length > 0 && points.some((p) => distanceToRouteKm(p, stops) > OFF_ROUTE_KM)) {
    flags.push('off_route');
  }
  if (hasStall(points)) flags.push('stalled');
  return flags;
}
