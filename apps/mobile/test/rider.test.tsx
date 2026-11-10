import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CustodyEvent } from '@tuma/core/src/custody';
import { Bundles } from '../src/rider/Bundles';
import { Run } from '../src/rider/Run';
import { enqueueEvent, pendingCount } from '../src/rider/scanQueue';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

beforeEach(async () => {
  await AsyncStorage.clear();
});

const disabled = (el: { props: { accessibilityState?: { disabled?: boolean } } }) =>
  el.props.accessibilityState?.disabled === true;

const bundles = [
  { id: 'b1', run: 'north', level: 'standard', dropOrder: ['Avenues', 'Milton Park'], parcelCount: 3 },
  { id: 'b2', run: 'south', level: 'express', dropOrder: ['Waterfalls'], parcelCount: 1 },
];

describe('Bundles', () => {
  it('shows the rider tier and value cap', () => {
    render(
      <Bundles summary={{ tier: 'trusted', balanceCents: 500, depositCents: 2000 }} bundles={bundles} onAccept={jest.fn()} />,
    );
    expect(screen.getByText('Trusted rider')).toBeTruthy();
    expect(screen.getByText('You can carry parcels worth up to $100.00 each')).toBeTruthy();
  });

  it('with no float says "top up to accept" and does not let the rider accept', () => {
    const onAccept = jest.fn();
    render(
      <Bundles summary={{ tier: 'new', balanceCents: 0, depositCents: 2000 }} bundles={bundles} onAccept={onAccept} />,
    );
    expect(screen.getAllByText('Top up to accept').length).toBeGreaterThan(0);
    expect(screen.queryByText(/error|402|insufficient/i)).toBeNull();
    const accept = screen.getAllByRole('button', { name: /^Accept/ })[0]!;
    expect(disabled(accept)).toBe(true);
    fireEvent.press(accept);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('lists each bundle with its run, speed, drops and parcel count', () => {
    render(
      <Bundles summary={{ tier: 'new', balanceCents: 500, depositCents: 2000 }} bundles={bundles} onAccept={jest.fn()} />,
    );
    expect(screen.getByText('North run, Standard')).toBeTruthy();
    expect(screen.getByText('3 parcels: Avenues, Milton Park')).toBeTruthy();
    expect(screen.getByText('1 parcel: Waterfalls')).toBeTruthy();
  });

  it('accepts a bundle and says it is yours', async () => {
    const onAccept = jest.fn().mockResolvedValue('ok');
    render(
      <Bundles summary={{ tier: 'new', balanceCents: 500, depositCents: 2000 }} bundles={bundles} onAccept={onAccept} />,
    );
    fireEvent.press(screen.getAllByRole('button', { name: /^Accept/ })[0]!);
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('b1'));
    expect(await screen.findByText('Bundle accepted. Go to your run.')).toBeTruthy();
  });

  it.each([
    ['taken', 'Another rider took this bundle. Pick another.'],
    ['insufficient_float', 'Top up to accept'],
    ['over_cap', 'A parcel in this bundle is worth more than your level allows.'],
    ['failed', 'We could not accept this bundle. Check your signal and try again.'],
  ])('shows a plain message for %s', async (outcome, text) => {
    const onAccept = jest.fn().mockResolvedValue(outcome);
    render(
      <Bundles summary={{ tier: 'new', balanceCents: 500, depositCents: 2000 }} bundles={bundles} onAccept={onAccept} />,
    );
    fireEvent.press(screen.getAllByRole('button', { name: /^Accept/ })[0]!);
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
  });

  it('says so when there are no bundles', () => {
    render(<Bundles summary={{ tier: 'new', balanceCents: 500, depositCents: 0 }} bundles={[]} onAccept={jest.fn()} />);
    expect(screen.getByText('No bundles right now. Check again soon.')).toBeTruthy();
  });
});

describe('Run', () => {
  const parcels = [
    { id: 'p1', suburb: 'Avenues' },
    { id: 'p2', suburb: 'Milton Park' },
  ];
  const noDeliver = jest.fn().mockResolvedValue('ok');

  // Let the start-up sync finish inside act so no update lands after the test ends.
  afterEach(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });

  it('with the network off, a pickup scan is stored and the screen says "saved, will send"', async () => {
    const send = jest.fn().mockRejectedValue(new Error('offline'));
    const before = Date.now();
    render(<Run parcels={parcels} send={send} deliver={noDeliver} />);
    fireEvent.press(screen.getByRole('button', { name: 'Confirm pickup, Avenues' }));
    expect(await screen.findByText('Saved, will send')).toBeTruthy();
    expect(await pendingCount()).toBe(1);
    const stored = JSON.parse((await AsyncStorage.getItem('tuma_scan_queue')) ?? '[]');
    expect(stored[0].parcelId).toBe('p1');
    expect(stored[0].event.type).toBe('pickup_confirmed');
    expect(stored[0].event.actor).toBe('rider');
    expect(Date.parse(stored[0].event.at)).toBeGreaterThanOrEqual(before);
  });

  it('with signal, the scan is sent and the screen says "Sent"', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    render(<Run parcels={parcels} send={send} deliver={noDeliver} />);
    fireEvent.press(screen.getByRole('button', { name: 'Confirm pickup, Milton Park' }));
    expect(await screen.findByText('Sent')).toBeTruthy();
    expect(send).toHaveBeenCalledWith('p2', expect.objectContaining({ type: 'pickup_confirmed', actor: 'rider' }));
    expect(await pendingCount()).toBe(0);
  });

  it('sends saved scans when the screen opens, keeping their original time', async () => {
    const old: CustodyEvent = { type: 'pickup_confirmed', at: '2026-11-10T07:00:00.000Z', actor: 'rider' };
    await enqueueEvent('p1', old);
    const send = jest.fn().mockResolvedValue(undefined);
    render(<Run parcels={parcels} send={send} deliver={noDeliver} />);
    await waitFor(() => expect(send).toHaveBeenCalledWith('p1', old));
    await waitFor(async () => expect(await pendingCount()).toBe(0));
  });

  it('shows how many scans are waiting to send', async () => {
    await enqueueEvent('p1', { type: 'pickup_confirmed', at: '2026-11-10T07:00:00.000Z', actor: 'rider' });
    const send = jest.fn().mockRejectedValue(new Error('offline'));
    render(<Run parcels={parcels} send={send} deliver={noDeliver} />);
    expect(await screen.findByText('1 scan waiting to send')).toBeTruthy();
  });

  it('delivers with the code and says so', async () => {
    const deliver = jest.fn().mockResolvedValue('ok');
    render(<Run parcels={parcels} send={jest.fn()} deliver={deliver} />);
    fireEvent.changeText(screen.getByLabelText('Delivery code for Avenues'), '123456');
    fireEvent.press(screen.getByRole('button', { name: 'Deliver, Avenues' }));
    await waitFor(() => expect(deliver).toHaveBeenCalledWith('p1', '123456'));
    expect(await screen.findByText('Delivered')).toBeTruthy();
  });

  it('keeps Deliver off until a 6 digit code is typed', () => {
    render(<Run parcels={parcels} send={jest.fn()} deliver={noDeliver} />);
    expect(disabled(screen.getByRole('button', { name: 'Deliver, Avenues' }))).toBe(true);
    fireEvent.changeText(screen.getByLabelText('Delivery code for Avenues'), '12345');
    expect(disabled(screen.getByRole('button', { name: 'Deliver, Avenues' }))).toBe(true);
    fireEvent.changeText(screen.getByLabelText('Delivery code for Avenues'), '123456');
    expect(disabled(screen.getByRole('button', { name: 'Deliver, Avenues' }))).toBe(false);
  });

  it.each([
    ['wrong_code', 'That code is not right. Ask the recipient again.'],
    ['locked', 'Too many wrong tries. Call Tuma support.'],
    ['no_signal', 'No signal. Try again when you have signal.'],
  ])('shows a plain message for %s', async (outcome, text) => {
    const deliver = jest.fn().mockResolvedValue(outcome);
    render(<Run parcels={parcels} send={jest.fn()} deliver={deliver} />);
    fireEvent.changeText(screen.getByLabelText('Delivery code for Avenues'), '123456');
    fireEvent.press(screen.getByRole('button', { name: 'Deliver, Avenues' }));
    expect(await screen.findByText(text)).toBeTruthy();
  });
});
