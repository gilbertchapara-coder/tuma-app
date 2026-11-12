import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { classify, parseRss, rssProvider, type RawItem, type ResearchProvider } from '../src/intelligence/research';
import { auth, createCtx, type TestCtx } from './helpers';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Bolt launches mobile money payments for riders - TechCabal</title><link>https://example.com/a?x=1&amp;y=2</link>
<pubDate>Tue, 10 Nov 2026 08:00:00 GMT</pubDate><source url="https://techcabal.com">TechCabal</source>
<description>&lt;a href="x"&gt;Bolt&lt;/a&gt; adds EcoCash &amp; wallet payouts.</description></item>
<item><title>Unsafe link</title><link>javascript:alert(1)</link><description>nope</description></item>
<item><title>Plain http link</title><link>http://example.com/b</link></item>
</channel></rss>`;

describe('parseRss', () => {
  it('reads items, decodes entities, strips markup and keeps only https links', () => {
    const items = parseRss(RSS);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Bolt launches mobile money payments for riders - TechCabal',
      url: 'https://example.com/a?x=1&y=2',
      source: 'TechCabal',
      summary: 'Bolt adds EcoCash & wallet payouts.',
    });
    expect(items[0]?.publishedAt).toBe('2026-11-10T08:00:00.000Z');
  });

  it('survives garbage', () => {
    expect(parseRss('')).toEqual([]);
    expect(parseRss('<item><title>x</title>')).toEqual([]);
  });
});

describe('classify', () => {
  it('tags by what the news is about', () => {
    expect(classify('Bolt adds EcoCash mobile money payments')).toBe('payments');
    expect(classify('Delivery apps raise prices as fuel costs climb')).toBe('pricing');
    expect(classify('Government to licence motorbike riders')).toBe('regulation');
    expect(classify('Rider killed in robbery, safety concerns grow')).toBe('safety');
    expect(classify('Glovo launches in Lusaka')).toBe('expansion');
    expect(classify('A cat sat on a mat')).toBe('other');
  });
});

describe('rssProvider', () => {
  it('sends only the search words, with no user data, and refuses a bad response', async () => {
    const fetchFn = vi.fn(async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    const items = await rssProvider(fetchFn).search('parcel delivery app Africa');
    expect(items).toHaveLength(1);
    const url = String((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]);
    expect(url).toContain('news.google.com/rss/search');
    expect(url).toContain('parcel%20delivery%20app%20Africa');
    const bad = vi.fn(async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
    await expect(rssProvider(bad).search('x')).rejects.toThrow();
  });
});

let ctx: TestCtx;
let calls = 0;
const item = (n: number, title = `Story ${n}`): RawItem => ({ title, url: `https://example.com/${n}`, source: 'Example', publishedAt: '2026-11-10T08:00:00.000Z', summary: 'summary' });
const fake: ResearchProvider = {
  async search(q) {
    calls += 1;
    if (q.includes('FAIL')) throw new Error('down');
    return [item(1, 'Glovo launches in Lusaka'), item(2, 'Bolt adds mobile money payments')];
  },
};

beforeAll(async () => {
  ctx = await createCtx({ researchProvider: fake, researchTopics: ['topic one', 'topic FAIL'], researchMinGapMs: 0 });
});
afterAll(async () => ctx.close());

describe('insights routes', () => {
  it('are for admins only', async () => {
    const shop = await ctx.signIn('+263771600001', 'shop');
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/insights', headers: auth(shop.token) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/admin/insights/refresh', headers: auth(shop.token) })).statusCode).toBe(403);
  });

  it('refresh stores new items, reports the topic that failed, and does not duplicate on a second run', async () => {
    const admin = auth(await ctx.adminToken());
    const first = (await ctx.app.inject({ method: 'POST', url: '/admin/insights/refresh', headers: admin })).json();
    expect(first).toMatchObject({ added: 2, failedTopics: ['topic FAIL'] });
    const second = (await ctx.app.inject({ method: 'POST', url: '/admin/insights/refresh', headers: admin })).json();
    expect(second.added).toBe(0);
    const list = (await ctx.app.inject({ method: 'GET', url: '/admin/insights', headers: admin })).json();
    expect(list.insights).toHaveLength(2);
    expect(list.insights.map((i: { tag: string }) => i.tag).sort()).toEqual(['expansion', 'payments']);
    expect(list.advisoryOnly).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});

describe('insights throttle', () => {
  it('refuses a second refresh inside the minimum gap', async () => {
    const slow = await createCtx({ researchProvider: fake, researchTopics: ['t'], researchMinGapMs: 600_000 });
    const admin = auth(await slow.adminToken());
    expect((await slow.app.inject({ method: 'POST', url: '/admin/insights/refresh', headers: admin })).statusCode).toBe(200);
    expect((await slow.app.inject({ method: 'POST', url: '/admin/insights/refresh', headers: admin })).statusCode).toBe(429);
    await slow.close();
  });

  it('says plainly when no research source is connected', async () => {
    const none = await createCtx({});
    const res = await none.app.inject({ method: 'POST', url: '/admin/insights/refresh', headers: auth(await none.adminToken()) });
    expect(res.statusCode).toBe(409);
    await none.close();
  });
});
