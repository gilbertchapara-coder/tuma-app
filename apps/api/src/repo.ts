import { balanceCents, depositCents, riderTier, type CustodyEvent, type Entry, type RiderStats, type Tier } from '@tuma/core';
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

export async function loadEntries(db: Db, riderId: string): Promise<Entry[]> {
  const { rows } = await db.query('SELECT type, cents, at, job_id, pot FROM ledger_entries WHERE rider_id = $1 ORDER BY id', [riderId]);
  return rows.map((r) => ({
    type: r.type,
    cents: r.cents,
    at: iso(r.at),
    ...(r.job_id ? { jobId: r.job_id as string } : {}),
    ...(r.pot ? { pot: r.pot } : {}),
  }));
}

export async function insertEntries(db: Db, riderId: string, entries: readonly Entry[]): Promise<void> {
  for (const e of entries) {
    await db.query('INSERT INTO ledger_entries (rider_id, type, cents, at, job_id, pot) VALUES ($1, $2, $3, $4, $5, $6)', [
      riderId,
      e.type,
      e.cents,
      e.at,
      e.jobId ?? null,
      e.pot ?? null,
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
export async function lockRider(db: Db, riderId: string): Promise<{ stats: RiderStats; entries: Entry[] }> {
  const { rows } = await db.query<RiderRow>(
    'SELECT verified, has_guarantor, clean_deliveries, rating FROM riders WHERE user_id = $1 FOR UPDATE',
    [riderId],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'not_found', 'Rider not found');
  const entries = await loadEntries(db, riderId);
  return { entries, stats: statsOf(r, entries) };
}

export async function riderSummary(db: Db, riderId: string): Promise<{ tier: Tier; balanceCents: number; depositCents: number }> {
  const { rows } = await db.query<RiderRow>(
    'SELECT verified, has_guarantor, clean_deliveries, rating FROM riders WHERE user_id = $1',
    [riderId],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'not_found', 'Rider not found');
  const entries = await loadEntries(db, riderId);
  const stats = statsOf(r, entries);
  return { tier: riderTier(stats), balanceCents: balanceCents(entries), depositCents: stats.depositCents };
}
