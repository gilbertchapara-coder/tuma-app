import type { CountryCode } from './countries';

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Coarse outlines of the countries Tuma serves, as [lng, lat] points. They are accurate to roughly 10 km, which is
 * enough to tell Harare from Lusaka. They are NOT survey borders: near a border, or outside both countries,
 * countryFromCoords answers null and the app keeps the country it already has.
 * The Zimbabwe and Zambia outlines share the Zambezi line, so the two never overlap.
 */
type Outline = ReadonlyArray<readonly [number, number]>;

const ZAMBEZI: Outline = [
  [25.26, -17.8],
  [25.85, -17.93],
  [27.3, -17.35],
  [28.2, -16.85],
  [28.76, -16.5],
  [28.85, -16.0],
  [30.4, -15.62],
];

const ZIMBABWE: Outline = [
  ...ZAMBEZI,
  [31.3, -16.0],
  [32.9, -16.7],
  [33.05, -17.35],
  [32.7, -18.5],
  [33.0, -19.5],
  [32.5, -21.3],
  [31.3, -22.4],
  [29.4, -22.2],
  [28.0, -21.55],
  [27.7, -20.5],
  [26.7, -19.5],
];

const ZAMBIA: Outline = [
  [23.5, -17.6],
  [22.0, -16.2],
  [22.0, -13.0],
  [23.9, -11.8],
  [24.0, -11.0],
  [25.0, -11.5],
  [27.0, -11.6],
  [28.4, -12.2],
  [29.0, -12.4],
  [29.0, -10.0],
  [28.6, -8.6],
  [30.0, -8.2],
  [31.2, -8.6],
  [32.9, -9.4],
  [33.3, -10.5],
  [33.0, -11.6],
  [33.2, -12.5],
  [33.7, -14.0],
  [32.8, -14.9],
  [32.7, -15.3],
  ...[...ZAMBEZI].reverse(),
  [25.0, -17.55],
  [24.3, -17.5],
];

/** Even-odd ray casting. */
function inside(p: LatLng, outline: Outline): boolean {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i, i += 1) {
    const [xi, yi] = outline[i] as readonly [number, number];
    const [xj, yj] = outline[j] as readonly [number, number];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function raw(p: LatLng): CountryCode | null {
  if (inside(p, ZIMBABWE)) return 'ZW';
  if (inside(p, ZAMBIA)) return 'ZM';
  return null;
}

/** About 9 km. A point this close to a border, or to the edge of both outlines, is treated as unclear. */
const MARGIN_DEG = 0.08;

/**
 * The supported country a GPS position is in, or null when it is unclear: outside both countries,
 * within about 9 km of a border, or not a real position. Callers keep the current country on null.
 */
export function countryFromCoords(p: LatLng): CountryCode | null {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
  const here = raw(p);
  if (here === null) return null;
  for (const dLat of [-MARGIN_DEG, 0, MARGIN_DEG]) {
    for (const dLng of [-MARGIN_DEG, 0, MARGIN_DEG]) {
      if (raw({ lat: p.lat + dLat, lng: p.lng + dLng }) !== here) return null;
    }
  }
  return here;
}
