import { findSuburbEntry, type Run } from '@tuma/core';
import type { FastifyPluginAsync } from 'fastify';
import type { Deps } from '../app';
import { requireRole } from '../auth';

/** A rider counts as active if they accepted a bundle within this many days. */
const ACTIVE_RIDER_DAYS = 7;

interface RunDay {
  run: Run;
  date: string;
  count: number;
}

/** Owner dashboard numbers. Counts and money only: no phones, contents or tokens. */
export const metricsRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get('/admin/metrics', { preHandler: requireRole(deps.jwtSecret, 'admin') }, async () => {
      const parcels = await deps.pool.query(
        `SELECT suburb, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM parcels GROUP BY suburb, day`,
      );
      const byKey = new Map<string, RunDay>();
      for (const r of parcels.rows) {
        const run = findSuburbEntry(r.suburb).suburb.run;
        const key = `${run}|${r.day}`;
        const row = byKey.get(key) ?? { run, date: r.day, count: 0 };
        byKey.set(key, { ...row, count: row.count + r.n });
      }
      const parcelsPerRun = [...byKey.values()].sort((a, b) =>
        a.date === b.date ? a.run.localeCompare(b.run) : a.date.localeCompare(b.date),
      );

      const riders = await deps.pool.query(
        `SELECT count(DISTINCT rider_id)::int AS n FROM bundles
         WHERE status = 'accepted' AND accepted_at > now() - make_interval(days => $1)`,
        [ACTIVE_RIDER_DAYS],
      );
      const fees = await deps.pool.query(
        `SELECT coalesce(sum(CASE WHEN type = 'fee' THEN cents WHEN type = 'fee_refund' THEN -cents ELSE 0 END), 0)::int AS cents
         FROM ledger_entries`,
      );
      return { parcelsPerRun, ridersActive: riders.rows[0].n as number, feesCents: fees.rows[0].cents as number };
    });
  };
