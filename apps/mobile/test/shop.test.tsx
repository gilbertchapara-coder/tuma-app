import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BookParcel } from '../src/shop/BookParcel';
import { MyParcels } from '../src/shop/MyParcels';
import { parseDollarsToCents } from '../src/shop/bookingForm';

const PHOTO = 'https://photos.test/sealed.jpg';

function fillValid(over: { phoneConfirm?: string } = {}) {
  fireEvent.press(screen.getByRole('button', { name: 'Avenues' }));
  fireEvent.press(screen.getByRole('button', { name: /Standard/ }));
  fireEvent.changeText(screen.getByLabelText('What is in the parcel'), 'Phone case');
  fireEvent.changeText(screen.getByLabelText('Value in dollars'), '20');
  fireEvent.changeText(screen.getByLabelText('Recipient phone'), '+263771234567');
  fireEvent.changeText(screen.getByLabelText('Type the recipient phone again'), over.phoneConfirm ?? '+263771234567');
}

const submitButton = () => screen.getByRole('button', { name: 'Book parcel' });

describe('BookParcel', () => {
  it('shows the table price as soon as suburb and level are chosen', () => {
    render(<BookParcel pickPhoto={async () => PHOTO} onSubmit={jest.fn()} />);
    expect(screen.queryByText(/Price:/)).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Waterfalls' }));
    expect(screen.queryByText(/Price:/)).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: /Express/ }));
    expect(screen.getByText('Price: $3.50')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: /Overnight/ }));
    expect(screen.getByText('Price: $1.70')).toBeTruthy();
  });

  it('shows the price in dollars and cents', () => {
    render(<BookParcel pickPhoto={async () => PHOTO} onSubmit={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Avenues' }));
    fireEvent.press(screen.getByRole('button', { name: /Overnight/ }));
    expect(screen.getByText('Price: $1.00')).toBeTruthy();
  });

  it('keeps submit disabled until the recipient phone is typed twice and matches', async () => {
    render(<BookParcel pickPhoto={async () => PHOTO} onSubmit={jest.fn()} />);
    fillValid({ phoneConfirm: '+263771234568' });
    fireEvent.press(screen.getByRole('button', { name: 'Add photo of sealed parcel' }));
    await waitFor(() => expect(screen.getByText('Photo added')).toBeTruthy());
    expect(submitButton().props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('The two phone numbers do not match')).toBeTruthy();

    fireEvent.changeText(screen.getByLabelText('Type the recipient phone again'), '+263771234567');
    expect(submitButton().props.accessibilityState.disabled).toBe(false);
  });

  it('requires contents, a value and a photo of the sealed parcel', async () => {
    render(<BookParcel pickPhoto={async () => PHOTO} onSubmit={jest.fn()} />);
    fillValid();
    expect(submitButton().props.accessibilityState.disabled).toBe(true); // no photo yet

    fireEvent.press(screen.getByRole('button', { name: 'Add photo of sealed parcel' }));
    await waitFor(() => expect(submitButton().props.accessibilityState.disabled).toBe(false));

    fireEvent.changeText(screen.getByLabelText('What is in the parcel'), '   ');
    expect(submitButton().props.accessibilityState.disabled).toBe(true);
    fireEvent.changeText(screen.getByLabelText('What is in the parcel'), 'Phone case');

    for (const bad of ['0', '-5', '1.555', 'abc', '']) {
      fireEvent.changeText(screen.getByLabelText('Value in dollars'), bad);
      expect(submitButton().props.accessibilityState.disabled).toBe(true);
    }
  });

  it('sends exactly what the API expects, with the value in whole cents', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<BookParcel pickPhoto={async () => PHOTO} onSubmit={onSubmit} />);
    fillValid();
    fireEvent.changeText(screen.getByLabelText('Value in dollars'), '20.50');
    fireEvent.press(screen.getByRole('button', { name: 'Add photo of sealed parcel' }));
    await waitFor(() => expect(submitButton().props.accessibilityState.disabled).toBe(false));
    fireEvent.press(submitButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      suburb: 'Avenues',
      level: 'standard',
      valueCents: 2050,
      contents: 'Phone case',
      recipientPhone: '+263771234567',
      recipientPhoneConfirm: '+263771234567',
      sealedPhotoUrl: PHOTO,
    });
  });

  it('does not submit twice on a double tap and shows a plain error if booking fails', async () => {
    let reject: (e: Error) => void = () => undefined;
    const onSubmit = jest.fn(() => new Promise<void>((_, r) => { reject = r; }));
    render(<BookParcel pickPhoto={async () => PHOTO} onSubmit={onSubmit} />);
    fillValid();
    fireEvent.press(screen.getByRole('button', { name: 'Add photo of sealed parcel' }));
    await waitFor(() => expect(submitButton().props.accessibilityState.disabled).toBe(false));
    fireEvent.press(submitButton());
    fireEvent.press(submitButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    reject(new Error('boom'));
    expect(await screen.findByText('We could not book this parcel. Check your connection and try again.')).toBeTruthy();
    expect(submitButton().props.accessibilityState.disabled).toBe(false);
  });
});

describe('parseDollarsToCents', () => {
  it.each([
    ['20', 2000],
    ['20.5', 2050],
    ['0.01', 1],
    [' 7.25 ', 725],
  ])('%s -> %i', (input, cents) => expect(parseDollarsToCents(input)).toBe(cents));

  it.each(['', '0', '0.00', '-1', '1.234', 'abc', '1e3', '1,5'])('rejects %j', (input) =>
    expect(parseDollarsToCents(input)).toBeNull(),
  );
});

describe('MyParcels', () => {
  const parcels = [
    { id: 'a', suburb: 'Mbare', level: 'standard', priceCents: 130, stage: 'Booked', createdAt: '2026-11-10T08:00:00.000Z' },
    { id: 'b', suburb: 'Avenues', level: 'express', priceCents: 200, stage: 'Delivered', createdAt: '2026-11-09T08:00:00.000Z' },
  ];

  it('lists parcels with suburb, stage and price in dollars', async () => {
    render(<MyParcels load={async () => parcels} />);
    expect(await screen.findByText('Mbare')).toBeTruthy();
    expect(screen.getByText('Booked')).toBeTruthy();
    expect(screen.getByText('$1.30')).toBeTruthy();
    expect(screen.getByText('Delivered')).toBeTruthy();
  });

  it('says plainly when there are no parcels or loading fails', async () => {
    const { unmount } = render(<MyParcels load={async () => []} />);
    expect(await screen.findByText('No parcels yet. Book your first one.')).toBeTruthy();
    unmount();
    render(<MyParcels load={async () => { throw new Error('x'); }} />);
    expect(await screen.findByText('We could not load your parcels. Pull down to try again.')).toBeTruthy();
  });
});
