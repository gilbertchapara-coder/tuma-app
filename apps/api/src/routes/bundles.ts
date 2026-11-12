import { bundleRuns, COUNTRY_CODES, isCountryConfigured, type BookedParcel, type ServiceLevel } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app';
import { requireRole, userOf } from '../auth';
import { withTx } from '../db';
import { HttpError } from '../errors';
import { acceptBundleTx, LAST_EVENT_SEALED } from '../dispatch';
import { countryConfig, userCountry } from '../repo';
import { parse, uuidParam } from '../validate';

const BUILD_LOCK_KEY = 8_100_002;

const buildBody = z.object({ cutoffAt: z.iso.datetime({ offset: true }).optional() }).strict();

export const bundleRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.post('/bundles/build', { preHandler: requireRole(deps.jwtSecret, 'admin') }, async (req) => {
      const { cutoffAt } = parse(buildBody, req.body);
      const cutoff = cutoffAt ?? new Date().toISOString();
      return withTx(deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [BUILD_LOCK_KEY]);
        const out = [];
        // Each open country is bundled on its own: a run never mixes parcels from two countries.
        for (const country of COUNTRY_CODES) {
          const cfg = await countryConfig(tx, country);
          if (!isCountryConfigured(cfg)) continue;
          const { rows } = await tx.query(
            `SELECT p.id, p.suburb, p.level, p.created_at FROM parcels p
             WHERE p.level <> 'express' AND p.country = $1
               AND NOT EXISTS (SELECT 1 FROM bundle_parcels bp WHERE bp.parcel_id = p.id)
               AND ${LAST_EVENT_SEALED}`,
            [country],
          );
          const booked: BookedParcel[] = rows.map((r) => ({
            id: r.id,
            suburb: r.suburb,
            level: r.level as ServiceLevel,
            bookedAt: (r.created_at as Date).toISOString(),
          }));
          for (const b of bundleRuns(booked, cutoff, cfg)) {
            const ins = await tx.query(
              `INSERT INTO bundles (run, level, drop_order, country) VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
              [b.run, b.level, JSON.stringify(b.dropOrder), country],
            );
            const id = ins.rows[0].id as string;
            for (const parcelId of b.parcelIds) {
              await tx.query('INSERT INTO bundle_parcels (bundle_id, parcel_id) VALUES ($1, $2)', [id, parcelId]);
            }
            out.push({ id, ...b, country });
          }
        }
        return out;
      });
    });

    app.get('/bundles/open', { preHandler: requireRole(deps.jwtSecret, 'rider') }, async (req) => {
      const country = await userCountry(deps.pool, userOf(req).id);
      const { rows } = await deps.pool.query(
        `SELECT b.id, b.run, b.level, b.drop_order, count(bp.parcel_id)::int AS parcel_count
         FROM bundles b JOIN bundle_parcels bp ON bp.bundle_id = b.id JOIN parcels p ON p.id = bp.parcel_id
         WHERE b.status = 'open' AND b.dispatch_mode = 'fixed' AND b.country = $1 AND ${LAST_EVENT_SEALED} GROUP BY b.id ORDER BY b.created_at`,
        [country],
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
        const mode = await tx.query('SELECT dispatch_mode FROM bundles WHERE id = $1', [id]);
        if (mode.rows[0] && mode.rows[0].dispatch_mode !== 'fixed') {
          throw new HttpError(409, 'auction', 'This job is on the direction board: put it in your cart there');
        }
        await acceptBundleTx(tx, id, riderId);
        return { ok: true };
      });
    });
  };
