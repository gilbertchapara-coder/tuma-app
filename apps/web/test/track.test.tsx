import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dashboard, type Metrics } from '../src/Dashboard';
import { Track, type TrackData } from '../src/Track';

const parcel: TrackData = {
  status: 'in_transit',
  stage: 'On the way',
  suburb: 'Waterfalls',
  run: 'south',
  phoneLast3: '123',
  rider: { firstName: 'Tendai', tier: 'trusted' },
  events: [
    { stage: 'Booked', at: '2026-11-10T08:00:00.000Z' },
    { stage: 'Picked up', at: '2026-11-10T09:30:00.000Z' },
  ],
};

describe('Track page', () => {
  it('shows status, run and the masked phone', async () => {
    render(<Track token="t" load={async () => parcel} />);
    expect(await screen.findByText('On the way')).toBeInTheDocument();
    expect(screen.getByText(/south run/i)).toBeInTheDocument();
    expect(screen.getByText('***123')).toBeInTheDocument();
    expect(screen.getByText(/Waterfalls/)).toBeInTheDocument();
  });

  it('never renders a full phone number or a delivery code', async () => {
    const leaky = { ...parcel, recipientPhone: '+263772000123', code: '482913' } as TrackData;
    const { container } = render(<Track token="t" load={async () => leaky} />);
    await screen.findByText('On the way');
    expect(container.textContent).not.toMatch(/\+263|263772|482913/);
  });

  it('says plainly when the parcel is not found', async () => {
    render(<Track token="bad" load={async () => null} />);
    expect(await screen.findByText(/we cannot find this parcel/i)).toBeInTheDocument();
  });

  it('says plainly when the page cannot load', async () => {
    const load = vi.fn().mockRejectedValue(new Error('network'));
    render(<Track token="t" load={load} />);
    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeInTheDocument());
  });
});

describe('Dashboard', () => {
  const metrics: Metrics = {
    parcelsPerRun: [
      { run: 'north', date: '2026-11-10', count: 7 },
      { run: 'south', date: '2026-11-10', count: 3 },
    ],
    ridersActive: 4,
    feesCents: 1275,
  };

  it('shows parcels per run per day and flags runs under 5 parcels', async () => {
    render(<Dashboard load={async () => metrics} />);
    const north = await screen.findByRole('row', { name: /north/i });
    const south = screen.getByRole('row', { name: /south/i });
    expect(north).toHaveTextContent('7');
    expect(north).not.toHaveTextContent(/too few/i);
    expect(south).toHaveTextContent('3');
    expect(south).toHaveTextContent(/too few/i);
  });

  it('shows active riders and fees in dollars', async () => {
    render(<Dashboard load={async () => metrics} />);
    expect(await screen.findByText('4')).toBeInTheDocument();
    expect(screen.getByText('$12.75')).toBeInTheDocument();
  });

  it('shows a plain message when there are no parcels yet', async () => {
    render(<Dashboard load={async () => ({ parcelsPerRun: [], ridersActive: 0, feesCents: 0 })} />);
    expect(await screen.findByText(/no parcels yet/i)).toBeInTheDocument();
  });
});
