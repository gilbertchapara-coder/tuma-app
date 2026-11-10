const RUN_NAMES: Record<string, string> = { north: 'North', southwest: 'South-West', south: 'South' };

/** Reader-facing name for a run id; unknown ids pass through unchanged. */
export const runName = (run: string): string => RUN_NAMES[run] ?? run;
