// Measures the rendered page instead of eyeballing a PNG: computed colours per theme, the
// rail at three widths, overflow, and the order of the sections on each surface.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('../app', import.meta.url)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(root, normalize(path)));
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  let st;
  try {
    st = statSync(file);
    if (!st.isFile()) throw new Error();
  } catch {
    return res.writeHead(404).end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/plain', 'content-length': st.size, 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const route = process.argv[2] ?? '#/';

for (const theme of ['light', 'dark']) {
  for (const width of [1280, 768, 360]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
    await page.goto(base + route);
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 30000 });
    const m = await page.evaluate(() => {
      const css = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop).trim() : '');
      const rail = document.querySelector('.rail');
      const railBox = rail.getBoundingClientRect();
      const title = document.querySelector('h1');
      const eyebrow = document.querySelector('.eyebrow');
      const firstNum = document.querySelector('.figure__v, .stat__v');
      // Every element wider than the viewport, to catch an overflow the document width hides.
      const wide = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed')
        .slice(0, 4)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        bodyColor: css(document.body, 'color'),
        bodyBackground: css(document.body, 'background-color'),
        titleFont: css(title, 'font-family').slice(0, 40),
        titleSize: css(title, 'font-size'),
        eyebrowColor: css(eyebrow, 'color'),
        eyebrowTransform: css(eyebrow, 'text-transform'),
        eyebrowSize: css(eyebrow, 'font-size'),
        figureFont: css(firstNum, 'font-family').slice(0, 30),
        figureSize: css(firstNum, 'font-size'),
        figureVariants: css(firstNum, 'font-variant-numeric'),
        railLayout: getComputedStyle(rail).flexDirection,
        railBox: [Math.round(railBox.width), Math.round(railBox.height), Math.round(railBox.top), Math.round(railBox.left)],
        railLinkDir: getComputedStyle(document.querySelector('.rail__link')).flexDirection,
        activeRail: document.querySelector('.rail__link[aria-current]')?.textContent?.trim() ?? null,
        wide,
      };
    });
    console.log(theme, width, JSON.stringify(m));
    await ctx.close();
  }
}
await browser.close();
server.close();
