import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BookParcel } from '../src/shop/BookParcel';
import { MyParcels } from '../src/shop/MyParcels';
import { parseDollarsToCents } from '../src/shop/bookingForm';

const PHOTO = 'https://photos.test/sealed.jpg';

const next = () => screen.getByRole('button', { name: /^Next/ });
const book = () => screen.getByRole('button', { name: /^Book parcel/ });
const disabled = (el: { props: { accessibilityState?: { disabled?: boolean } } }) =>
  el.props.accessibilityState?.disabled === true;

function chooseSuburb(name = 'Avenues') {
  fireEvent.press(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
  fireEvent.press(next());
}

function chooseSpeed(name: RegExp = /Standard/) {
  fireEvent.press(screen.getByRole('button', { name }));
  fireEvent.press(next());
}

function fillDetails(confirm = '+263771234567') {
  fireEvent.changeText(screen.getByLabelText('What is in the parcel'), 'Phone case');
  fireEvent.changeText(screen.getByLabelText('Value in dollars'), '20');
  fireEvent.changeText(screen.getByLabelText('Recipient phone'), '+263771234567');
  fireEvent.changeText(screen.getByLabelText('Type the recipient phone again'), confirm);
}

function renderForm(onSubmit = jest.fn().mockResolvedValue(undefined), pickPhoto = async () => PHOTO) {
  render(<BookParcel pickPhoto={pickPhoto} onSubmit={onSubmit} />);
  return onSubmit;
}

async function reachConfirmStep(onSubmit?: jest.Mock) {
  const fn = renderForm(onSubmit);
  chooseSuburb();
  chooseSpeed();
  fillDetails();
  fireEvent.press(next());
  return fn;
}

const addPhoto = async () => {
  fireEvent.press(screen.getByRole('button', { name: 'Add photo of sealed parcel' }));
  await waitFor(() => expect(screen.getByText('Photo added')).toBeTruthy());
};

describe('BookParcel steps', () => {
  it('step 1: Next stays off until a suburb is chosen', () => {
    renderForm();
    expect(screen.getByText('Where is it going?')).toBeTruthy();
    expect(disabled(next())).toBe(true);
    fireEvent.press(screen.getByRole('button', { name: /^Waterfalls/ }));
    expect(disabled(next())).toBe(false);
  });

  it('step 2: shows the price on every speed row and on the button', () => {
    renderForm();
    chooseSuburb('Waterfalls');
    expect(screen.getByText('How fast?')).toBeTruthy();
    expect(screen.getByText('$3.50')).toBeTruthy();
    expect(screen.getByText('$2.00')).toBeTruthy();
    expect(screen.getByText('$1.70')).toBeTruthy();
    expect(disabled(next())).toBe(true);
    fireEvent.press(screen.getByRole('button', { name: /Overnight/ }));
    expect(screen.getByRole('button', { name: 'Next, $1.70' })).toBeTruthy();
  });

  it('Back keeps what was already chosen', () => {
    renderForm();
    chooseSuburb('Mbare');
    fireEvent.press(screen.getByRole('button', { name: /Express/ }));
    fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Where is it going?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Mbare/ }).props.accessibilityState.selected).toBe(true);
    fireEvent.press(next());
    expect(screen.getByRole('button', { name: /Express/ }).props.accessibilityState.selected).toBe(true);
  });

  it('step 3: keeps Next off until the phone is typed twice and matches', () => {
    renderForm();
    chooseSuburb();
    chooseSpeed();
    fillDetails('+263771234568');
    expect(disabled(next())).toBe(true);
    expect(screen.getByText('The two phone numbers do not match')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Type the recipient phone again'), '+263771234567');
    expect(disabled(next())).toBe(false);
  });

  it('step 3: needs contents and a value above zero with at most two decimals', () => {
    renderForm();
    chooseSuburb();
    chooseSpeed();
    fillDetails();
    fireEvent.changeText(screen.getByLabelText('What is in the parcel'), '   ');
    expect(disabled(next())).toBe(true);
    fireEvent.changeText(screen.getByLabelText('What is in the parcel'), 'Phone case');
    for (const bad of ['0', '-5', '1.555', 'abc', '']) {
      fireEvent.changeText(screen.getByLabelText('Value in dollars'), bad);
      expect(disabled(next())).toBe(true);
    }
    fireEvent.changeText(screen.getByLabelText('Value in dollars'), '20.50');
    expect(disabled(next())).toBe(false);
  });

  it('step 4: shows a summary and keeps Book off until the photo is added', async () => {
    await reachConfirmStep();
    expect(screen.getByText('Photo and confirm')).toBeTruthy();
    expect(screen.getByText('Avenues')).toBeTruthy();
    expect(screen.getByText('Standard')).toBeTruthy();
    expect(disabled(book())).toBe(true);
    await addPhoto();
    expect(disabled(book())).toBe(false);
    expect(screen.getByRole('button', { name: 'Book parcel, $1.20' })).toBeTruthy();
  });

  it('sends exactly what the API expects, with the value in whole cents', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    renderForm(onSubmit);
    chooseSuburb();
    chooseSpeed();
    fillDetails();
    fireEvent.changeText(screen.getByLabelText('Value in dollars'), '20.50');
    fireEvent.press(next());
    await addPhoto();
    fireEvent.press(book());
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

  it('starts again at step 1 after a successful booking', async () => {
    await reachConfirmStep();
    await addPhoto();
    fireEvent.press(book());
    expect(await screen.findByText('Where is it going?')).toBeTruthy();
  });

  it('does not submit twice on a double tap and shows a plain error if booking fails', async () => {
    let reject: (e: Error) => void = () => undefined;
    const onSubmit = jest.fn(
      () => new Promise<void>((_, r) => {
        reject = r;
      }),
    );
    await reachConfirmStep(onSubmit);
    await addPhoto();
    fireEvent.press(book());
    fireEvent.press(book());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    reject(new Error('boom'));
    expect(await screen.findByText('We could not book this parcel. Check your connection and try again.')).toBeTruthy();
    expect(disabled(book())).toBe(false);
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
    render(
      <MyParcels
        load={async () => {
          throw new Error('x');
        }}
      />,
    );
    expect(await screen.findByText('We could not load your parcels. Pull down to try again.')).toBeTruthy();
  });
});
