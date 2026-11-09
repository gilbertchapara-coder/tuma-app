import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  appendEvent,
  liableParty,
  type CustodyEvent,
} from '../src/custody';

const ev = (
  type: CustodyEvent['type'],
  at: string,
  actor: CustodyEvent['actor'] = 'shop',
  photoUrl?: string,
): CustodyEvent => (photoUrl ? { type, at, actor, photoUrl } : { type, at, actor });

const booked = ev('booked', '2026-11-09T08:00:00Z');
const sealed = ev('sealed', '2026-11-09T08:05:00Z', 'shop', 'https://x/seal.jpg');
const pickup = ev('pickup_confirmed', '2026-11-09T08:10:00Z', 'rider');
const delivered = ev('delivered', '2026-11-09T08:40:00Z', 'recipient');

const chain = (...next: CustodyEvent[]): CustodyEvent[] =>
  next.reduce<CustodyEvent[]>((acc, e) => appendEvent(acc, e), []);

describe('liableParty', () => {
  it('is the shop before pickup is confirmed', () => {
    expect(liableParty([])).toBe('shop');
    expect(liableParty(chain(booked))).toBe('shop');
    expect(liableParty(chain(booked, sealed))).toBe('shop');
  });
  it('is the rider from pickup until delivery', () => {
    expect(liableParty(chain(booked, sealed, pickup))).toBe('rider');
    expect(liableParty(chain(booked, sealed, pickup, ev('in_transit', '2026-11-09T08:20:00Z', 'rider')))).toBe('rider');
  });
  it('stays with the rider when the parcel is reported lost', () => {
    expect(liableParty(chain(booked, sealed, pickup, ev('reported_lost', '2026-11-09T09:00:00Z', 'tuma')))).toBe('rider');
  });
  it('stays with the shop when reported lost before pickup', () => {
    const lost = (at: string) => ev('reported_lost', at, 'tuma');
    expect(liableParty(chain(booked, lost('2026-11-09T08:02:00Z')))).toBe('shop');
    expect(liableParty(chain(booked, sealed, lost('2026-11-09T08:06:00Z')))).toBe('shop');
  });
  it('is the recipient after delivery', () => {
    expect(liableParty(chain(booked, sealed, pickup, delivered))).toBe('recipient');
  });
});

describe('appendEvent', () => {
  it('rejects delivered before pickup_confirmed', () => {
    expect(() => appendEvent(chain(booked, sealed), delivered)).toThrow(IllegalTransitionError);
  });
  it('rejects pickup_confirmed without a prior sealed event', () => {
    expect(() => appendEvent(chain(booked), pickup)).toThrow(IllegalTransitionError);
  });
  it('rejects pickup_confirmed when the sealed event has no photo', () => {
    const noPhoto = ev('sealed', '2026-11-09T08:05:00Z');
    expect(() => appendEvent(chain(booked, noPhoto), pickup)).toThrow(IllegalTransitionError);
  });
  it('rejects a first event other than booked', () => {
    expect(() => appendEvent([], sealed)).toThrow(IllegalTransitionError);
  });
  it('rejects in_transit after delivered (terminal)', () => {
    const done = chain(booked, sealed, pickup, delivered);
    expect(() => appendEvent(done, ev('in_transit', '2026-11-09T09:00:00Z', 'rider'))).toThrow(IllegalTransitionError);
  });
  it('rejects an event with an earlier time than the last', () => {
    const early = ev('pickup_confirmed', '2026-11-09T08:01:00Z', 'rider');
    expect(() => appendEvent(chain(booked, sealed), early)).toThrow(IllegalTransitionError);
  });
  it('rejects an invalid timestamp', () => {
    expect(() => appendEvent([], ev('booked', 'not-a-date'))).toThrow(IllegalTransitionError);
  });
  it('allows cancellation before pickup but not after', () => {
    expect(chain(booked, ev('cancelled', '2026-11-09T08:02:00Z', 'shop'))).toHaveLength(2);
    expect(() => appendEvent(chain(booked, sealed, pickup), ev('cancelled', '2026-11-09T08:12:00Z'))).toThrow(IllegalTransitionError);
  });
  it('rejects pickup_confirmed by the shop', () => {
    const byShop = ev('pickup_confirmed', '2026-11-09T08:10:00Z', 'shop');
    expect(() => appendEvent(chain(booked, sealed), byShop)).toThrow(IllegalTransitionError);
  });
  it('rejects delivered by tuma but accepts it by the recipient', () => {
    const base = chain(booked, sealed, pickup);
    expect(() => appendEvent(base, ev('delivered', '2026-11-09T08:40:00Z', 'tuma'))).toThrow(IllegalTransitionError);
    expect(appendEvent(base, delivered)).toHaveLength(4);
  });
  it('does not mutate its input and returns a new array', () => {
    const input = chain(booked, sealed);
    const snapshot = [...input];
    const out = appendEvent(input, pickup);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(3);
  });
});
