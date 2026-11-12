import type pg from 'pg';

/**
 * The intelligence layer: finds public news on apps like Tuma (delivery, riders, mobile money, rules, new markets)
 * so the owner can see what is changing. It is advisory: it never edits prices, percentages or settings, and it
 * sends out only the fixed search words below, never anything about a user, a parcel or a rider.
 */
export interface RawItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  summary: string;
}

export interface ResearchProvider {
  search(query: string): Promise<RawItem[]>;
}

export type InsightTag = 'payments' | 'pricing' | 'regulation' | 'safety' | 'expansion' | 'product' | 'other';

/** Fixed search words. Local angle first (Zimbabwe, Zambia), then the wider market. */
export const DEFAULT_TOPICS: readonly string[] = [
  'last-mile delivery Zimbabwe',
  'delivery app Zambia',
  'parcel delivery app Africa',
  'motorcycle delivery riders Africa app',
  'mobile money rider wallet delivery Africa',
  'delivery rider licence regulation Africa',
];

const MAX_BODY_BYTES = 512_000;
const MAX_ITEMS_PER_TOPIC = 10;
const KEEP_NEWEST = 300;
const FETCH_TIMEOUT_MS = 8_000;

const TAG_WORDS: ReadonlyArray<readonly [InsightTag, RegExp]> = [
  ['payments', /\b(mobile money|ecocash|onemoney|mtn momo|airtel money|wallet|payout|payment|float|fintech)\b/i],
  ['regulation', /\b(licen[cs]e|regulat|law|ban|permit|tax|government|ministry|compliance|court)\b/i],
  ['safety', /\b(safety|accident|robbery|killed|crash|theft|stolen|insurance|helmet)\b/i],
  ['pricing', /\b(price|pricing|fare|fee|commission|fuel|cost|discount|surge)\b/i],
  ['expansion', /\b(launch\w*|expand\w*|expansion|enter(s|ed|ing)?|new market|opens? in|rolls? out)\b/i],
  ['product', /\b(feature|update|new app|tracking|upgrade|version|introduces?)\b/i],
];

/** The first tag whose words appear, in the order above. */
export function classify(text: string): InsightTag {
  return TAG_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e] ?? '');
const stripTags = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const field = (block: string, name: string): string => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m?.[1] ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
};

/** Reads RSS items. Keeps only https links, so a feed cannot hand the dashboard a javascript: or http: link. */
export function parseRss(xml: string): RawItem[] {
  const items: RawItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1] ?? '';
    const url = decode(field(block, 'link'));
    const title = stripTags(decode(field(block, 'title')));
    if (!title || !/^https:\/\//i.test(url)) continue;
    const when = Date.parse(field(block, 'pubDate'));
    items.push({
      title: title.slice(0, 300),
      url: url.slice(0, 1000),
      source: stripTags(decode(field(block, 'source'))).slice(0, 100) || 'Unknown',
      publishedAt: Number.isNaN(when) ? null : new Date(when).toISOString(),
      summary: stripTags(decode(decode(field(block, 'description')))).slice(0, 500),
    });
  }
  return items;
}

/** Reads at most `max` bytes of a response body, so a huge reply cannot fill memory. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, max);
}

/** Public Google News RSS search. Only the search words leave the server. */
export function rssProvider(fetchFn: typeof fetch = fetch): ResearchProvider {
  return {
    async search(query: string): Promise<RawItem[]> {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en&gl=ZA&ceid=ZA:en`;
      const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/rss+xml, text/xml' } });
      if (!res.ok) throw new Error(`research ${res.status}`);
      return parseRss(await readCapped(res, MAX_BODY_BYTES)).slice(0, MAX_ITEMS_PER_TOPIC);
    },
  };
}

export interface RefreshResult {
  added: number;
  failedTopics: string[];
}

/** One topic failing never stops the others; failures are reported, not retried. */
export async function refreshInsights(pool: pg.Pool, provider: ResearchProvider, topics: readonly string[]): Promise<RefreshResult> {
  let added = 0;
  const failedTopics: string[] = [];
  for (const topic of topics) {
    let items: RawItem[];
    try {
      items = await provider.search(topic);
    } catch {
      failedTopics.push(topic);
      continue;
    }
    for (const it of items) {
      const res = await pool.query(
        `INSERT INTO insights (url, title, source, tag, topic, summary, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (url) DO NOTHING`,
        [it.url, it.title, it.source, classify(`${it.title} ${it.summary}`), topic, it.summary, it.publishedAt],
      );
      added += res.rowCount ?? 0;
    }
  }
  await pool.query(
    `DELETE FROM insights WHERE id NOT IN (SELECT id FROM insights ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $1)`,
    [KEEP_NEWEST],
  );
  return { added, failedTopics };
}

export interface InsightRow {
  id: number;
  title: string;
  url: string;
  source: string;
  tag: InsightTag;
  topic: string;
  summary: string;
  publishedAt: string | null;
}

export async function listInsights(pool: pg.Pool, limit: number): Promise<InsightRow[]> {
  const { rows } = await pool.query(
    'SELECT id, title, url, source, tag, topic, summary, published_at FROM insights ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $1',
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    url: r.url,
    source: r.source,
    tag: r.tag,
    topic: r.topic,
    summary: r.summary,
    publishedAt: r.published_at ? (r.published_at as Date).toISOString() : null,
  }));
}
