import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClaimsAdmin, type Claim } from '../src/ClaimsAdmin';
import { CountriesAdmin, percentToBps, type AdminCountry, type CountriesApi } from '../src/CountriesAdmin';
import { Dashboard } from '../src/Dashboard';

const zw: AdminCountry = { code: 'ZW', name: 'Zimbabwe', currencySymbol: '$', open: true, platformBps: null, suburbs: [{ name: 'Avenues' }] };
const zm: AdminCountry = { code: 'ZM', name: 'Zambia', currencySymbol: 'K', open: false, platformBps: null, suburbs: [] };

const makeApi = (over: Partial<CountriesApi> = {}): CountriesApi => ({
  list: vi.fn(async () => [zw, zm]),
  save: vi.fn(async () => undefined),
  ...over,
});

describe('percentToBps', () => {
  it('turns percent text into basis points and rejects nonsense', () => {
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('0')).toBe(0);
    expect(percentToBps('100')).toBe(10000);
    for (const bad of ['', 'abc', '-1', '101', '1.234', '1e3']) expect(percentToBps(bad)).toBeNull();
  });
});

describe('Countries tab', () => {
  it('shows Zambia as closed and Zimbabwe percentage as not set', async () => {
    render(<CountriesAdmin api={makeApi()} />);
    expect(await screen.findByText(/Closed: load suburbs and prices/)).toBeInTheDocument();
    expect(screen.getAllByText("Tuma's percentage is not set")).toHaveLength(2);
  });

  it('saves a percentage in basis points', async () => {
    const api = makeApi();
    render(<CountriesAdmin api={api} />);
    fireEvent.change(await screen.findByLabelText("Tuma's percentage for Zimbabwe"), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save percentage for Zimbabwe' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('ZW', { platformBps: 1250 }));
  });

  it('will not save above 30% until the box is ticked, then sends the confirmation', async () => {
    const api = makeApi();
    render(<CountriesAdmin api={api} />);
    fireEvent.change(await screen.findByLabelText("Tuma's percentage for Zimbabwe"), { target: { value: '45' } });
    const button = screen.getByRole('button', { name: 'Save percentage for Zimbabwe' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I mean 45%/));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('ZW', { platformBps: 4500, confirmHighPercentage: true }));
  });

  it('loads suburbs and prices from pasted JSON and refuses bad JSON', async () => {
    const api = makeApi();
    render(<CountriesAdmin api={api} />);
    const box = await screen.findByLabelText('Suburbs and prices (JSON) for Zambia');
    const save = screen.getByRole('button', { name: 'Save suburbs and prices for Zambia' });
    fireEvent.change(box, { target: { value: '{nope' } });
    fireEvent.click(save);
    expect(await screen.findByText('That is not valid JSON.')).toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();
    const body = { suburbs: { Kabulonga: { band: 'A', run: 'south' } }, prices: { A: [3000, 2000, 1500] } };
    fireEvent.change(box, { target: { value: JSON.stringify(body) } });
    fireEvent.click(save);
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('ZM', body));
  });

  it('says plainly when the save fails', async () => {
    render(<CountriesAdmin api={makeApi({ save: vi.fn(async () => { throw new Error('400'); }) })} />);
    fireEvent.change(await screen.findByLabelText("Tuma's percentage for Zimbabwe"), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save percentage for Zimbabwe' }));
    expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
  });
});

const claim: Claim = { id: 'c1', parcelId: 'p1', status: 'open', filedBy: 'shop', liable: null, payoutCents: null, suburb: 'Mbare', valueCents: 2000, createdAt: '2026-11-12T08:00:00Z' };

describe('Claims tab', () => {
  it('lists open claims and dismisses one', async () => {
    const open = vi.fn().mockResolvedValueOnce([claim]).mockResolvedValue([]);
    const dismiss = vi.fn(async () => undefined);
    render(<ClaimsAdmin api={{ open, dismiss }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss claim for Mbare' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('c1'));
    expect(await screen.findByText('No open claims.')).toBeInTheDocument();
  });

  it('is reachable from the dashboard tabs', async () => {
    render(
      <Dashboard
        load={async () => ({ parcelsPerRun: [], ridersActive: 0, feesCents: 0 })}
        countries={makeApi()}
        claims={{ open: async () => [], dismiss: async () => undefined }}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Countries' }));
    expect(await screen.findByText('Zimbabwe ($)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Claims' }));
    expect(await screen.findByText('No open claims.')).toBeInTheDocument();
  });
});
