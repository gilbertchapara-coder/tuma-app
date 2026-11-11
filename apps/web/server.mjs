// Serves the built page (dist/) for Railway. No dependencies. Unknown paths fall back to index.html
// so /track/<token> and /dashboard load the app. Run after `npm run build`.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function find(urlPath) {
  const requested = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const file = resolve(join(root, requested));
  if (file !== root && !file.startsWith(root + sep)) return null; // never leave dist/
  try {
    if ((await stat(file)).isFile()) return file;
  } catch {
    /* not a file: fall back to index.html */
  }
  return null;
}

createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const file = (await find(req.url ?? '/')) ?? join(root, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500).end('Something went wrong');
  }
}).listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
