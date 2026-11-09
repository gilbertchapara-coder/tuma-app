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
const MAX_TRAIL_POINTS = 5000;
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

interface LatLng {
  lat: number;
  lng: number;
}

/** Depot -> stop -> depot -> stop ...: every planned leg, so a rider with several parcels is on route for each of them. */
function plannedStops(rows: InFlight[]): LatLng[] {
  const stops: LatLng[] = [DEPOT];
  for (const r of rows) {
    const centre = SUBURB_CENTRES[findSuburbEntry(r.suburb).name];
    if (centre) stops.push(centre, DEPOT);
  }
  return stops;
}

/** Start of the current stall; at the edge of the loaded trail it stays on the existing flag's episode. */
function stallEpisode(trail: GpsPoint[], priorStall: number | null, now: Date): number {
  const start = stallStart(trail);
  if (start === null) return now.getTime();
  const first = trail[0];
  const atEdge = first !== undefined && start === Date.parse(first.at);
  return atEdge && priorStall !== null && priorStall <= start ? priorStall : start;
}

async function flagParcel(pool: pg.Pool, now: Date, row: InFlight, stops: LatLng[]): Promise<number> {
  const picked = row.picked_at.getTime();
  const prior = await pool.query(`SELECT max(episode_start) AS e FROM flags WHERE parcel_id = $1 AND kind = 'stalled'`, [row.parcel_id]);
  const priorStall: number | null = prior.rows[0]?.e ? (prior.rows[0].e as Date).getTime() : null;
  // Load back to the existing stall's start too, so a long stall is still seen whole.
  const windowStart = Math.max(picked, now.getTime() - TRAIL_WINDOW_MS);
  const since = new Date(priorStall !== null && priorStall >= picked ? Math.min(windowStart, priorStall) : windowStart);
  const pings = await pool.query(
    `SELECT lat, lng, at FROM (
       SELECT lat, lng, at FROM gps_pings WHERE rider_id = $1 AND at >= $2 AND at <= $3 ORDER BY at DESC LIMIT $4
     ) t ORDER BY at`,
    [row.rider_id, since, now, MAX_TRAIL_POINTS],
  );
  const trail: GpsPoint[] = pings.rows.map((r) => ({ lat: r.lat, lng: r.lng, at: (r.at as Date).toISOString() }));
  const flags: Flag[] = routeFlags(trail, stops, now.toISOString());

  let raised = 0;
  for (const kind of flags) {
    const episode = kind === 'stalled' ? stallEpisode(trail, priorStall, now) : picked;
    const ins = await pool.query(
      `INSERT INTO flags (parcel_id, rider_id, kind, episode_start, raised_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (parcel_id, kind, episode_start) DO NOTHING`,
      [row.parcel_id, row.rider_id, kind, new Date(episode), now],
    );
    raised += ins.rowCount ?? 0;
  }
  return raised;
}

/**
 * Raises route flags for parcels in flight (latest event pickup_confirmed or in_transit).
 * The trail is this parcel's carry period only (pickup until now, at most 3 h), and the planned route covers
 * every in-flight parcel of the same rider. One flag per (parcel, kind, episode): re-running never duplicates,
 * and a stall that outlives the loaded trail stays anchored to its existing flag. Returns how many are NEW.
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
  const byRider = new Map<string, InFlight[]>();
  for (const row of inflight.rows) byRider.set(row.rider_id, [...(byRider.get(row.rider_id) ?? []), row]);

  let raised = 0;
  for (const rows of byRider.values()) {
    const stops = plannedStops(rows);
    for (const row of rows) raised += await flagParcel(pool, now, row, stops);
  }
  return raised;
}
