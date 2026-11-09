export type Run = 'north' | 'southwest' | 'south';

export interface Suburb {
  band: string;
  run: Run;
}

/**
 * Editable suburb table (single source of truth for runs and bands).
 * Plymouth's run placement is unconfirmed; change it here only.
 */
export const SUBURBS: Record<string, Suburb> = {
  Avenues: { band: '2 km', run: 'north' },
  'Milton Park': { band: '2 km', run: 'north' },
  Mbare: { band: '3 km', run: 'southwest' },
  Avondale: { band: '4 to 5 km', run: 'north' },
  Workington: { band: '4 to 5 km', run: 'southwest' },
  'Houghton Park': { band: '6 to 7 km', run: 'southwest' },
  Waterfalls: { band: '8 to 10 km', run: 'south' },
  Plymouth: { band: '8 to 10 km', run: 'south' },
};
