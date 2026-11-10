import { useEffect, useState } from 'react';
import { runName } from './runNames';

export interface TrackData {
  status: string;
  stage: string;
  suburb: string;
  run: string;
  phoneLast3: string;
  rider: { firstName: string | null; tier: string } | null;
  events: Array<{ stage: string; at: string }>;
}

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error' } | { kind: 'ready'; data: TrackData };

interface TrackProps {
  token: string;
  /** Resolves null when the token is unknown. */
  load: (token: string) => Promise<TrackData | null>;
}

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export async function loadTrack(token: string): Promise<TrackData | null> {
  const res = await fetch(`/track/${encodeURIComponent(token)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`track ${res.status}`);
  return (await res.json()) as TrackData;
}

export function Track({ token, load }: TrackProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    load(token).then(
      (data) => live && setState(data ? { kind: 'ready', data } : { kind: 'missing' }),
      () => live && setState({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [token, load]);

  if (state.kind === 'loading') return <p className="note" role="status">Loading your parcel...</p>;
  if (state.kind === 'missing') return <p className="note" role="alert">We cannot find this parcel. Check the link you were sent.</p>;
  if (state.kind === 'error') return <p className="note" role="alert">We could not load your parcel. Try again in a minute.</p>;

  // Whitelist the fields shown: the page never prints anything else the server might send.
  const { stage, suburb, run, phoneLast3, rider, events } = state.data;
  return (
    <main className="card">
      <h1>{stage}</h1>
      <p>
        Going to {suburb} on the {runName(run)} run.
      </p>
      <p>
        Delivery code sent to <strong>***{phoneLast3}</strong>. Give it to the rider only when you have your parcel.
      </p>
      {rider && <p>Your rider: {rider.firstName ?? 'a Tuma rider'}</p>}
      <ol className="timeline">
        {events.map((e) => (
          <li key={`${e.stage}-${e.at}`}>
            <span>{e.stage}</span> <time dateTime={e.at}>{formatTime(e.at)}</time>
          </li>
        ))}
      </ol>
    </main>
  );
}
