import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CustodyEvent } from '@tuma/core/src/custody';
import { QUEUE_CORRUPT_KEY, QUEUE_KEY, enqueueEvent, flushQueue, pendingCount } from '../src/rider/scanQueue';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const ev = (type: CustodyEvent['type'], at: string): CustodyEvent => ({ type, at, actor: 'rider' });
const T1 = '2026-11-10T08:00:00.000Z';
const T2 = '2026-11-10T08:05:00.000Z';
const T3 = '2026-11-10T08:10:00.000Z';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('scanQueue', () => {
  it('stores events and counts them', async () => {
    expect(await pendingCount()).toBe(0);
    await enqueueEvent('p1', ev('pickup_confirmed', T1));
    await enqueueEvent('p2', ev('pickup_confirmed', T2));
    expect(await pendingCount()).toBe(2);
  });

  it('keeps every event when several are queued at the same moment', async () => {
    await Promise.all([
      enqueueEvent('p1', ev('pickup_confirmed', T1)),
      enqueueEvent('p2', ev('pickup_confirmed', T2)),
      enqueueEvent('p3', ev('pickup_confirmed', T3)),
    ]);
    expect(await pendingCount()).toBe(3);
  });

  it('flushes in original order with the original times, then empties the queue', async () => {
    await enqueueEvent('p1', ev('pickup_confirmed', T1));
    await enqueueEvent('p2', ev('pickup_confirmed', T2));
    await enqueueEvent('p1', ev('in_transit', T3));
    const calls: Array<[string, CustodyEvent]> = [];
    const result = await flushQueue(async (id, e) => {
      calls.push([id, e]);
    });
    expect(result).toEqual({ sent: 3, failed: 0 });
    expect(calls).toEqual([
      ['p1', ev('pickup_confirmed', T1)],
      ['p2', ev('pickup_confirmed', T2)],
      ['p1', ev('in_transit', T3)],
    ]);
    expect(await pendingCount()).toBe(0);
  });

  it('keeps a failed event and retries it later with its original time', async () => {
    await enqueueEvent('p1', ev('pickup_confirmed', T1));
    const first = await flushQueue(async () => {
      throw new Error('no signal');
    });
    expect(first).toEqual({ sent: 0, failed: 1 });
    expect(await pendingCount()).toBe(1);

    const calls: Array<[string, CustodyEvent]> = [];
    const second = await flushQueue(async (id, e) => {
      calls.push([id, e]);
    });
    expect(second).toEqual({ sent: 1, failed: 0 });
    expect(calls).toEqual([['p1', ev('pickup_confirmed', T1)]]);
    expect(await pendingCount()).toBe(0);
  });

  it('does not send a later event for a parcel whose earlier event failed, but still sends other parcels', async () => {
    await enqueueEvent('p1', ev('pickup_confirmed', T1));
    await enqueueEvent('p2', ev('pickup_confirmed', T2));
    await enqueueEvent('p1', ev('in_transit', T3));
    const sent: string[] = [];
    const result = await flushQueue(async (id, e) => {
      if (id === 'p1' && e.type === 'pickup_confirmed') throw new Error('rejected');
      sent.push(`${id}:${e.type}`);
    });
    expect(sent).toEqual(['p2:pickup_confirmed']);
    expect(result).toEqual({ sent: 1, failed: 2 });
    expect(await pendingCount()).toBe(2);
  });

  it('does not lose an event queued while a flush is running', async () => {
    await enqueueEvent('p1', ev('pickup_confirmed', T1));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flushing = flushQueue(async () => {
      await gate;
    });
    await enqueueEvent('p2', ev('pickup_confirmed', T2));
    release();
    await flushing;
    expect(await pendingCount()).toBe(1);
  });

  it('runs two flushes at once without sending anything twice', async () => {
    await enqueueEvent('p1', ev('pickup_confirmed', T1));
    const send = jest.fn().mockResolvedValue(undefined);
    await Promise.all([flushQueue(send), flushQueue(send)]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('survives unreadable storage: starts empty and keeps the raw text for recovery', async () => {
    await AsyncStorage.setItem(QUEUE_KEY, '{not json');
    expect(await pendingCount()).toBe(0);
    await enqueueEvent('p1', ev('pickup_confirmed', T1));
    expect(await pendingCount()).toBe(1);
    expect(await AsyncStorage.getItem(QUEUE_CORRUPT_KEY)).toBe('{not json');
  });
});
