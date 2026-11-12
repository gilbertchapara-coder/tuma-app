import { useCallback, useEffect, useState } from 'react';

export interface Insight {
  id: number;
  title: string;
  url: string;
  source: string;
  tag: string;
  topic: string;
  summary: string;
  publishedAt: string | null;
}

export interface InsightsApi {
  list: () => Promise<{ connected: boolean; insights: Insight[] }>;
  refresh: () => Promise<{ added: number; failedTopics: string[] }>;
}

/** The address if it is a plain https link, otherwise undefined. News links come from outside, so they are checked. */
export function safeHttpsUrl(url: string): string | undefined {
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : 'date unknown');

/** What the research layer found about apps like Tuma. Information only. */
export function InsightsAdmin({ api }: { api: InsightsApi }) {
  const [data, setData] = useState<{ connected: boolean; insights: Insight[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(() => {
    api.list().then(setData, () => setFailed(true));
  }, [api]);
  useEffect(load, [load]);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.refresh();
      const lost = r.failedTopics.length;
      setMessage(`${r.added} new${lost > 0 ? `, ${lost} search${lost === 1 ? '' : 'es'} failed` : ''}.`);
      load();
    } catch {
      setMessage('Could not search just now. It may have run a minute ago, or you are signed out.');
    } finally {
      setBusy(false);
    }
  };

  if (failed) return <p className="note" role="alert">Could not load the updates.</p>;
  if (!data) return <p className="note" role="status">Loading...</p>;
  return (
    <section>
      <p className="note">Public news on delivery and rider apps. This does not change any price or setting.</p>
      {data.connected ? (
        <button type="button" disabled={busy} onClick={() => void refresh()}>Look for new updates</button>
      ) : (
        <p className="note">No research source is connected.</p>
      )}
      {message ? <p role="status">{message}</p> : null}
      <ul className="locks">
        {data.insights.map((i) => {
          const link = safeHttpsUrl(i.url);
          return (
            <li key={i.id} className="lock-row">
              <p>
                <strong>{i.tag}</strong>
              </p>
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer">{i.title}</a>
              ) : (
                <span>{i.title}</span>
              )}
              <p>{`${i.source}, ${day(i.publishedAt)}`}</p>
              {i.summary ? <p>{i.summary}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
