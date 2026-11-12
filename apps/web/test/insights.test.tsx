import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../src/Dashboard';
import { InsightsAdmin, safeHttpsUrl, type Insight, type InsightsApi } from '../src/InsightsAdmin';

const item = (over: Partial<Insight> = {}): Insight => ({
  id: 1,
  title: 'Glovo launches in Lusaka',
  url: 'https://example.com/a',
  source: 'Example News',
  tag: 'expansion',
  topic: 'delivery app Zambia',
  summary: 'A summary.',
  publishedAt: '2026-11-10T08:00:00.000Z',
  ...over,
});

const makeApi = (over: Partial<InsightsApi> = {}): InsightsApi => ({
  list: vi.fn(async () => ({ connected: true, insights: [item(), item({ id: 2, title: 'Bolt adds EcoCash', tag: 'payments' })] })),
  refresh: vi.fn(async () => ({ added: 3, failedTopics: [] })),
  ...over,
});

describe('safeHttpsUrl', () => {
  it('lets only https links through', () => {
    expect(safeHttpsUrl('https://example.com/x')).toBe('https://example.com/x');
    for (const bad of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', '']) expect(safeHttpsUrl(bad)).toBeUndefined();
  });
});

describe('Insights tab', () => {
  it('lists findings with their tag and says nothing here changes settings', async () => {
    render(<InsightsAdmin api={makeApi()} />);
    expect(await screen.findByText('Glovo launches in Lusaka')).toBeInTheDocument();
    expect(screen.getByText('Bolt adds EcoCash')).toBeInTheDocument();
    expect(screen.getByText(/does not change any price or setting/i)).toBeInTheDocument();
    expect(screen.getByText('expansion')).toBeInTheDocument();
  });

  it('opens links safely, and shows no link for an unsafe address', async () => {
    const api = makeApi({ list: vi.fn(async () => ({ connected: true, insights: [item(), item({ id: 3, title: 'Bad link', url: 'javascript:alert(1)' })] })) });
    render(<InsightsAdmin api={api} />);
    const good = await screen.findByRole('link', { name: /Glovo launches in Lusaka/ });
    expect(good).toHaveAttribute('href', 'https://example.com/a');
    expect(good).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: /Bad link/ })).toBeNull();
    expect(screen.getByText('Bad link')).toBeInTheDocument();
  });

  it('refreshes and reports how many were added and which searches failed', async () => {
    const refresh = vi.fn(async () => ({ added: 3, failedTopics: ['delivery app Zambia'] }));
    render(<InsightsAdmin api={makeApi({ refresh })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for new updates' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText(/3 new/)).toBeInTheDocument();
    expect(screen.getByText(/1 search failed/)).toBeInTheDocument();
  });

  it('says plainly when the refresh is refused or no source is connected', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('429');
    });
    render(<InsightsAdmin api={makeApi({ refresh })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for new updates' }));
    expect(await screen.findByText(/Could not search/)).toBeInTheDocument();

    render(<InsightsAdmin api={makeApi({ list: vi.fn(async () => ({ connected: false, insights: [] })) })} />);
    expect(await screen.findByText(/No research source is connected/)).toBeInTheDocument();
  });

  it('is reachable from the dashboard tabs', async () => {
    render(<Dashboard load={async () => ({ parcelsPerRun: [], ridersActive: 0, feesCents: 0 })} insights={makeApi()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Insights' }));
    expect(await screen.findByText('Glovo launches in Lusaka')).toBeInTheDocument();
  });
});
