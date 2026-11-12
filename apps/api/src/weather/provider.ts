import { worstAhead, type HourForecast, type WeatherState } from '@tuma/core';

/** Where the forecast comes from. Tests use a fake; the server uses Open-Meteo (free, no key, no personal data sent). */
export interface WeatherProvider {
  forecast(): Promise<HourForecast[]>;
}

export const clearSkyProvider: WeatherProvider = { async forecast() { return []; } };

const HARARE = { lat: -17.83, lng: 31.05 };
const FETCH_TIMEOUT_MS = 4000;

interface OpenMeteoReply {
  hourly?: { time?: string[]; precipitation?: number[]; precipitation_probability?: number[] };
}

/** Sends only the public coordinates of Harare; no user, parcel or phone data leaves the server. */
export function openMeteoProvider(fetchFn: typeof fetch = fetch): WeatherProvider {
  return {
    async forecast() {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${HARARE.lat}&longitude=${HARARE.lng}` +
        `&hourly=precipitation,precipitation_probability&forecast_days=2&timezone=UTC`;
      const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const body = (await res.json()) as OpenMeteoReply;
      const times = body.hourly?.time ?? [];
      return times.map((t, i) => ({
        at: `${t}Z`,
        mmPerHour: body.hourly?.precipitation?.[i] ?? 0,
        chancePercent: body.hourly?.precipitation_probability?.[i] ?? 0,
      }));
    },
  };
}

const CACHE_MS = 10 * 60 * 1000;
export const LOOKAHEAD_HOURS = 3;

/** Caches the forecast; on a provider failure the answer is "clear" so a weather outage never blocks booking. */
export function createWeatherService(provider: WeatherProvider, now: () => Date = () => new Date()) {
  let cache: { at: number; data: HourForecast[] } | undefined;
  return {
    async current(): Promise<WeatherState> {
      const t = now().getTime();
      if (!cache || t - cache.at > CACHE_MS) {
        try {
          cache = { at: t, data: await provider.forecast() };
        } catch {
          return cache ? worstAhead(cache.data, now(), LOOKAHEAD_HOURS) : 'clear';
        }
      }
      return worstAhead(cache.data, now(), LOOKAHEAD_HOURS);
    },
  };
}
export type WeatherService = ReturnType<typeof createWeatherService>;
