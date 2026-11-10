import { useEffect, useState } from 'react';
import { runName } from './runNames';

export interface Metrics {
  parcelsPerRun: Array<{ run: string; date: string; count: number }>;
  ridersActive: number;
  feesCents: number;
}

/** A run with fewer parcels than this on a day is flagged (pilot placeholder). */
export const MIN_PARCELS_PER_RUN = 5;

interface DashboardProps {
  load: () => Promise<Metrics>;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function Dashboard({ load }: DashboardProps) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    load().then(
      (m) => live && setMetrics(m),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [load]);

  if (failed) return <p className="note" role="alert">Could not load the numbers. Check you are signed in as admin.</p>;
  if (!metrics) return <p className="note" role="status">Loading...</p>;

  return (
    <main className="card">
      <h1>Tuma pilot</h1>
      <p className="summary">
        <strong>{metrics.ridersActive}</strong> riders active this week. <strong>{dollars(metrics.feesCents)}</strong> in
        fees earned.
      </p>
      <h2>Parcels per run</h2>
      {metrics.parcelsPerRun.length === 0 ? (
        <p className="note">No parcels yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Run</th>
              <th scope="col" className="num">Parcels</th>
              <th scope="col"><span className="sr-only">Pooling check</span></th>
            </tr>
          </thead>
          <tbody>
            {metrics.parcelsPerRun.map((r) => (
              <tr key={`${r.date}-${r.run}`}>
                <td>{r.date}</td>
                <td>{runName(r.run)}</td>
                <td className="num">{r.count}</td>
                <td>{r.count < MIN_PARCELS_PER_RUN ? <strong className="flag">Too few for pooling</strong> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
