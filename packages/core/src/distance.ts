export interface GeoPoint {
  lat: number;
  lng: number;
}

/** PLACEHOLDER numbers until the owner sets the real rule. Straight-line km, not road km. */
export const FREE_KM = 5;
export const EXTRA_CENTS_PER_KM = 10;
export const MAX_DISTANCE_EXTRA_CENTS = 300;

const EARTH_KM = 6371;
const rad = (d: number): number => (d * Math.PI) / 180;

/** Straight-line distance in km between two points (haversine), to 0.1 km. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_KM * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/** Extra charge for long trips: nothing inside FREE_KM, then a fixed amount per whole km, capped. */
export function distanceExtraCents(km: number): number {
  if (!Number.isFinite(km) || km <= FREE_KM) return 0;
  return Math.min(MAX_DISTANCE_EXTRA_CENTS, Math.ceil(km - FREE_KM) * EXTRA_CENTS_PER_KM);
}
