import { describe, expect, it } from 'vitest';
import { parcelReference, referencePrefix } from '../src/reference';

describe('parcel reference', () => {
  it('shows the first 8 hex digits of the id as TUM-XXXXXXXX', () => {
    expect(parcelReference('3f2a9c10-aaaa-bbbb-cccc-1234567890ab')).toBe('TUM-3F2A9C10');
  });
  it('reads a typed reference back into a lowercase hex prefix', () => {
    expect(referencePrefix('TUM-3F2A9C10')).toBe('3f2a9c10');
    expect(referencePrefix(' tum 3f2a-9c10 ')).toBe('3f2a9c10');
    expect(referencePrefix('3f2a9c')).toBe('3f2a9c');
  });
  it('refuses anything too short or not hex', () => {
    expect(referencePrefix('TUM-3F2')).toBeNull();
    expect(referencePrefix('TUM-ZZZZZZZZ')).toBeNull();
    expect(referencePrefix('')).toBeNull();
  });
});
