// Quick look at the app in Chromium: console errors, the route flags, layout overflow, and a
// PNG of each surface. A development aid; scripts/verify.mjs is the contract.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('../app', import.meta.url)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(root, normalize(path)));
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  let size;
  try {
    size = statSync(file).size;
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    return res.writeHead(404).end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const routes = process.argv.slice(2).length ? process.argv.slice(2) : ['#/', '#/bounty/makefun-frontend-01', '#/bounty/makefun-frontend-01/leaderboard', '#/u/nightshift-labs'];
const browser = await chromium.launch();
const theme = process.env.THEME ?? 'light';
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

for (const route of routes) {
  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 30000 }).catch(() => problems.push(`${route}: never ready`));
  const info = await page.evaluate(() => ({
    title: document.title,
    error: window.__error,
    h1: document.querySelector('h1')?.textContent?.trim().slice(0, 80),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  console.log(route, JSON.stringify(info));
  const name = route.replace(/[^a-z0-9]+/gi, '_') || 'board';
  await page.screenshot({ path: `C:/Users/friok/makefun/recorded-home-v7/cache/scratch/smoke${name}.png`, fullPage: false });
}
console.log('problems:', problems.length ? problems.join('\n') : 'none');
await browser.close();
server.close();
