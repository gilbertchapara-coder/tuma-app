import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CustodyEvent } from '@tuma/core/src/custody';

export const QUEUE_KEY = 'tuma_scan_queue';
export const QUEUE_CORRUPT_KEY = 'tuma_scan_queue_corrupt';

interface QueuedEvent {
  id: string;
  parcelId: string;
  event: CustodyEvent;
}

export type Send = (parcelId: string, event: CustodyEvent) => Promise<void>;
export interface FlushResult {
  sent: number;
  failed: number;
}

/** Storage reads and writes run one at a time so two quick scans cannot overwrite each other. */
let storageLock: Promise<unknown> = Promise.resolve();
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = storageLock.then(job, job);
  storageLock = run.catch(() => undefined);
  return run;
}

let counter = 0;
const newId = (): string => `${Date.now().toString(36)}-${(counter += 1).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function readQueue(): Promise<QueuedEvent[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as QueuedEvent[];
  } catch {
    // fall through: unreadable text is kept for recovery instead of being silently dropped
  }
  await AsyncStorage.setItem(QUEUE_CORRUPT_KEY, raw);
  return [];
}

const writeQueue = (items: QueuedEvent[]): Promise<void> => AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));

/** Store an event on the phone. `e.at` is kept exactly as given: it is when the scan happened, not when it syncs. */
export function enqueueEvent(parcelId: string, e: CustodyEvent): Promise<void> {
  return exclusive(async () => {
    const items = await readQueue();
    await writeQueue([...items, { id: newId(), parcelId, event: e }]);
  });
}

export const pendingCount = (): Promise<number> => exclusive(async () => (await readQueue()).length);

export const pendingParcelIds = (): Promise<string[]> =>
  exclusive(async () => [...new Set((await readQueue()).map((i) => i.parcelId))]);

let flushing: Promise<FlushResult> | null = null;

/**
 * Send queued events in their original order. A failed event stays queued, and later events for the same
 * parcel wait behind it so custody never arrives out of order. `failed` counts every event left unsent.
 */
export function flushQueue(send: Send): Promise<FlushResult> {
  if (flushing) return flushing;
  const run = doFlush(send).finally(() => {
    flushing = null;
  });
  flushing = run;
  return run;
}

async function doFlush(send: Send): Promise<FlushResult> {
  const snapshot = await exclusive(readQueue);
  const sentIds = new Set<string>();
  const blocked = new Set<string>();
  let failed = 0;
  for (const item of snapshot) {
    if (blocked.has(item.parcelId)) {
      failed += 1;
      continue;
    }
    try {
      await send(item.parcelId, item.event);
      sentIds.add(item.id);
    } catch {
      blocked.add(item.parcelId);
      failed += 1;
    }
  }
  if (sentIds.size > 0) {
    await exclusive(async () => writeQueue((await readQueue()).filter((i) => !sentIds.has(i.id))));
  }
  return { sent: sentIds.size, failed };
}
