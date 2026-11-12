import { useCallback, useEffect, useState } from 'react';

export interface Claim {
  id: string;
  parcelId: string;
  status: string;
  filedBy: string;
  liable: string | null;
  payoutCents: number | null;
  suburb: string;
  valueCents: number;
  createdAt: string;
}

export interface ClaimsApi {
  open: () => Promise<Claim[]>;
  dismiss: (claimId: string) => Promise<void>;
}

/** Open loss claims. Dismiss rejects a claim after review: no payout. */
export function ClaimsAdmin({ api }: { api: ClaimsApi }) {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(() => {
    api.open().then(setClaims, () => setFailed(true));
  }, [api]);
  useEffect(load, [load]);

  const dismiss = async (id: string): Promise<void> => {
    try {
      await api.dismiss(id);
      setMessage('Claim dismissed.');
      load();
    } catch {
      setMessage('Could not dismiss that claim.');
    }
  };

  if (failed) return <p className="note" role="alert">Could not load the claims.</p>;
  if (!claims) return <p className="note" role="status">Loading...</p>;
  if (claims.length === 0) return <p className="note">No open claims.</p>;
  return (
    <>
      <ul className="locks">
        {claims.map((c) => (
          <li key={c.id} className="lock-row">
            <p>{`${c.suburb}, value $${(c.valueCents / 100).toFixed(2)}, filed by ${c.filedBy}`}</p>
            <button type="button" onClick={() => void dismiss(c.id)}>{`Dismiss claim for ${c.suburb}`}</button>
          </li>
        ))}
      </ul>
      {message ? <p role="status">{message}</p> : null}
    </>
  );
}
