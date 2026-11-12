/** The short code a shop or support quotes for a parcel: TUM- and the first 8 hex digits of its id. */
export function parcelReference(id: string): string {
  return `TUM-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

const MIN_PREFIX = 6;

/** A typed reference as a lowercase hex prefix of the id, or null when it is too short or not hex. */
export function referencePrefix(typed: string): string | null {
  const cleaned = typed.trim().toLowerCase().replace(/^tum[\s-]*/, '').replace(/[\s-]/g, '');
  return /^[0-9a-f]+$/.test(cleaned) && cleaned.length >= MIN_PREFIX && cleaned.length <= 32 ? cleaned : null;
}
