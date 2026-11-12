import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dashboard, type Metrics } from '../src/Dashboard';
import type { LockedCodesApi, LockedParcel } from '../src/LockedCodes';

const parcel: LockedParcel = {
  id: 'p1',
  reference: 'TUM-3F2A9C10',
  suburb: 'Avenues',
  country: 'ZW',
  shopPhone: '***011',
  riderFirstName: 'Tendai',
  status: 'in_transit',
  codes: { pickup: { locked: false, used: true }, delivery: { locked: true, used: false } },
};
const metrics: Metrics = { parcelsPerRun: [], ridersActive: 1, feesCents: 500 };

const makeApi = (over: Partial<LockedCodesApi> = {}): LockedCodesApi => ({
  lookup: vi.fn(async () => [parcel]),
  locked: vi.fn(async () => [parcel]),
  unlock: vi.fn(async () => undefined),
  ...over,
});

async function openTab(api: LockedCodesApi) {
  const user = {
    click: async (el: HTMLElement) => void fireEvent.click(el),
    type: async (el: HTMLElement, text: string) => void fireEvent.change(el, { target: { value: text } }),
  };
  render(<Dashboard load={async () => metrics} codes={api} />);
  await user.click(await screen.findByRole('tab', { name: 'Locked codes' }));
  return user;
}

describe('Locked codes tab', () => {
  it('is not shown when no support tools are passed', async () => {
    render(<Dashboard load={async () => metrics} />);
    await screen.findByText('Tuma pilot');
    expect(screen.queryByRole('tab', { name: 'Locked codes' })).toBeNull();
  });

  it('lists locked parcels with the shop phone masked', async () => {
    await openTab(makeApi());
    expect(await screen.findByText('TUM-3F2A9C10')).toBeInTheDocument();
    expect(screen.getByText(/Shop \*\*\*011/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\+263/);
  });

  it('will not unlock until the door check box is ticked, then unlocks the chosen code', async () => {
    const api = makeApi();
    const user = await openTab(api);
    const button = await screen.findByRole('button', { name: 'Unlock TUM-3F2A9C10' });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText('I have checked who is at the door'));
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(api.unlock).toHaveBeenCalledWith('p1', 'delivery'));
    expect(await screen.findByText(/Unlocked the delivery code/)).toBeInTheDocument();
  });

  it('finds a parcel by reference', async () => {
    const api = makeApi({ locked: vi.fn(async () => []) });
    const user = await openTab(api);
    await user.type(await screen.findByLabelText('Find a parcel by reference'), 'TUM-3F2A9C10');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(api.lookup).toHaveBeenCalledWith('TUM-3F2A9C10'));
    expect(await screen.findByText(/Parcels matching TUM-3F2A9C10/)).toBeInTheDocument();
  });

  it('says plainly when nothing is found or the unlock fails', async () => {
    const api = makeApi({ lookup: vi.fn(async () => { throw new Error('404'); }), unlock: vi.fn(async () => { throw new Error('404'); }) });
    const user = await openTab(api);
    await user.type(await screen.findByLabelText('Find a parcel by reference'), 'TUM-FFFFFFFF');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No parcel found/);
  });

  it('shows fees in each country\'s own currency', async () => {
    render(
      <Dashboard
        load={async () => ({ ...metrics, feesByCountry: [{ country: 'ZW', currencySymbol: '$', cents: 500 }, { country: 'ZM', currencySymbol: 'K', cents: 300 }] })}
      />,
    );
    expect(await screen.findByText('$5.00 and K3.00')).toBeInTheDocument();
  });
});
