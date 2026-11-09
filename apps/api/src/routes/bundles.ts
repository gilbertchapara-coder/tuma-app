import {
  bundleRuns,
  canCarry,
  chargeFee,
  InsufficientFloatError,
  type BookedParcel,
  type ServiceLevel,
} from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { insertEntries, lockRider } from '../repo';
import { parse, uuidParam } from '../validate';

const BUILD_LOCK_KEY = 8_100_002;

const buildBody = z.object({ cutoffAt: z.iso.datetime({ offset: true }).optional() }).strict();

/** Parcels whose latest custody event is `sealed` (booked and ready for a rider). */
const LAST_EVENT_SEALED = `(SELECT e.type FROM custody_events e WHERE e.parcel_id = p.id ORDER BY e.id DESC LIMIT 1) = 'sealed'`;

export const bundleRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.post('/bundles/build', { preHandler: requireRole(deps.jwtSecret, 'admin') }, async (req) => {
      const { cutoffAt } = parse(buildBody, req.body);
      const cutoff = cutoffAt ?? new Date().toISOString();
      return withTx(deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [BUILD_LOCK_KEY]);
        const { rows } = await tx.query(
          `SELECT p.id, p.suburb, p.level, p.created_at FROM parcels p
           WHERE p.level <> 'express'
             AND NOT EXISTS (SELECT 1 FROM bundle_parcels bp WHERE bp.parcel_id = p.id)
             AND ${LAST_EVENT_SEALED}`,
        );
        const booked: BookedParcel[] = rows.map((r) => ({
          id: r.id,
          suburb: r.suburb,
          level: r.level as ServiceLevel,
          bookedAt: (r.created_at as Date).toISOString(),
        }));
        const bundles = bundleRuns(booked, cutoff);
        const out = [];
        for (const b of bundles) {
          const ins = await tx.query(
            `INSERT INTO bundles (run, level, drop_order) VALUES ($1, $2, $3::jsonb) RETURNING id`,
            [b.run, b.level, JSON.stringify(b.dropOrder)],
          );
          const id = ins.rows[0].id as string;
          for (const parcelId of b.parcelIds) {
            await tx.query('INSERT INTO bundle_parcels (bundle_id, parcel_id) VALUES ($1, $2)', [id, parcelId]);
          }
          out.push({ id, ...b });
        }
        return out;
      });
    });

    app.get('/bundles/open', { preHandler: requireRole(deps.jwtSecret, 'rider') }, async () => {
      const { rows } = await deps.pool.query(
        `SELECT b.id, b.run, b.level, b.drop_order, count(bp.parcel_id)::int AS parcel_count
         FROM bundles b JOIN bundle_parcels bp ON bp.bundle_id = b.id
         WHERE b.status = 'open' GROUP BY b.id ORDER BY b.created_at`,
      );
      return {
        bundles: rows.map((r) => ({
          id: r.id,
          run: r.run,
          level: r.level,
          dropOrder: r.drop_order,
          parcelCount: r.parcel_count,
        })),
      };
    });

    app.post('/bundles/:id/accept', { preHandler: requireRole(deps.jwtSecret, 'rider') }, async (req) => {
      const { id } = parse(uuidParam, req.params);
      const riderId = userOf(req).id;
      return withTx(deps.pool, async (tx) => {
        // Lock order is always bundle, then rider.
        const b = await tx.query('SELECT status FROM bundles WHERE id = $1 FOR UPDATE', [id]);
        if (!b.rows[0]) throw new HttpError(404, 'not_found', 'Bundle not found');
        if (b.rows[0].status !== 'open') throw new HttpError(409, 'taken', 'Another rider already took this bundle');

        const { stats, entries } = await lockRider(tx, riderId);
        const parcels = await tx.query(
          `SELECT p.id, p.value_cents FROM bundle_parcels bp JOIN parcels p ON p.id = bp.parcel_id
           WHERE bp.bundle_id = $1 AND ${LAST_EVENT_SEALED} ORDER BY p.created_at`,
          [id],
        );
        if (parcels.rows.length === 0) throw new HttpError(409, 'unavailable', 'This bundle has no parcels left to carry');

        // The cap is per parcel (a rider may not carry a parcel worth more than their tier allows).
        for (const p of parcels.rows) {
          if (!canCarry(stats, p.value_cents, false)) {
            throw new HttpError(403, 'over_cap', 'A parcel in this bundle is worth more than your rider level allows');
          }
        }

        // All fees or none: one transaction, and the rider row is locked so the float cannot be overspent.
        const at = new Date().toISOString();
        let next = entries;
        try {
          for (const p of parcels.rows) next = chargeFee(next, p.id as string, at);
        } catch (err) {
          if (err instanceof InsufficientFloatError) {
            throw new HttpError(402, 'insufficient_float', 'Top up your float to take this bundle');
          }
          throw err;
        }
        await insertEntries(tx, riderId, next.slice(entries.length));

        await tx.query(`UPDATE bundles SET status = 'accepted', rider_id = $2, accepted_at = now() WHERE id = $1`, [id, riderId]);
        await tx.query('UPDATE parcels SET rider_id = $2 WHERE id = ANY($1::uuid[])', [
          parcels.rows.map((p) => p.id),
          riderId,
        ]);
        return { ok: true };
      });
    });
  };
