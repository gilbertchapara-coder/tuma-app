import { priceCents, type ServiceLevel } from '@tuma/core/src/pricing';
import { SUBURBS } from '@tuma/core/src/suburbs';

export const SUBURB_NAMES: readonly string[] = Object.keys(SUBURBS);

export const LEVELS: ReadonlyArray<{ id: ServiceLevel; label: string; hint: string }> = [
  { id: 'express', label: 'Express', hint: 'goes now' },
  { id: 'standard', label: 'Standard', hint: 'same day' },
  { id: 'overnight', label: 'Overnight', hint: 'next morning' },
];

export interface BookingForm {
  suburb: string | null;
  level: ServiceLevel | null;
  contents: string;
  valueText: string;
  recipientPhone: string;
  recipientPhoneConfirm: string;
  sealedPhotoUrl: string | null;
}

export interface BookingPayload {
  suburb: string;
  level: ServiceLevel;
  valueCents: number;
  contents: string;
  recipientPhone: string;
  recipientPhoneConfirm: string;
  sealedPhotoUrl: string;
}

export const EMPTY_FORM: BookingForm = {
  suburb: null,
  level: null,
  contents: '',
  valueText: '',
  recipientPhone: '',
  recipientPhoneConfirm: '',
  sealedPhotoUrl: null,
};

const DOLLARS = /^\d+(\.\d{1,2})?$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;

/** Whole cents from a dollar amount typed by the shop, or null if it is not a positive amount. */
export function parseDollarsToCents(text: string): number | null {
  const t = text.trim();
  if (!DOLLARS.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export const formatDollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const normalisePhone = (s: string): string => s.replace(/[\s-]/g, '');

/** Table price for the chosen suburb and level, or null until both are chosen. */
export function quote(form: Pick<BookingForm, 'suburb' | 'level'>): number | null {
  return form.suburb && form.level ? priceCents(form.suburb, form.level) : null;
}

export const phonesMismatch = (form: BookingForm): boolean =>
  form.recipientPhoneConfirm !== '' &&
  normalisePhone(form.recipientPhone) !== normalisePhone(form.recipientPhoneConfirm);

/** The payload to send, or null while anything required is missing or invalid. */
export function toPayload(form: BookingForm): BookingPayload | null {
  const valueCents = parseDollarsToCents(form.valueText);
  const phone = normalisePhone(form.recipientPhone);
  const confirm = normalisePhone(form.recipientPhoneConfirm);
  if (!form.suburb || !form.level || valueCents === null || !form.sealedPhotoUrl) return null;
  if (form.contents.trim() === '' || !PHONE.test(phone) || phone !== confirm) return null;
  return {
    suburb: form.suburb,
    level: form.level,
    valueCents,
    contents: form.contents.trim(),
    recipientPhone: phone,
    recipientPhoneConfirm: confirm,
    sealedPhotoUrl: form.sealedPhotoUrl,
  };
}
