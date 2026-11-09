import { findSuburbEntry, MAX_GPS_GAP_MS, routeFlags, STALLED_METERS, type Flag, type GpsPoint } from '@tuma/core';
import type pg from 'pg';

/**
 * ASSUMPTION (approximate centre points, to be replaced with surveyed stops): the core suburb table has
 * no coordinates, so the planned route is depot -> suburb centre.
 */
const DEPOT = { lat: -17.8292, lng: 31.0522 };
const SUBURB_CENTRES: Readonly<Record<string, { lat: number; lng: number }>> = {
  Avenues: { lat: -17.834, lng: 31.048 },
  'Milton Park': { lat: -17.8165, lng: 31.0445 },
  Mbare: { lat: -17.86, lng: 31.045 },
  Avondale: { lat: -17.803, lng: 31.035 },
  Workington: { lat: -17.86, lng: 31.01 },
  'Houghton Park': { lat: -17.87, lng: 31.03 },
  Waterfalls: { lat: -17.9, lng: 31.01 },
  Plymouth: { lat: -17.925, lng: 31.005 },
};

/** How far back a trail is read. Longer than any realistic stall that is still being raised. */
const TRAIL_WINDOW_MS = 3 * 3_600_000;
const MAX_TRAIL_POINTS = 2000;
const EARTH_RADIUS_M = 6_371_000;
const toRad = (d: number): number => (d * Math.PI) / 180;

function meters(a: GpsPoint, b: GpsPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Start time of the stationary stretch ending at the latest ping (same rules as core's stall test). */
function stallStart(trail: GpsPoint[]): number | null {
  const last = trail[trail.length - 1];
  if (!last) return null;
  let start = Date.parse(last.at);
  for (let i = trail.length - 2; i >= 0; i -= 1) {
    const p = trail[i];
    const after = trail[i + 1];
    if (!p || !after) break;
    if (Date.parse(after.at) - Date.parse(p.at) > MAX_GPS_GAP_MS) break;
    if (meters(p, last) >= STALLED_METERS) break;
    start = Date.parse(p.at);
  }
  return start;
}

let boundPool: pg.Pool | undefined;
/** Called by buildApp so runFlagJob(now) has a database without a scheduler or globals in callers. */
export function bindFlagJobPool(pool: pg.Pool): void {
  boundPool = pool;
}

interface InFlight {
  parcel_id: string;
  rider_id: string;
  suburb: string;
  picked_at: Date;
}

/**
 * Raises route flags for parcels in flight (latest event pickup_confirmed or in_transit).
 * One flag per (parcel, kind, episode): re-running never duplicates. Returns how many are NEW.
 */
export async function runFlagJob(now: Date, pool: pg.Pool | undefined = boundPool): Promise<number> {
  if (!pool) throw new Error('runFlagJob: no database pool bound');
  const inflight = await pool.query<InFlight>(
    `SELECT p.id AS parcel_id, p.rider_id, p.suburb,
            (SELECT e.at FROM custody_events e WHERE e.parcel_id = p.id AND e.type = 'pickup_confirmed' ORDER BY e.id DESC LIMIT 1) AS picked_at
     FROM parcels p
     WHERE p.rider_id IS NOT NULL
       AND (SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1) IN ('pickup_confirmed', 'in_transit')`,
  );

  let raised = 0;
  for (const row of inflight.rows) {
    const centre = SUBURB_CENTRES[findSuburbEntry(row.suburb).name];
    if (!centre) continue;
    const since = new Date(Math.max(now.getTime() - TRAIL_WINDOW_MS, 0));
    const pings = await pool.query(
      `SELECT lat, lng, at FROM (
         SELECT lat, lng, at FROM gps_pings WHERE rider_id = $1 AND at >= $2 AND at <= $3 ORDER BY at DESC LIMIT $4
       ) t ORDER BY at`,
      [row.rider_id, since, now, MAX_TRAIL_POINTS],
    );
    const trail: GpsPoint[] = pings.rows.map((r) => ({ lat: r.lat, lng: r.lng, at: (r.at as Date).toISOString() }));
    const flags: Flag[] = routeFlags(trail, [DEPOT, centre], now.toISOString());
    for (const kind of flags) {
      const episode = kind === 'stalled' ? (stallStart(trail) ?? now.getTime()) : row.picked_at.getTime();
      const ins = await pool.query(
        `INSERT INTO flags (parcel_id, rider_id, kind, episode_start, raised_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (parcel_id, kind, episode_start) DO NOTHING`,
        [row.parcel_id, row.rider_id, kind, new Date(episode), now],
      );
      raised += ins.rowCount ?? 0;
    }
  }
  return raised;
}
