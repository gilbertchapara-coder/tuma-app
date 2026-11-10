/** One reading a minute keeps battery and data use low. */
export const GPS_INTERVAL_MS = 60_000;

export interface Position {
  lat: number;
  lng: number;
}

/**
 * Read the position once every GPS_INTERVAL_MS and report it. A failed reading or report is skipped;
 * the next tick tries again. Returns a function that stops sampling.
 */
export function startGpsSampling(
  getPosition: () => Promise<Position>,
  report: (p: Position) => Promise<void>,
  intervalMs: number = GPS_INTERVAL_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await report(await getPosition());
      } catch {
        // no GPS or no signal this minute: try again next tick
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  return () => clearInterval(timer);
}
