import { describe, expect, it } from 'vitest';
import { countryFromCoords } from '../src/geo';

const at = (lat: number, lng: number) => countryFromCoords({ lat, lng });

describe('countryFromCoords', () => {
  it('finds Zimbabwe in its main towns', () => {
    expect(at(-17.83, 31.05)).toBe('ZW'); // Harare
    expect(at(-20.15, 28.58)).toBe('ZW'); // Bulawayo
    expect(at(-18.97, 32.67)).toBe('ZW'); // Mutare
    expect(at(-19.45, 29.82)).toBe('ZW'); // Gweru
  });

  it('finds Zambia in its main towns', () => {
    expect(at(-15.42, 28.28)).toBe('ZM'); // Lusaka
    expect(at(-12.8, 28.21)).toBe('ZM'); // Kitwe
    expect(at(-13.63, 32.65)).toBe('ZM'); // Chipata
    expect(at(-10.21, 31.18)).toBe('ZM'); // Kasama
  });

  it('says nothing near the border, so a rider on the bridge is not flipped back and forth', () => {
    expect(at(-17.93, 25.85)).toBeNull(); // Victoria Falls bridge
    expect(at(-16.52, 28.8)).toBeNull(); // Kariba dam wall
    expect(at(-15.99, 28.85)).toBeNull(); // Chirundu bridge
  });

  it('says nothing outside the two countries', () => {
    expect(at(-26.2, 28.04)).toBeNull(); // Johannesburg
    expect(at(-24.65, 25.91)).toBeNull(); // Gaborone
    expect(at(-25.97, 32.57)).toBeNull(); // Maputo
    expect(at(51.5, -0.12)).toBeNull(); // London
    expect(at(0, 0)).toBeNull();
  });

  it('refuses coordinates that are not real', () => {
    expect(at(Number.NaN, 30)).toBeNull();
    expect(at(95, 30)).toBeNull();
    expect(at(-17, 200)).toBeNull();
  });
});
