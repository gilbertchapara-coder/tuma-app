import { balanceCents, canCarry, chargeFee, InsufficientFloatError, isValidAsk, percentFeeCents, pickWinner, type CountryCode, type DispatchMode, type Offer } from '@tuma/core';
import type pg from 'pg';
import { HttpError } from './errors';
import { countryConfig, insertEntries, lockRider } from './repo';

/** Parcels whose latest custody event is `sealed` (booked and ready for a rider). */
export const LAST_EVENT_SEALED = `(SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1) = 'sealed'`;

/** How long a "cheapest rider wins" auction collects offers before it is awarded. Owner placeholder. */
export const AUCTION_WINDOW_MINUTES = 5;

/**
 * Gives an open bundle to a rider: checks the rider level and caps, takes Tuma's percentage of each parcel price from the float, assigns the parcels.
 * Lock order is always bundle, then rider, then parcels. Throws HttpError; nothing is written before a throw.
 */
export async function acceptBundleTx(tx: pg.PoolClient, bundleId: string, riderId: string): Promise<void> {
  const b = await tx.query('SELECT status, country FROM bundles WHERE id = $1 FOR UPDATE', [bundleId]);
  if (!b.rows[0]) throw new HttpError(404, 'not_found', 'Bundle not found');
  if (b.rows[0].status !== 'open') throw new HttpError(409, 'taken', 'Another rider already took this bundle');
  const country = b.rows[0].country as CountryCode;
  const riderCountry = (await tx.query('SELECT country FROM users WHERE id = $1', [riderId])).rows[0]?.country;
  if (riderCountry !== country) throw new HttpError(409, 'wrong_country', 'This job is in another country. Switch country to take it.');

  const { stats, entries, removed } = await lockRider(tx, riderId, country);
  const cfg = await countryConfig(tx, country);
  if (removed) throw new HttpError(403, 'rider_removed', 'Your rider account is suspended, contact Tuma support');
  await tx.query(
    'SELECT id FROM parcels WHERE id IN (SELECT parcel_id FROM bundle_parcels WHERE bundle_id = $1) ORDER BY id FOR UPDATE',
    [bundleId],
  );
  const parcels = await tx.query(
    `SELECT p.id, p.value_cents, p.price_cents FROM bundle_parcels bp JOIN parcels p ON p.id = bp.parcel_id
     WHERE bp.bundle_id = $1 AND ${LAST_EVENT_SEALED} ORDER BY p.id`,
    [bundleId],
  );
  if (parcels.rows.length === 0) throw new HttpError(409, 'unavailable', 'This bundle has no parcels left to carry');
  for (const p of parcels.rows) {
    if (!canCarry(stats, p.value_cents, false)) {
      throw new HttpError(403, 'over_cap', 'A parcel in this bundle is worth more than your rider level allows');
    }
  }
  // No float, no rides, whether or not Tuma's percentage has been set yet.
  if (balanceCents(entries) <= 0) throw new HttpError(402, 'insufficient_float', 'Top up your float to take this bundle');
  const at = new Date().toISOString();
  let next = entries;
  try {
    for (const p of parcels.rows) next = chargeFee(next, p.id as string, at, percentFeeCents(p.price_cents as number, cfg.platformBps));
  } catch (err) {
    if (err instanceof InsufficientFloatError) throw new HttpError(402, 'insufficient_float', 'Top up your float to take this bundle');
    throw err;
  }
  await insertEntries(tx, riderId, next.slice(entries.length), country);
  await tx.query(`UPDATE bundles SET status = 'accepted', rider_id = $2, accepted_at = now() WHERE id = $1`, [bundleId, riderId]);
  await tx.query('UPDATE parcels SET rider_id = $2 WHERE id = ANY($1::uuid[])', [parcels.rows.map((p) => p.id), riderId]);
}

interface BundleAuction {
  status: string;
  mode: DispatchMode;
  ceilingCents: number | null;
}

async function loadAuction(tx: pg.PoolClient, bundleId: string): Promise<BundleAuction> {
  const b = await tx.query('SELECT status, dispatch_mode, ceiling_cents FROM bundles WHERE id = $1 FOR UPDATE', [bundleId]);
  const row = b.rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Job not found');
  return { status: row.status, mode: row.dispatch_mode, ceilingCents: row.ceiling_cents };
}

/**
 * Awards an open auctioned bundle to the best offer a rider can actually take.
 * A winner who has no float, is over their cap or is suspended is skipped (their offer is removed) and the next offer is tried.
 * Returns the winner's rider id, or null when nobody could take it (the job stays open).
 * On a win the parcel price becomes the winner's ask, so the shop pays what the rider asked.
 */
export async function awardBundleTx(tx: pg.PoolClient, bundleId: string): Promise<string | null> {
  const auction = await loadAuction(tx, bundleId);
  if (auction.status !== 'open' || auction.mode === 'fixed') return null;
  const rows = (await tx.query('SELECT rider_id, ask_cents, created_at FROM bundle_offers WHERE bundle_id = $1', [bundleId])).rows;
  let offers: Offer[] = rows.map((r) => ({ riderId: r.rider_id, askCents: r.ask_cents, at: (r.created_at as Date).toISOString() }));
  for (;;) {
    const winner = pickWinner(auction.mode, offers);
    if (!winner) return null;
    await tx.query('SAVEPOINT award_try');
    try {
      // The price becomes the winner's ask first, so Tuma's percentage is worked out on what the shop really pays.
      await tx.query('UPDATE parcels SET price_cents = $2 WHERE id IN (SELECT parcel_id FROM bundle_parcels WHERE bundle_id = $1)', [
        bundleId,
        winner.askCents,
      ]);
      await acceptBundleTx(tx, bundleId, winner.riderId);
      await tx.query('RELEASE SAVEPOINT award_try');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT award_try');
      if (err instanceof HttpError && (err.status === 402 || err.status === 403 || err.code === 'wrong_country')) {
        await tx.query('DELETE FROM bundle_offers WHERE bundle_id = $1 AND rider_id = $2', [bundleId, winner.riderId]);
        offers = offers.filter((o) => o.riderId !== winner.riderId);
        continue;
      }
      throw err;
    }
    return winner.riderId;
  }
}

/** Validates a rider's ask against the job's mode and ceiling. */
export function assertAsk(mode: DispatchMode, ceilingCents: number | null, askCents: number): void {
  if (mode === 'fixed' || ceilingCents === null) throw new HttpError(409, 'not_auction', 'This job is taken from the open jobs list, not the board');
  if (!isValidAsk(mode, askCents, ceilingCents)) {
    throw new HttpError(400, 'validation', mode === 'first' ? 'askCents: this job has a fixed price' : 'askCents: outside the allowed range');
  }
}
