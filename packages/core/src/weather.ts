import { COUNTRIES, priceCentsFor, type CountryConfig } from './countries';
import type { ServiceLevel } from './pricing';

export type WeatherState = 'clear' | 'light_rain' | 'heavy_rain';

/** Rain extra in integer cents. Owner placeholders: change them here, in one place. */
export const RAIN_SURCHARGE_CENTS: Readonly<Record<WeatherState, number>> = {
  clear: 0,
  light_rain: 10,
  heavy_rain: 25,
};

/** Overnight parcels are not time-critical, so rain never adds to them. */
const SURCHARGE_APPLIES: Readonly<Record<ServiceLevel, boolean>> = {
  express: true,
  standard: true,
  overnight: false,
};

export const LIGHT_RAIN_MM_PER_HOUR = 0.5;
export const HEAVY_RAIN_MM_PER_HOUR = 4;
/** Chance of rain (percent) below which we treat the hour as dry. */
export const MIN_RAIN_CHANCE_PERCENT = 40;

export interface HourForecast {
  /** ISO time of the start of the hour. */
  at: string;
  mmPerHour: number;
  chancePercent: number;
}

export function classifyHour(h: Pick<HourForecast, 'mmPerHour' | 'chancePercent'>): WeatherState {
  if (!(h.mmPerHour >= 0) || !(h.chancePercent >= 0)) return 'clear';
  if (h.chancePercent < MIN_RAIN_CHANCE_PERCENT) return 'clear';
  if (h.mmPerHour >= HEAVY_RAIN_MM_PER_HOUR) return 'heavy_rain';
  if (h.mmPerHour >= LIGHT_RAIN_MM_PER_HOUR) return 'light_rain';
  return 'clear';
}

const RANK: Readonly<Record<WeatherState, number>> = { clear: 0, light_rain: 1, heavy_rain: 2 };
const HOUR_MS = 60 * 60 * 1000;

/** Worst weather over the next `hours` hours starting at `now`. */
export function worstAhead(forecast: readonly HourForecast[], now: Date, hours: number): WeatherState {
  const from = now.getTime() - HOUR_MS; // the hour we are in started up to 1 h ago
  const to = now.getTime() + hours * HOUR_MS;
  let worst: WeatherState = 'clear';
  for (const h of forecast) {
    const t = Date.parse(h.at);
    if (!Number.isFinite(t) || t < from || t >= to) continue;
    const s = classifyHour(h);
    if (RANK[s] > RANK[worst]) worst = s;
  }
  return worst;
}

export interface WeatherQuote {
  baseCents: number;
  surchargeCents: number;
  totalCents: number;
  weather: WeatherState;
}

/** Table price plus the weather extra. The total is locked when the parcel is booked. */
export function quoteWithWeather(suburb: string, level: ServiceLevel, weather: WeatherState, country: CountryConfig = COUNTRIES.ZW): WeatherQuote {
  const baseCents = priceCentsFor(country, suburb, level);
  const surchargeCents = SURCHARGE_APPLIES[level] ? RAIN_SURCHARGE_CENTS[weather] : 0;
  return { baseCents, surchargeCents, totalCents: baseCents + surchargeCents, weather };
}

export const WEATHER_MESSAGES: Readonly<Record<WeatherState, string>> = {
  clear: 'Clear. Normal prices.',
  light_rain: 'Light rain expected. Express and Standard cost a little more.',
  heavy_rain: 'Heavy rain expected. Express and Standard cost more and may be slower.',
};
