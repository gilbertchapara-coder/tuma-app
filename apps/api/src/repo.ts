import {
  balanceCents,
  COUNTRIES,
  depositCents,
  getCountry,
  isCountryCode,
  riderTier,
  withOverrides,
  type CountryCode,
  type CountryConfig,
  type CustodyEvent,
  type Entry,
  type RiderStats,
  type Tier,
} from '@tuma/core';
import type { Db } from './db';
import { HttpError } from './errors';

const iso = (d: Date): string => d.toISOString();

export async function loadEvents(db: Db, parcelId: string): Promise<CustodyEvent[]> {
  const { rows } = await db.query('SELECT type, at, actor, photo_url FROM custody_events WHERE parcel_id = $1 ORDER BY id', [
    parcelId,
  ]);
  return rows.map((r) => ({
    type: r.type,
    at: iso(r.at),
    actor: r.actor,
    ...(r.photo_url ? { photoUrl: r.photo_url as string } : {}),
  }));
}

export async function insertEvent(db: Db, parcelId: string, e: CustodyEvent): Promise<void> {
  await db.query('INSERT INTO custody_events (parcel_id, type, at, actor, photo_url) VALUES ($1, $2, $3, $4, $5)', [
    parcelId,
    e.type,
    e.at,
    e.actor,
    e.photoUrl ?? null,
  ]);
}

/** A rider's ledger in one country. Float and deposit never mix between currencies. */
export async function loadEntries(db: Db, riderId: string, country: CountryCode): Promise<Entry[]> {
  const { rows } = await db.query('SELECT type, cents, at, job_id, pot FROM ledger_entries WHERE rider_id = $1 AND country = $2 ORDER BY id', [riderId, country]);
  return rows.map((r) => ({
    type: r.type,
    cents: r.cents,
    at: iso(r.at),
    ...(r.job_id ? { jobId: r.job_id as string } : {}),
    ...(r.pot ? { pot: r.pot } : {}),
  }));
}

export async function insertEntries(db: Db, riderId: string, entries: readonly Entry[], country: CountryCode): Promise<void> {
  for (const e of entries) {
    await db.query('INSERT INTO ledger_entries (rider_id, type, cents, at, job_id, pot, country) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      riderId,
      e.type,
      e.cents,
      e.at,
      e.jobId ?? null,
      e.pot ?? null,
      country,
    ]);
  }
}

interface RiderRow {
  verified: boolean;
  has_guarantor: boolean;
  clean_deliveries: number;
  rating: string;
}

const statsOf = (r: RiderRow, entries: readonly Entry[]): RiderStats => ({
  verified: r.verified,
  hasGuarantor: r.has_guarantor,
  depositCents: depositCents(entries),
  cleanDeliveries: r.clean_deliveries,
  rating: Number(r.rating),
});

/** Locks the rider row (serialises everything that moves this rider's float) and returns their stats. */
export async function lockRider(db: Db, riderId: string, country: CountryCode): Promise<{ stats: RiderStats; entries: Entry[]; removed: boolean }> {
  const { rows } = await db.query<RiderRow & { status: string }>(
    'SELECT verified, has_guarantor, clean_deliveries, rating, status FROM riders WHERE user_id = $1 FOR UPDATE',
    [riderId],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'not_found', 'Rider not found');
  const entries = await loadEntries(db, riderId, country);
  return { entries, stats: statsOf(r, entries), removed: r.status === 'removed' };
}

export async function riderSummary(db: Db, riderId: string, country: CountryCode): Promise<{ tier: Tier; balanceCents: number; depositCents: number }> {
  const { rows } = await db.query<RiderRow>(
    'SELECT verified, has_guarantor, clean_deliveries, rating FROM riders WHERE user_id = $1',
    [riderId],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'not_found', 'Rider not found');
  const entries = await loadEntries(db, riderId, country);
  const stats = statsOf(r, entries);
  return { tier: riderTier(stats), balanceCents: balanceCents(entries), depositCents: stats.depositCents };
}

/** The country a user is working in. Falls back to Zimbabwe for a user row that does not exist. */
export async function userCountry(db: Db, userId: string): Promise<CountryCode> {
  const { rows } = await db.query<{ country: string }>('SELECT country FROM users WHERE id = $1', [userId]);
  const c = rows[0]?.country;
  return c && isCountryCode(c) ? c : 'ZW';
}

interface SettingsRow {
  suburbs: CountryConfig['suburbs'] | null;
  prices: CountryConfig['prices'] | null;
  platform_bps: number | null;
}

/** Built-in country with the owner's saved settings laid over it. */
export async function countryConfig(db: Db, code: CountryCode): Promise<CountryConfig> {
  const { rows } = await db.query<SettingsRow>('SELECT suburbs, prices, platform_bps FROM country_settings WHERE country = $1', [code]);
  const r = rows[0];
  if (!r) return getCountry(code);
  return withOverrides(getCountry(code), {
    ...(r.suburbs ? { suburbs: r.suburbs } : {}),
    ...(r.prices ? { prices: r.prices } : {}),
    ...(r.platform_bps !== null ? { platformBps: r.platform_bps } : {}),
  });
}

export const supportedCountries = (): CountryCode[] => Object.keys(COUNTRIES) as CountryCode[];
