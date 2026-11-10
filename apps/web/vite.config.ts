import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/track': 'http://localhost:3000', '/admin': 'http://localhost:3000', '/auth': 'http://localhost:3000' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.ts'] },
});
