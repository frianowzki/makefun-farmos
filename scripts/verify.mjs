// The accuracy contract for farmOS (Node 22, standard library plus Playwright).
//
//   node scripts/verify.mjs           # measure and check; exits 1 below 95% or on a failed check
//   node scripts/verify.mjs --shots    # also write screenshots/ from the live pages
//
// It serves app/ over real HTTP, drives real Chromium at 1280x800 across the four surfaces, reads
// every figure out of the DOM, fetches the same resources from https://make.fun/api with fetch,
// recomputes each figure with app/format.js (the app's own formatter, never a second
// implementation) and compares them one field at a time. Anything it cannot compare honestly is
// listed as SKIPPED and kept out of both numerator and denominator.
//
// Playwright is the copy installed beside the kit, resolved by absolute path so it works from any
// cwd and from Node 22 or 26.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  count,
  dateTime,
  statusLabel,
  until,
  usd,
} from '../app/format.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const APP = resolve(join(REPO, 'app'));
const SHOTS = resolve(join(REPO, 'screenshots'));
const API = 'https://make.fun/api';
const PLAYWRIGHT = 'C:/Users/friok/makefun/node_modules/playwright/index.js';
const VIEWPORT = { width: 1280, height: 800 };
const WANT_SHOTS = process.argv.includes('--shots');
const READY_TIMEOUT = 90_000;
const MIN_ACCURACY = 95;

const require = createRequire(pathToFileURL(join(REPO, 'scripts', 'x.js')).href);
if (!existsSync(PLAYWRIGHT)) throw new Error(`Playwright is expected at ${PLAYWRIGHT}`);
const { chromium } = require(PLAYWRIGHT);

// ---------------------------------------------------------------- plumbing

/** A tiny static server for app/: files with their types, index.html for anything unknown. */
function serveApp() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const rel = pathname === '/' || pathname.endsWith('/') ? join(pathname, 'index.html') : pathname;
    let file = resolve(join(APP, rel));
    if (!file.startsWith(APP + sep) && file !== APP) {
      res.writeHead(403).end('forbidden');
      return;
    }
    // A path with an extension but no file is a genuine 404, which the app-level 404 route needs.
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(pathname) !== '') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      file = join(APP, 'index.html');
    }
    res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

/** GET a JSON resource from make.fun and return it, or throw with the status. */
async function api(path) {
  const res = await fetch(API + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${API}${path} answered ${res.status}`);
  return res.json();
}

/** Wait until the route has data on screen. A bare timeout is never the signal — only the flag is. */
async function ready(page) {
  await page.waitForFunction(() => window.__shotReady === true || window.__error !== null, null, { timeout: READY_TIMEOUT, polling: 100 });
  const state = await page.evaluate(() => ({ ready: window.__shotReady, error: window.__error }));
  if (!state.ready) throw new Error(`route ended in an error instead of ready: ${state.error}`);
}

/** The text of every [data-v] slot on the page, keyed by its name. */
function readSlots(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-v]')].map((el) => [el.dataset.v, (el.textContent ?? '').trim()]),
    ),
  );
}

// ---------------------------------------------------------------- the report

const rows = [];
const skipped = [];
const checks = [];

/**
 * One compared field. `dom` is what the page shows, `want` what the API says, and they match only
 * when the strings are equal — no rounding, no normalising, no special cases.
 */
function compare(surface, field, dom, want, why = '') {
  const present = dom !== undefined && dom !== null;
  const same = present && String(dom) === String(want);
  const reason = same ? '' : present ? why : 'no [data-v] element for this field on the page';
  rows.push({ surface, field, dom: present ? String(dom) : '(no such element)', want: String(want), same, why: reason });
  return same;
}

/** A figure that cannot honestly be compared: named, reasoned, and out of the arithmetic. */
function skip(surface, field, why) {
  skipped.push({ surface, field, why });
}

/** A non-accuracy assertion: must pass for the run to be worth anything. */
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
}

const pad = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s).padEnd(n));

// ---------------------------------------------------------------- the surfaces

/** The board: #/ */
async function verifyBoard(page) {
  const data = await api('/competitions?status=open&activity=times');
  const items = Array.isArray(data?.items) ? data.items : [];
  const now = Date.now();
  await page.goto(`${page.__origin}/#/`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const slot = await readSlots(page);
  const S = '#/';

  compare(S, 'open bounties (count)', slot.count, count(items.length));

  // Every card's pot is the API's own figure, formatted at the scale the API stated it in.
  const pooled = items.reduce((n, b) => n + (Number(b.potUsd ?? b.rewardAmount) || 0), 0);
  compare(S, 'live pots pooled', slot['pot-total'], usd(pooled));

  const entries = items.reduce((n, b) => n + (Number(b.submissionCount) || 0), 0);
  compare(S, 'entries received (total)', slot['entries-total'], count(entries));

  const charging = items.filter((b) => Number(b.entryFeeUsd) > 0).length;
  compare(S, 'bounties charging a fee', slot['fee-count'], count(charging));

  for (const b of items) {
    if (!b.slug) continue;
    compare(S, `${b.slug} · live pot`, slot[`pot:${b.slug}`], usd(b.potUsd ?? b.rewardAmount));
    compare(S, `${b.slug} · deadline`, slot[`deadline:${b.slug}`], dateTime(b.deadline));
    compare(S, `${b.slug} · entries`, slot[`entries:${b.slug}`], count(b.submissionCount));
    compare(S, `${b.slug} · base reward`, slot[`reward:${b.slug}`], usd(b.rewardAmount));
    if (!b.slug) continue;
    if (Number(b.entryFeeUsd) > 0) compare(S, `${b.slug} · entry fee`, slot[`fee:${b.slug}`], usd(b.entryFeeUsd));
    else skip(S, `${b.slug} · entry fee`, 'free to enter: the app draws a sentence, not a figure, so there is no value to compare');
  }

  // The "N entries" <b> wrappers must also be the card's own count element, once per bounty.
  const cards = await page.evaluate(() => [...document.querySelectorAll('ol.bounties > li')].map((li) => li.querySelector('h3 a')?.dataset.slug ?? ''));
  check('board: one card per API bounty', cards.length === items.length && cards.every((s, i) => s === items[i].slug), `${cards.length} cards vs ${items.length} bounties`);
  skip(S, 'time left (per bounty)', 'a live countdown depends on the millisecond it is read, so a string comparison would grade the clock, not the app');
  skip(S, 'next deadline', 'derived from the clock at render time; not a stable string');
}

/** One bounty: #/bounty/<slug> */
async function verifyBounty(page, slug) {
  const b = await api(`/competitions/${encodeURIComponent(slug)}`);
  await page.goto(`${page.__origin}/#/bounty/${slug}`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const slot = await readSlots(page);
  const S = `#/bounty/${slug}`;
  const fee = Number(b.entryFeeUsd) || 0;

  compare(S, 'title', slot.title, b.title);
  compare(S, 'status', slot.status, statusLabel(b.status));
  compare(S, 'deadline', slot.deadline, dateTime(b.deadline));
  compare(S, 'closes', slot['deadline-full'], dateTime(b.deadline));
  compare(S, 'opens', slot.opens, dateTime(b.opensAt || b.publishedAt));
  compare(S, 'live pot', slot.pot, usd(b.potUsd ?? b.rewardAmount));
  compare(S, 'base prize', slot.reward, usd(b.rewardAmount));
  compare(S, 'entry fees paid in', slot.fees, usd(b.entryFeesUsd ?? 0));
  compare(S, 'entry fee', slot.fee, fee > 0 ? usd(b.entryFeeUsd) : 'None');
  compare(S, 'fee payers', slot['fee-payers'], count(b.entryFeePayers ?? 0));
  compare(S, 'entries', slot.entries, count(b.submissionCount));
  compare(S, 'entries (money panel)', slot['entry-count'], count(b.submissionCount));

  // The pot is the base prize plus every fee paid, and the page must say so in its own figures.
  check(`${S}: pot = base prize + fees paid`, Number(b.potUsd) === Number(b.rewardAmount) + Number(b.entryFeesUsd ?? 0) || (b.potUsd == null), `potUsd ${b.potUsd} vs ${b.rewardAmount} + ${b.entryFeesUsd}`);

  const rewards = Array.isArray(b.rewardsNow) ? b.rewardsNow : [];
  for (const r of rewards) compare(S, `reward place ${r.place}`, slot[`place:${r.place}`], usd(r.amountUsd));
  if (rewards.length === 0) skip(S, 'reward table', 'the API lists no rewardsNow for this bounty');

  skip(S, 'time left', 'a countdown read at render time, not a stable string');
  skip(S, 'phase elapsed %', 'a function of the clock at render time');
  skip(S, 'brief text', 'long Markdown rendered to HTML; its prose is not a figure and its markup is not comparable field by field');
}

/** A leaderboard: #/bounty/<slug>/leaderboard */
async function verifyLeaderboard(page, slug) {
  const lb = await api(`/competitions/${encodeURIComponent(slug)}/leaderboard?rows=all`);
  await page.goto(`${page.__origin}/#/bounty/${slug}/leaderboard`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const slot = await readSlots(page);
  const S = `#/bounty/${slug}/leaderboard`;
  const entries = Array.isArray(lb?.entries) ? lb.entries : [];
  const columns = Array.isArray(lb?.columns) ? lb.columns.filter((c) => !c.hidden) : [];

  compare(S, 'rows', slot.rows, count(entries.length));
  compare(S, 'total rows', slot.total, count(entries.length));
  compare(S, 'metric columns', slot.columns, count(columns.length));

  const table = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('table tbody tr')];
    return trs.map((tr) => ({
      rank: (tr.querySelector('td.rank')?.textContent ?? '').trim(),
      handle: (tr.querySelector('td.who a')?.textContent ?? '').trim(),
      cells: Object.fromEntries([...tr.querySelectorAll('td[data-col]')].map((td) => [td.dataset.col, (td.textContent ?? '').trim()])),
    }));
  });

  // Page one is the first PER_PAGE (25) rows, in rank order, with the same handles.
  const shown = entries.slice(0, table.length);
  check(`${S}: table shows the first ${table.length} API rows in order`,
    table.length === Math.min(25, entries.length) && shown.every((e, i) => table[i].rank === String(e.rank) && table[i].handle === e.handle),
    `${table.length} DOM rows vs ${Math.min(25, entries.length)} expected`);

  for (const [i, tr] of table.entries()) {
    const e = shown[i];
    if (!e) continue;
    for (const c of columns) {
      // The API prints its own display string for every metric; that is what the cell shows.
      const want = e.display?.[c.key] ?? e.values?.[c.key];
      if (want === undefined || want === null) {
        skip(S, `rank ${e.rank} · ${c.title}`, 'the API gives no value or display string for this column');
        continue;
      }
      compare(S, `rank ${e.rank} (${e.handle}) · ${c.title}`, tr.cells[c.key], String(want));
    }
  }

  // Paging must show the rows it says it shows: go to page 2 and check against the API slice.
  const pages = Math.max(1, Math.ceil(entries.length / 25));
  if (pages > 1) {
    const before = await page.evaluate(() => window.__shotReady);
    await page.click('button[data-page="2"]');
    await ready(page);
    const after = await page.evaluate(() => window.__shotReady);
    check(`${S}: paging keeps the route ready`, before === true && after === true);
    const second = await page.evaluate(() => [...document.querySelectorAll('table tbody tr')].map((tr) => ({
      rank: (tr.querySelector('td.rank')?.textContent ?? '').trim(),
      handle: (tr.querySelector('td.who a')?.textContent ?? '').trim(),
    })));
    const want = entries.slice(25, 50);
    check(`${S}: page 2 shows API rows 26-50`, second.length === want.length && want.every((e, i) => second[i].rank === String(e.rank) && second[i].handle === e.handle), `${second.length} rows`);
    for (const [i, tr] of second.entries()) {
      const e = want[i];
      if (e) compare(S, `page 2 rank ${e.rank} · handle`, tr.handle, e.handle);
    }
    await page.click('button[data-page="1"]');
    await ready(page);
  }
}

/** A profile: #/u/<handle> */
async function verifyProfile(page, handle) {
  const p = await api(`/profiles/${encodeURIComponent(handle)}`);
  await page.goto(`${page.__origin}/#/u/${handle}`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const slot = await readSlots(page);
  const S = `#/u/${handle}`;
  const r = p?.record ?? {};
  const solutions = Array.isArray(p?.solutions) ? p.solutions : [];

  compare(S, 'handle', slot.handle, p.handle);
  compare(S, 'bounties entered', slot['stat:entered'], count(r.competitions_entered ?? solutions.length));
  compare(S, 'placed', slot['stat:placed'], count(r.competitions_placed ?? 0));
  compare(S, 'podiums', slot['stat:podiums'], count(r.podium_finishes ?? 0));
  compare(S, 'wins', slot['stat:wins'], count(r.competitions_won ?? 0));
  compare(S, 'best rank', slot['stat:best'], Number.isFinite(r.best_placement) ? `#${count(r.best_placement)}` : '—');
  compare(S, 'prize money', slot['stat:prize'], usd(r.prize_usd ?? '0'));
  compare(S, 'entries on record', slot.solutions, count(solutions.length));

  const listed = await page.evaluate(() => [...document.querySelectorAll('ol.solutions > li')].map((li) => li.dataset.entry ?? ''));
  check(`${S}: one entry row per API solution`, listed.length === solutions.length && listed.every((s, i) => s === (solutions[i].competition?.slug ?? '')), `${listed.length} rows vs ${solutions.length} solutions`);

  skip(S, 'joined date', 'drawn as a formatted day inside a sentence, not in a data-v slot; nothing to compare against a slot');
  skip(S, 'per-entry score', 'rendered inside prose in the entry list without a data-v slot');
}

// ---------------------------------------------------------------- the assertions

/** Every route must go loading -> ready, and the retry on a forced failure must re-request. */
async function verifyLifecycle(page, origin) {
  await page.goto(`${origin}/#/`, { waitUntil: 'domcontentloaded' });
  // The skeleton is up before the fetch resolves: catch it between navigation and ready.
  const sawLoading = await page.evaluate(() => window.__shotReady === false);
  await ready(page);
  check('loading -> ready transition on #/', sawLoading === true, `saw __shotReady === false at navigation: ${sawLoading}`);
}

/**
 * A route forced into a failure it can retry. The board's request is answered 503 — a real
 * outage, not a bounty that is missing — so the app shows its error state and a working retry.
 */
async function verifyForcedFailure(page, origin) {
  let answered = 0;
  const failures = [];
  const handler = (route) => {
    answered += 1;
    failures.push(route.request().url());
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream unavailable"}' });
  };
  const pattern = '**/api/competitions?status=open**';
  // Everything from here until the retry has been proven is provoked by this script: the 503, the
  // 404, and Chrome's one console line for each ("Failed to load resource: ... 503").
  page.__expect(/responded with a status of (?:503|404)/);
  page.__expectUrl('competitions?status=open');
  await page.route(pattern, handler);
  await page.goto(`${origin}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__error !== null, null, { timeout: READY_TIMEOUT, polling: 100 }).catch(() => {});
  const shown = await page.evaluate(() => ({
    error: window.__error,
    notice: Boolean(document.querySelector('[data-v="error"]')),
    retry: Boolean(document.querySelector('[data-retry]')),
    ready: window.__shotReady,
  }));
  check('forced failure: the request was answered 503', answered > 0, `${answered} request(s)`);
  check('forced failure: an error state with a retry is on screen', shown.notice && shown.retry && typeof shown.error === 'string' && shown.error.length > 0, JSON.stringify(shown));
  check('forced failure: the route is not marked ready', shown.ready !== true);

  // A 404 must be drawn as "not found", not as a retryable failure.
  await page.unroute(pattern, handler);
  const notFound = (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"nope"}' });
  await page.route(pattern, notFound);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: READY_TIMEOUT, polling: 100 });
  const missing = await page.evaluate(() => ({ missing: Boolean(document.querySelector('[data-v="missing"]')), retry: Boolean(document.querySelector('[data-retry]')) }));
  check('forced 404: drawn as not-found, with nothing to retry', missing.missing && !missing.retry, JSON.stringify(missing));
  await page.unroute(pattern, notFound);

  // The retry has to go back to make.fun for the same data, and then the page has to work.
  await page.route(pattern, handler);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__error !== null, null, { timeout: READY_TIMEOUT, polling: 100 });
  await page.unroute(pattern, handler);
  const routed = [];
  await page.route(pattern, (route) => {
    routed.push(route.request().url());
    route.continue();
  });
  await page.click('[data-retry]');
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: READY_TIMEOUT, polling: 100 });
  const recovered = await page.evaluate(() => ({ ready: window.__shotReady, error: window.__error, cards: document.querySelectorAll('ol.bounties > li').length }));
  check('forced failure: retry re-requests the same resource', routed.length > 0 && routed.every((u) => u === failures[0]), `${routed.length} request(s): ${routed[0] ?? '(none)'} vs ${failures[0]}`);
  check('forced failure: retry recovers to real data', recovered.ready === true && recovered.error === null && recovered.cards > 0, JSON.stringify(recovered));
  await page.unroute(pattern);
  // The provocation is over; anything from here on is the app's own doing again.
  page.__expect(null);
  page.__expectUrl(null);
}

/** No horizontal overflow at the three widths, on all four surfaces. */
async function verifyOverflow(browser, origin, routes) {
  for (const width of [360, 768, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    try {
      for (const route of routes) {
        await page.goto(`${origin}/${route}`, { waitUntil: 'domcontentloaded' });
        await ready(page);
        const m = await page.evaluate(() => ({
          sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          cw: document.documentElement.clientWidth,
        }));
        check(`no horizontal overflow ${width}px ${route}`, m.sw <= m.cw, `scrollWidth ${m.sw} > clientWidth ${m.cw}`);
      }
    } finally {
      await ctx.close();
    }
  }
}

// ---------------------------------------------------------------- shots

/**
 * The three captures, from shots.json, in its order. Dark theme, 1280x800, the current app on
 * live data — the same pages the verifier just read.
 */
async function writeShots(browser, origin) {
  const shots = JSON.parse(readFileSync(join(REPO, 'shots.json'), 'utf8'));
  if (shots.length !== 3) throw new Error(`shots.json lists ${shots.length} shots; the entry takes exactly 3`);
  mkdirSync(SHOTS, { recursive: true });
  // The directory holds exactly the three shots.json names: the previous build's captures go.
  const want = new Set(shots.map((s) => s.file));
  for (const f of readdirSync(SHOTS)) if (!want.has(f)) rmSync(join(SHOTS, f));
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark', deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const writtenShots = [];
  for (const shot of shots) {
    await page.goto(`${origin}/${shot.path}`, { waitUntil: 'domcontentloaded' });
    await ready(page);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (theme !== 'dark') throw new Error(`${shot.path} rendered in theme "${theme}", not dark`);
    await page.evaluate(() => document.fonts?.ready);
    const buf = await page.screenshot({ type: 'jpeg', quality: 82, animations: 'disabled' });
    writeFileSync(join(SHOTS, shot.file), buf);
    writtenShots.push({ file: shot.file, path: shot.path, bytes: buf.length });
    if (buf.length >= 256 * 1024) throw new Error(`${shot.file} is ${buf.length} bytes, over the 256 KiB cap`);
    check(`shot ${shot.file} under 256 KiB`, buf.length < 262144, `${buf.length} bytes`);
  }
  await ctx.close();
  return writtenShots;
}

// ---------------------------------------------------------------- the run

const { server, origin } = await serveApp();
const browser = await chromium.launch();
const problems = [];
let written = [];

try {
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.__origin = origin;

  // Only failures the app was not asked to produce count against it: while the forced-failure
  // route runs, `expecting` says the 5xx and its console line are this script's own doing.
  let expecting = null;
  let expectingUrl = null;
  const note = (kind, detail) => {
    if (expecting !== null && (expecting instanceof RegExp ? expecting.test(detail) : detail.includes(expecting))) return;
    problems.push({ kind, detail, url: page.url() });
  };
  page.on('console', (m) => {
    if (m.type() === 'error') note('console error', m.text());
  });
  page.on('pageerror', (e) => note('page error', e.message));
  page.on('requestfailed', (r) => {
    const failure = r.failure()?.errorText ?? '';
    if (failure.includes('ERR_ABORTED')) return; // a cancelled navigation is not a failure
    note('failed request', `${r.url()} ${failure}`);
  });
  page.on('response', (r) => {
    // A 5xx this script staged is part of the forced-failure test, not a fault of the app.
    if (r.status() >= 500 && !(expectingUrl !== null && r.url().includes(expectingUrl))) {
      problems.push({ kind: 'server error', detail: `${r.status()} ${r.url()}`, url: page.url() });
    }
  });
  page.__expect = (needle) => {
    expecting = needle;
  };
  page.__expectUrl = (needle) => {
    expectingUrl = needle;
  };

  // A real handle, taken from the live board: the top of the frontend bounty's leaderboard.
  const lbPeek = await api('/competitions/makefun-frontend-01/leaderboard?rows=all');
  const handle = lbPeek.entries?.[0]?.handle;
  if (!handle) throw new Error('the leaderboard gave no handle to verify the profile with');

  await verifyLifecycle(page, origin);
  await verifyBoard(page);
  await verifyBounty(page, 'makefun-frontend-01');
  await verifyLeaderboard(page, 'makefun-frontend-01');
  await verifyProfile(page, handle);
  await verifyForcedFailure(page, origin);
  await verifyOverflow(browser, origin, ['#/', '#/bounty/makefun-frontend-01', '#/bounty/makefun-frontend-01/leaderboard', `#/u/${handle}`]);

  if (WANT_SHOTS) written = await writeShots(browser, origin);
  await ctx.close();
} catch (err) {
  // A step that threw is a failed assertion, not a silent short run: say which one and stop.
  check(`the run completed every step (failed at: ${err?.message ?? err})`, false, String(err?.stack ?? err));
} finally {
  await browser.close();
  server.close();
}

check('no console errors', !problems.some((p) => p.kind === 'console error'), problems.filter((p) => p.kind === 'console error').map((p) => p.detail).join(' | '));
check('no page errors', !problems.some((p) => p.kind === 'page error'), problems.filter((p) => p.kind === 'page error').map((p) => p.detail).join(' | '));
check('no failed requests', !problems.some((p) => p.kind === 'failed request'), problems.filter((p) => p.kind === 'failed request').map((p) => p.detail).join(' | '));
check('no 5xx responses', !problems.some((p) => p.kind === 'server error'), problems.filter((p) => p.kind === 'server error').map((p) => p.detail).join(' | '));

// ---------------------------------------------------------------- the table

let surface = '';
console.log('');
console.log(`${pad('SURFACE', 40)} ${pad('FIELD', 40)} ${pad('DOM', 34)} ${pad('API', 34)} RESULT`);
console.log('-'.repeat(160));
for (const r of rows) {
  if (r.surface !== surface) {
    surface = r.surface;
    console.log(`\n${surface}`);
  }
  const reason = r.same ? '' : `  <- ${r.why || 'the DOM string is not the string the API implies'}`;
  console.log(`${pad('', 40)} ${pad(r.field, 40)} ${pad(r.dom, 34)} ${pad(r.want, 34)} ${r.same ? 'match' : 'MISMATCH'}${reason}`);
}

if (skipped.length > 0) {
  console.log('\nSKIPPED (not compared, excluded from both numerator and denominator)');
  for (const s of skipped) console.log(`  ${pad(s.surface, 40)} ${pad(s.field, 40)} ${s.why}`);
}

const matched = rows.filter((r) => r.same).length;
const compared = rows.length;
const percent = compared === 0 ? 0 : (matched / compared) * 100;

console.log('\nCHECKS');
for (const c of checks) console.log(`  ${c.ok ? 'pass' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? `  (${c.detail})` : ''}`);
if (problems.length > 0) {
  console.log('\nPAGE PROBLEMS');
  for (const p of problems) console.log(`  ${p.kind}: ${p.detail}  [${p.url}]`);
}

if (written.length > 0) {
  console.log('\nSHOTS');
  for (const s of written) console.log(`  ${s.file.padEnd(20)} ${String(s.bytes).padStart(7)} bytes  ${s.path}`);
}

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log(`ACCURACY: ${matched}/${compared} = ${percent.toFixed(2)}%`);

if (percent < MIN_ACCURACY) {
  console.log(`FAILED: ${percent.toFixed(2)}% is below the ${MIN_ACCURACY}% contract.`);
  process.exitCode = 1;
}
if (failed.length > 0) {
  console.log(`FAILED: ${failed.length} assertion(s) did not pass: ${failed.map((c) => c.name).join('; ')}`);
  process.exitCode = 1;
}
if (compared === 0) process.exitCode = 1;
