export type EventType =
  | 'booked'
  | 'sealed'
  | 'pickup_confirmed'
  | 'in_transit'
  | 'delivered'
  | 'refused_by_rider'
  | 'reported_lost'
  | 'cancelled';

export type Party = 'shop' | 'rider' | 'recipient';

export interface CustodyEvent {
  type: EventType;
  at: string; // ISO 8601
  actor: Party | 'tuma';
  photoUrl?: string;
}

export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** Which event types may follow each event type. Empty list = terminal. */
const NEXT: Record<EventType, readonly EventType[]> = {
  booked: ['sealed', 'cancelled', 'reported_lost'],
  sealed: ['pickup_confirmed', 'refused_by_rider', 'cancelled', 'reported_lost'],
  pickup_confirmed: ['in_transit', 'delivered', 'reported_lost'],
  in_transit: ['delivered', 'reported_lost'],
  refused_by_rider: ['cancelled', 'reported_lost'],
  delivered: [],
  reported_lost: [],
  cancelled: [],
};

/** Who may record each event type. */
const ACTORS: Record<EventType, readonly CustodyEvent['actor'][]> = {
  booked: ['shop'],
  sealed: ['shop'],
  pickup_confirmed: ['rider'],
  in_transit: ['rider'],
  delivered: ['recipient'],
  refused_by_rider: ['rider'],
  reported_lost: ['shop', 'rider', 'recipient', 'tuma'],
  cancelled: ['shop', 'rider', 'recipient', 'tuma'],
};

const time = (e: CustodyEvent): number => Date.parse(e.at);

function lastSealedHasPhoto(events: CustodyEvent[]): boolean {
  const sealed = events.filter((e) => e.type === 'sealed');
  return Boolean(sealed[sealed.length - 1]?.photoUrl);
}

export function appendEvent(events: CustodyEvent[], next: CustodyEvent): CustodyEvent[] {
  if (Number.isNaN(time(next))) {
    throw new IllegalTransitionError(`Invalid timestamp: ${next.at}`);
  }
  if (!ACTORS[next.type].includes(next.actor)) {
    throw new IllegalTransitionError(`${next.type} cannot be recorded by ${next.actor}`);
  }
  const last = events[events.length - 1];
  if (!last) {
    if (next.type !== 'booked') {
      throw new IllegalTransitionError(`First event must be booked, got ${next.type}`);
    }
    return [next];
  }
  if (time(next) < time(last)) {
    throw new IllegalTransitionError(`${next.type} at ${next.at} is earlier than ${last.type} at ${last.at}`);
  }
  if (!NEXT[last.type].includes(next.type)) {
    throw new IllegalTransitionError(`${next.type} cannot follow ${last.type}`);
  }
  if (next.type === 'pickup_confirmed' && !lastSealedHasPhoto(events)) {
    throw new IllegalTransitionError('pickup_confirmed requires an earlier sealed event with a photo');
  }
  return [...events, next];
}

/** The last party to confirm is liable: shop, then rider from pickup, then recipient from delivery. */
export function liableParty(events: CustodyEvent[]): Party {
  return events.reduce<Party>((liable, e) => {
    if (e.type === 'pickup_confirmed') return 'rider';
    if (e.type === 'delivered') return 'recipient';
    return liable;
  }, 'shop');
}
