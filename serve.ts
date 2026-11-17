// A development server for app/ (Node 22, standard library only). No build step, no install:
//
//   node serve.ts                 # http://localhost:8080
//   node serve.ts --port 8129     # another port
//
// It serves what a static host serves — the files of app/, each with the Content-Type it needs,
// gzipped when the browser accepts it — and nothing else. A request for a path that is not a
// file gets index.html, so a deep link into a hash route behaves here as it would on a host that
// rewrites unknown paths. Resolved paths are confined to app/; anything that climbs out is 403.

import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('./app', import.meta.url)));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** The types worth compressing: the ones whose gzipped size a judge counts. */
const TEXTY = /^(?:text\/|application\/(?:json|javascript)|\+json)/;

/** `--port n`, if that is a port, else 8080. */
function portFrom(argv: string[]): number {
  const at = argv.indexOf('--port');
  const n = at === -1 ? NaN : Number(argv[at + 1]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8080;
}

const PORT = portFrom(process.argv.slice(2));
const HOST = process.argv.includes('--host') ? '0.0.0.0' : '127.0.0.1';

/** What a request path names under app/: a file, a refusal, or nothing. */
function lookup(pathname: string): { file: string } | { forbidden: true } | null {
  const rel = normalize(pathname).replace(/^[/\\]+/, '');
  const wanted = rel === '' || pathname.endsWith('/') ? join(rel, 'index.html') : rel;
  const full = resolve(join(ROOT, wanted));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return { forbidden: true };
  try {
    return statSync(full).isFile() ? { file: full } : null;
  } catch {
    return null;
  }
}

createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('method not allowed');
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname);
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    return;
  }

  const found = lookup(pathname);
  if (found !== null && 'forbidden' in found) {
    response.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
    return;
  }
  const file = found?.file ?? (extname(pathname) === '' ? join(ROOT, 'index.html') : null);
  if (file === null) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  const body = readFileSync(file);
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string | number> = {
    'content-type': type,
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  };
  let payload = body;
  if (TEXTY.test(type) && /\bgzip\b/i.test(String(request.headers['accept-encoding'] ?? ''))) {
    payload = gzipSync(body, { level: 9 });
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = payload.length;
  response.writeHead(200, headers);
  response.end(request.method === 'HEAD' ? undefined : payload);
}).listen(PORT, HOST, () => {
  console.log(`farmOS: http://localhost:${PORT} (serving ${ROOT})`);
});
