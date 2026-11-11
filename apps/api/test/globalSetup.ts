import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import type { TestProject } from 'vitest/node';

const require = createRequire(import.meta.url);
const EmbeddedPostgres = (require('embedded-postgres').default ?? require('embedded-postgres')) as typeof import('embedded-postgres').default;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

/** Starts one real PostgreSQL (embedded binary, no system install) for the whole run. */
export default async function setup({ provide }: TestProject) {
  const PORT = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'tuma-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  provide('pgAdminUrl', `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`);
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
