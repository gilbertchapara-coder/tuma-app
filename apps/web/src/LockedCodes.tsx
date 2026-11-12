import { useCallback, useEffect, useState } from 'react';

export type WhichCode = 'pickup' | 'delivery';

export interface LockedParcel {
  id: string;
  reference: string;
  suburb: string;
  country: string;
  /** Already masked by the API, such as ***011. */
  shopPhone: string;
  riderFirstName: string | null;
  status: string | null;
  codes: {
    pickup: { locked: boolean; used: boolean } | null;
    delivery: { locked: boolean; used: boolean } | null;
  };
}

export interface LockedCodesApi {
  /** Finds parcels by the reference a shop quotes, such as TUM-3F2A9C10. */
  lookup: (reference: string) => Promise<LockedParcel[]>;
  /** Every parcel that has a locked code. */
  locked: () => Promise<LockedParcel[]>;
  unlock: (parcelId: string, which: WhichCode) => Promise<void>;
}

const STATE_LABEL = (c: { locked: boolean; used: boolean } | null): string =>
  c === null ? 'No code' : c.used ? 'Used' : c.locked ? 'Locked' : 'Open';

interface RowProps {
  parcel: LockedParcel;
  onUnlock: (parcelId: string, which: WhichCode) => Promise<void>;
}

function ParcelRow({ parcel, onUnlock }: RowProps) {
  const lockedWhich = (['pickup', 'delivery'] as const).filter((w) => parcel.codes[w]?.locked && !parcel.codes[w]?.used);
  const [which, setWhich] = useState<WhichCode | null>(lockedWhich.length === 1 ? (lockedWhich[0] ?? null) : null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const name = `${parcel.reference}`;

  const unlock = async (): Promise<void> => {
    if (!which || !checked) return;
    setBusy(true);
    try {
      await onUnlock(parcel.id, which);
      setMessage(`Unlocked the ${which} code. The rider can try again.`);
      setChecked(false);
    } catch {
      setMessage('Could not unlock. It may be used already, or you are signed out.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="lock-row">
      <p>
        <strong>{parcel.reference}</strong> {parcel.suburb} ({parcel.country}). Shop {parcel.shopPhone}.{' '}
        {parcel.riderFirstName ? `Rider ${parcel.riderFirstName}.` : 'No rider yet.'}
      </p>
      <p className="note-inline">
        {`Pickup: ${STATE_LABEL(parcel.codes.pickup)}. Delivery: ${STATE_LABEL(parcel.codes.delivery)}.`}
      </p>
      {lockedWhich.length === 0 ? (
        <p className="note-inline">Nothing to unlock on this parcel.</p>
      ) : (
        <fieldset>
          <legend className="sr-only">{`Unlock ${name}`}</legend>
          {lockedWhich.map((w) => (
            <label key={w}>
              <input type="radio" name={`which-${parcel.id}`} checked={which === w} onChange={() => setWhich(w)} /> {w === 'pickup' ? 'Pickup code' : 'Delivery code'}
            </label>
          ))}
          <label>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked who is at the door
          </label>
          <button type="button" disabled={!which || !checked || busy} onClick={() => void unlock()}>
            {`Unlock ${name}`}
          </button>
        </fieldset>
      )}
      {message ? <p role="status">{message}</p> : null}
    </li>
  );
}

/** Support tab: find a parcel by its reference, then unlock a locked code after checking who is at the door. */
export function LockedCodes({ api }: { api: LockedCodesApi }) {
  const [reference, setReference] = useState('');
  const [rows, setRows] = useState<LockedParcel[] | null>(null);
  const [heading, setHeading] = useState('All locked codes');
  const [error, setError] = useState('');

  const showLocked = useCallback(async (): Promise<void> => {
    try {
      setRows(await api.locked());
      setHeading('All locked codes');
      setError('');
    } catch {
      setError('Could not load. Check you are signed in as admin.');
    }
  }, [api]);

  useEffect(() => {
    void showLocked();
  }, [showLocked]);

  const search = async (): Promise<void> => {
    try {
      setRows(await api.lookup(reference));
      setHeading(`Parcels matching ${reference.trim()}`);
      setError('');
    } catch {
      setRows([]);
      setError('No parcel found. Type at least 6 characters of the reference, such as TUM-3F2A9C10.');
    }
  };

  const unlockThenRefresh = async (parcelId: string, which: WhichCode): Promise<void> => {
    await api.unlock(parcelId, which);
    setRows((current) => (current ? current.map((p) => (p.id === parcelId ? { ...p, codes: { ...p.codes, [which]: p.codes[which] ? { ...p.codes[which], locked: false } : null } } : p)) : current));
  };

  return (
    <section aria-labelledby="locked-heading">
      <h2 id="locked-heading">Locked codes</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label htmlFor="reference">Find a parcel by reference</label>
        <input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="TUM-3F2A9C10" autoComplete="off" />
        <button type="submit" disabled={reference.trim() === ''}>Find</button>
        <button type="button" onClick={() => void showLocked()}>Show all locked</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      <h3>{heading}</h3>
      {rows === null ? (
        <p role="status">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="note-inline">Nothing here.</p>
      ) : (
        <ul className="lock-list">
          {rows.map((p) => (
            <ParcelRow key={p.id} parcel={p} onUnlock={unlockThenRefresh} />
          ))}
        </ul>
      )}
    </section>
  );
}
