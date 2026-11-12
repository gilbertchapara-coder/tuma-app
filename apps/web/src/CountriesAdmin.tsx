import { useCallback, useEffect, useState } from 'react';

export interface AdminCountry {
  code: string;
  name: string;
  currencySymbol: string;
  open: boolean;
  /** Tuma's share in basis points. Null until the owner sets it. */
  platformBps: number | null;
  suburbs: ReadonlyArray<{ name: string }>;
}

export interface CountrySettings {
  platformBps?: number | null;
  confirmHighPercentage?: boolean;
  suburbs?: Record<string, { band: string; run: string }>;
  prices?: Record<string, [number, number, number]>;
}

export interface CountriesApi {
  list: () => Promise<AdminCountry[]>;
  save: (code: string, settings: CountrySettings) => Promise<void>;
}

/** Same soft cap as the API: above this the owner must tick a box. */
export const SOFT_CAP_BPS = 3000;

/** Percent text such as "12.5" to basis points, or null when it is not a number from 0 to 100. */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= 0 && bps <= 10000 ? bps : null;
}

const bpsText = (bps: number | null): string => (bps === null ? '' : String(bps / 100));

function CountryCard({ country, save }: { country: AdminCountry; save: CountriesApi['save'] }) {
  const [percent, setPercent] = useState(bpsText(country.platformBps));
  const [confirmHigh, setConfirmHigh] = useState(false);
  const [json, setJson] = useState('');
  const [message, setMessage] = useState('');
  const bps = percentToBps(percent);
  const high = bps !== null && bps > SOFT_CAP_BPS;
  const label = (what: string): string => `${what} for ${country.name}`;

  const submit = async (settings: CountrySettings, done: string): Promise<void> => {
    try {
      await save(country.code, settings);
      setMessage(done);
    } catch {
      setMessage('Could not save. Check the values, or sign in as admin again.');
    }
  };

  const savePercent = (): Promise<void> => {
    if (bps === null || (high && !confirmHigh)) return Promise.resolve();
    return submit({ platformBps: bps, ...(high ? { confirmHighPercentage: true } : {}) }, `Saved ${percent}% for ${country.name}.`);
  };

  const saveJson = (): Promise<void> => {
    let parsed: CountrySettings;
    try {
      parsed = JSON.parse(json) as CountrySettings;
    } catch {
      setMessage('That is not valid JSON.');
      return Promise.resolve();
    }
    if (!parsed.suburbs && !parsed.prices) {
      setMessage('Include suburbs, prices, or both.');
      return Promise.resolve();
    }
    return submit({ ...(parsed.suburbs ? { suburbs: parsed.suburbs } : {}), ...(parsed.prices ? { prices: parsed.prices } : {}) }, 'Saved suburbs and prices.');
  };

  return (
    <li className="lock-row">
      <h2>{`${country.name} (${country.currencySymbol})`}</h2>
      <p>{country.open ? `Open, ${country.suburbs.length} suburbs` : 'Closed: load suburbs and prices to open it'}</p>
      <p>{country.platformBps === null ? "Tuma's percentage is not set" : `Tuma's percentage is ${bpsText(country.platformBps)}%`}</p>
      <label>
        {label("Tuma's percentage")}
        <input aria-label={label("Tuma's percentage")} value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" />
      </label>
      {high ? (
        <label>
          <input type="checkbox" checked={confirmHigh} onChange={(e) => setConfirmHigh(e.target.checked)} />
          {`I mean ${percent}%, which is above ${SOFT_CAP_BPS / 100}%`}
        </label>
      ) : null}
      <button type="button" disabled={bps === null || (high && !confirmHigh)} onClick={() => void savePercent()}>
        {label('Save percentage')}
      </button>
      <label>
        {label('Suburbs and prices (JSON)')}
        <textarea aria-label={label('Suburbs and prices (JSON)')} value={json} onChange={(e) => setJson(e.target.value)} rows={5} />
      </label>
      <button type="button" disabled={json.trim() === ''} onClick={() => void saveJson()}>
        {label('Save suburbs and prices')}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </li>
  );
}

/** The owner's settings for each country: Tuma's percentage, and the suburbs and prices that open it. */
export function CountriesAdmin({ api }: { api: CountriesApi }) {
  const [list, setList] = useState<AdminCountry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    api.list().then(setList, () => setFailed(true));
  }, [api]);
  useEffect(load, [load]);

  if (failed) return <p className="note" role="alert">Could not load the countries.</p>;
  if (!list) return <p className="note" role="status">Loading...</p>;
  return (
    <ul className="locks">
      {list.map((c) => (
        <CountryCard
          key={c.code}
          country={c}
          save={async (code, s) => {
            await api.save(code, s);
            load();
          }}
        />
      ))}
    </ul>
  );
}
