import type pg from 'pg';

const STALE_AFTER = '1 day';
const EVERY_MS = 60 * 60_000;

/** Deletes failure counters that are old and not locking anyone out. Returns how many rows went. */
export async function purgeOtpFailures(pool: pg.Pool): Promise<number> {
  const res = await pool.query(
    `DELETE FROM otp_failures WHERE window_start < now() - interval '${STALE_AFTER}' AND (locked_until IS NULL OR locked_until < now())`,
  );
  return res.rowCount ?? 0;
}

/** Runs the purge now and then hourly. Errors are logged by class only; the timer never keeps the process alive. */
export function startOtpFailurePurge(pool: pg.Pool, log: (msg: string) => void): () => void {
  const run = (): void => {
    purgeOtpFailures(pool).catch((err: unknown) => log(`otp purge failed: ${err instanceof Error ? err.name : 'error'}`));
  };
  run();
  const timer = setInterval(run, EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
