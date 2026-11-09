import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One embedded server, one database per test file; files may run in parallel.
  },
});
