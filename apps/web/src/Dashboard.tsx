import { useEffect, useState } from 'react';
import { ClaimsAdmin, type ClaimsApi } from './ClaimsAdmin';
import { CountriesAdmin, type CountriesApi } from './CountriesAdmin';
import { InsightsAdmin, type InsightsApi } from './InsightsAdmin';
import { LockedCodes, type LockedCodesApi } from './LockedCodes';
import { runName } from './runNames';

export interface Metrics {
  parcelsPerRun: Array<{ run: string; date: string; count: number }>;
  ridersActive: number;
  feesCents: number;
  /** Fees per country, each in its own currency. Older servers leave this out. */
  feesByCountry?: Array<{ country: string; currencySymbol: string; cents: number }>;
}

/** A run with fewer parcels than this on a day is flagged (pilot placeholder). */
export const MIN_PARCELS_PER_RUN = 5;

interface DashboardProps {
  load: () => Promise<Metrics>;
  /** Support tools. Without it the Locked codes tab is not shown. */
  codes?: LockedCodesApi;
  /** The owner's country settings. Without it the Countries tab is not shown. */
  countries?: CountriesApi;
  /** Loss claims. Without it the Claims tab is not shown. */
  claims?: ClaimsApi;
  /** Public news on similar apps. Without it the Insights tab is not shown. */
  insights?: InsightsApi;
}

const money = (symbol: string, cents: number): string => `${symbol}${(cents / 100).toFixed(2)}`;

const feesText = (m: Metrics): string =>
  m.feesByCountry && m.feesByCountry.length > 0
    ? m.feesByCountry.map((f) => money(f.currencySymbol, f.cents)).join(' and ')
    : money('$', m.feesCents);

export function Dashboard({ load, codes, countries, claims, insights }: DashboardProps) {
  const [tab, setTab] = useState<'numbers' | 'locked' | 'countries' | 'claims' | 'insights'>('numbers');
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
      {codes || countries || claims || insights ? (
        <div role="tablist" aria-label="Dashboard sections" className="tabs">
          <button type="button" role="tab" aria-selected={tab === 'numbers'} onClick={() => setTab('numbers')}>Numbers</button>
          {codes ? <button type="button" role="tab" aria-selected={tab === 'locked'} onClick={() => setTab('locked')}>Locked codes</button> : null}
          {countries ? <button type="button" role="tab" aria-selected={tab === 'countries'} onClick={() => setTab('countries')}>Countries</button> : null}
          {claims ? <button type="button" role="tab" aria-selected={tab === 'claims'} onClick={() => setTab('claims')}>Claims</button> : null}
          {insights ? <button type="button" role="tab" aria-selected={tab === 'insights'} onClick={() => setTab('insights')}>Insights</button> : null}
        </div>
      ) : null}
      {codes && tab === 'locked' ? <LockedCodes api={codes} /> : countries && tab === 'countries' ? <CountriesAdmin api={countries} /> : claims && tab === 'claims' ? <ClaimsAdmin api={claims} /> : insights && tab === 'insights' ? <InsightsAdmin api={insights} /> : (
        <>
      <p className="summary">
        <strong>{metrics.ridersActive}</strong> riders active this week. <strong>{feesText(metrics)}</strong> in
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
        </>
      )}
    </main>
  );
}
