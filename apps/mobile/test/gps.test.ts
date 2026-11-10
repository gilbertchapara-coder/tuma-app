import { GPS_INTERVAL_MS, startGpsSampling } from '../src/rider/gps';

describe('startGpsSampling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('samples once every 60 seconds, not continuously', async () => {
    expect(GPS_INTERVAL_MS).toBe(60_000);
    const getPosition = jest.fn().mockResolvedValue({ lat: -17.8, lng: 31.05 });
    const report = jest.fn().mockResolvedValue(undefined);
    const stop = startGpsSampling(getPosition, report);
    expect(getPosition).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(59_000);
    expect(getPosition).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(getPosition).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(report).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops when asked', async () => {
    const getPosition = jest.fn().mockResolvedValue({ lat: 0, lng: 0 });
    const stop = startGpsSampling(getPosition, jest.fn().mockResolvedValue(undefined));
    stop();
    await jest.advanceTimersByTimeAsync(300_000);
    expect(getPosition).not.toHaveBeenCalled();
  });

  it('carries on after a failed reading or a failed report', async () => {
    const getPosition = jest
      .fn()
      .mockRejectedValueOnce(new Error('no gps'))
      .mockResolvedValue({ lat: 1, lng: 2 });
    const report = jest.fn().mockRejectedValueOnce(new Error('no signal')).mockResolvedValue(undefined);
    const stop = startGpsSampling(getPosition, report);
    await jest.advanceTimersByTimeAsync(180_000);
    expect(getPosition).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledTimes(2);
    stop();
  });
});
