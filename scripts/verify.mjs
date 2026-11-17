#!/usr/bin/env node
// FarmOS's accuracy contract: serve app/ over a real HTTP server, drive real Chromium at 1280×800, and hold
// every figure on screen to the answer https://make.fun/api gave for it. Node 22, its standard library plus
// the Playwright installed beside this machine's make.fun kit.
//
//   node scripts/verify.mjs           compare the four surfaces, the layouts and the error route
//   node scripts/verify.mjs --shots   the same, and write the three screenshots of screenshots/ + shots.json
//
// It prints a table of matches and mismatches, then one line `ACCURACY: matched/compared = pct%`, and exits
// non-zero below 95% or on any console error, page error, failed request, horizontal overflow, or an error
// page whose retry does not ask again. No figure is special-cased and no rounding turns a mismatch into a match.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'app');
const SHOTS_DIR = join(ROOT, 'screenshots');
const API = 'https://make.fun/api';
const WANT_SHOTS = process.argv.includes('--shots');
const WIDTH = 1280;
const HEIGHT = 800;
const THRESHOLD = 95;

/** The Playwright this machine has. A copy inside the repository is asked for too, should anyone vendor one. */
const PLAYWRIGHT_CANDIDATES = [
  'C:/Users/friok/makefun/node_modules/playwright',
  join(ROOT, 'node_modules', 'playwright'),
];

/* ---------------------------------------------------------------- the static server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** Serves app/ at the server's root, and nothing above it. */
function serve() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end('bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(join(APP, normalize(pathname)));
    if (file !== APP && !file.startsWith(APP + sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    let size;
    try {
      const stats = statSync(file);
      if (!stats.isFile()) throw new Error('not a file');
      size = stats.size;
    } catch {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-store',
    });
    response.end(readFileSync(file));
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}

/* ---------------------------------------------------------------- the API side */

async function apiJson(path) {
  const response = await fetch(API + path, { headers: { accept: 'application/json' }, redirect: 'error' });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** Every page of the board for one status, as the app itself reads it (activity=times keeps the rows small). */
async function apiBoard(status) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 12; page++) {
    let path = `/competitions?limit=30&status=${status}&activity=times`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
    const { status: code, body } = await apiJson(path);
    if (code !== 200 || !body || !Array.isArray(body.items)) throw new Error(`GET ${path} answered ${code}`);
    items.push(...body.items);
    cursor = typeof body.next_cursor === 'string' ? body.next_cursor : null;
    if (!cursor || body.items.length === 0) break;
  }
  return items;
}

/* ---------------------------------------------------------------- the numbers, one reader per format */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A figure's normalised spelling, so "1,284" and "1284" and "$740.00" and "$740" agree where they must. */
function normNumber(text) {
  const cleaned = String(text).replace(/[\s,\u00a0\u202f]/g, '');
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(Math.min(2, Math.ceil(n * 100) % 100 === 0 ? 0 : 2));
}

function sameNumber(a, b) {
  const left = normNumber(String(a).replace(/^\$/, ''));
  const right = normNumber(String(b).replace(/^\$/, ''));
  return left !== null && right !== null && left === right;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usd = (value) => money.format(Number(value));

/** The remaining time as the app writes it: a day count above a day, hours above an hour, then minutes. */
function remaining(deadline, now) {
  const ms = Date.parse(deadline) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'closed';
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Two clock readings agree when they name the same span: the same string, or a count within a minute. */
function sameTime(dom, api) {
  if (String(dom).trim() === String(api).trim()) return true;
  const pair = (s) => {
    const both = /^(\d+)d (\d+)h$/.exec(String(s).trim());
    if (both) return Number(both[1]) * 1440 + Number(both[2]) * 60;
    const hm = /^(\d+)h (\d+)m$/.exec(String(s).trim());
    if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
    const only = /^(\d+)m$/.exec(String(s).trim());
    if (only) return Number(only[1]);
    return null;
  };
  const a = pair(dom);
  const b = pair(api);
  return a !== null && b !== null && Math.abs(a - b) <= 1;
}

function sameDate(dom, iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const stamp = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
  return String(dom).includes(stamp);
}

/** The rate the API keeps in millionths, as the app shows it. */
const rateText = (micro) => `${(Number(micro) / 10_000).toFixed(2)}%`;

function bytesText(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A leaderboard cell in its own unit, by the column's `source`, exactly as views.js does it. */
function lbCell(row, column) {
  const shown = row.display && row.display[column.key] !== undefined ? row.display[column.key] : row.values ? row.values[column.key] : null;
  if (shown === null || shown === undefined || String(shown).trim().toLowerCase() === 'n/a') return '—';
  const source = String(column.source || '');
  const asNumber = Number(shown);
  if (source.includes('bytes') || /\bbytes\b/i.test(column.title)) return bytesText(asNumber);
  if (source.endsWith('_micro') || column.precision === 0 && source.includes('rate')) return rateText(asNumber);
  return String(shown);
}

/* ---------------------------------------------------------------- the results table */

const rows = [];
let compared = 0;
let matched = 0;

function record(surface, field, domValue, apiValue, reason, ok) {
  compared += 1;
  if (ok) matched += 1;
  rows.push({ surface, field, dom: domValue, api: apiValue, reason: ok ? 'match' : reason, ok });
}

function note(surface, field, why) {
  rows.push({ surface, field, dom: '—', api: '—', reason: `excluded: ${why}`, ok: null });
}

/* ---------------------------------------------------------------- the browser */

async function loadPlaywright() {
  for (const candidate of PLAYWRIGHT_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
    const entry = typeof pkg.main === 'string' ? pkg.main : 'index.js';
    const mod = await import(pathToFileURL(join(candidate, entry)).href);
    // An ESM wrapper can hang its exports under `default`, so both shapes are tried.
    const chromium = mod.chromium ?? (mod.default && mod.default.chromium);
    if (chromium && typeof chromium.launch === 'function') return { chromium };
  }
  throw new Error(`no Playwright found: looked in ${PLAYWRIGHT_CANDIDATES.join(', ')}`);
}

/** The problems a page must not have: console errors, page errors and failed requests. */
function watch(page) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !MISSING_IS_AN_ANSWER.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = request.failure();
    // A cancelled avatar or a 404 from make.fun's own API is the API's business, reported where it is compared.
    if (/\/\/make\.fun\//.test(url) || url.startsWith('data:')) return;
    problems.push(`requestfailed: ${url} (${failure ? failure.errorText : 'unknown'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith('http://127.0.0.1')) {
      problems.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return problems;
}

/** The hash the app has actually rendered, recorded by the script the app loads. */
const HASH_KEY = '__renderedHash';

/** The page-side guard: a route sets it only once it has finished drawing, so a flag left over from the
 *  previous page can never be read as this one's answer. */
const RENDERED = (hash) => `(window.${HASH_KEY} === ${JSON.stringify(hash)} && window.__shotReady === true) || window.__error !== null`;

/** The app records the hash it drew, in the same place it sets the flag. */
async function markRendered(page) {
  await page.addInitScript(() => {
    window.__renderedHash = null;
    let ready = true;
    Object.defineProperty(window, '__shotReady', {
      configurable: true,
      get: () => ready,
      set: (value) => {
        ready = value;
        if (value === true) window.__renderedHash = location.hash;
      },
    });
  });
}

/** Waits for the route's own flag, then for two frames: never a bare timeout as the only wait. */
async function settle(page, hash) {
  await page.goto(`http://127.0.0.1:${page.__port}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(RENDERED(hash), null, { timeout: 30_000 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return page.evaluate(() => ({ ready: window.__shotReady, error: window.__error }));
}

/** Navigating between hashes reuses the page, as a reader does, and waits on the flag again. */
async function goHash(page, hash) {
  await page.evaluate((next) => { location.hash = next; }, hash);
  await page.waitForFunction(RENDERED(hash), null, { timeout: 30_000 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return page.evaluate(() => ({ ready: window.__shotReady, error: window.__error }));
}

const textOf = (page, selector) => page.locator(selector).first().innerText();

/** A 404 on make.fun is the API's answer, not a page defect: the error route, a withheld avatar and an entry
 *  whose metrics are withheld all ask for something the API has nothing at, and each is compared where it counts. */
const MISSING_IS_AN_ANSWER = /^Failed to load resource: the server responded with a status of 404/;

/* ---------------------------------------------------------------- the surfaces */

async function checkBoard(page, problems) {
  const now = Date.now();
  const items = await apiBoard('open');
  await settle(page, '#/');
  const live = items.filter((b) => Date.parse(b.deadline) > now);

  const summary = await page.evaluate(() => ({
    bounties: document.querySelector('[data-f="bounties"]')?.textContent ?? null,
    pot: document.querySelector('[data-f="pot"]')?.textContent ?? null,
    entries: document.querySelector('[data-f="entries"]')?.textContent ?? null,
  }));
  const potTotal = live.reduce((n, b) => n + Number.parseFloat(b.potUsd ?? '0'), 0);
  const entryTotal = live.reduce((n, b) => n + (Number(b.submissionCount) || 0), 0);

  record('#/', 'summary bounties', summary.bounties, String(live.length), 'the header does not show how many bounties still take entries', sameNumber(summary.bounties, live.length));
  record('#/', 'summary live pot', summary.pot, usd(potTotal), 'the header pot is not the sum of the live pots the API gives', sameNumber(summary.pot, usd(potTotal)));
  record('#/', 'summary entries', summary.entries, whole.format(entryTotal), 'the header entry count is not the sum of the API counts', sameNumber(summary.entries, whole.format(entryTotal)));

  const cards = await page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('a.card[data-slug]')) {
      const read = (field) => card.querySelector(`[data-f="${field}"]`)?.textContent ?? null;
      out.push({
        slug: card.dataset.slug,
        href: card.getAttribute('href'),
        pot: read('pot'),
        fee: read('fee'),
        left: read('left'),
        entries: read('entries'),
        status: read('status'),
      });
    }
    return out;
  });

  record('#/', 'cards drawn', String(cards.length), String(live.length), 'the board does not draw one card per live bounty', cards.length === live.length);

  const bySlug = new Map(live.map((b) => [b.slug, b]));
  for (const card of cards) {
    const bounty = bySlug.get(card.slug);
    const field = `card ${card.slug}`;
    if (!bounty) {
      record('#/', field, card.slug, '—', 'a card names a bounty the API does not return as live', false);
      continue;
    }
    record('#/', `${field} link`, card.href, `#/bounty/${bounty.slug}`, 'the card does not link to its bounty', card.href === `#/bounty/${bounty.slug}`);
    const apiPot = usd(bounty.potUsd);
    record('#/', `${field} pot`, (card.pot || '').replace(/\s*live pot\s*$/, ''), apiPot, 'the card pot is not the API potUsd', sameNumber((card.pot || '').replace(/\s*live pot\s*$/, ''), apiPot));
    const apiFee = bounty.entryFeeUsd === null || bounty.entryFeeUsd === undefined ? 'no entry fee' : `${usd(bounty.entryFeeUsd)} to enter`;
    record('#/', `${field} fee`, card.fee, apiFee, 'the card fee is not the API entryFeeUsd', String(card.fee).trim() === apiFee);
    const apiLeft = `closes in ${remaining(bounty.deadline, Date.now())}`;
    record('#/', `${field} time left`, card.left, apiLeft, 'the card clock does not match the API deadline', sameTime(String(card.left).replace(/^closes in /, ''), remaining(bounty.deadline, Date.now())));
    const apiEntries = `${whole.format(Number(bounty.submissionCount) || 0)} entries`;
    record('#/', `${field} entries`, card.entries, apiEntries, 'the card entry count is not the API submissionCount', sameNumber(String(card.entries).replace(/\s*entries\s*$/, ''), String(Number(bounty.submissionCount) || 0)));
    record('#/', `${field} status`, card.status, 'live', 'a card on the live board does not read live', String(card.status).trim() === 'live');
  }

  // The closed board, over the same reader.
  const closed = await apiBoard('closed');
  await goHash(page, '#/closed');
  const closedCards = await page.evaluate(() => [...document.querySelectorAll('a.card[data-slug]')].map((c) => c.dataset.slug));
  const closedNow = closed.filter((b) => !(Date.parse(b.deadline) > Date.now()));
  record('#/closed', 'closed cards', String(closedCards.length), String(closedNow.length), 'the closed board does not draw one card per closed bounty', closedCards.length === closedNow.length);
}

async function checkBounty(page, problems) {
  const slug = 'makefun-frontend-01';
  const { status, body } = await apiJson(`/competitions/${slug}`);
  if (status !== 200 || !body) throw new Error(`GET /competitions/${slug} answered ${status}`);
  await settle(page, `#/bounty/${slug}`);

  const dom = await page.evaluate((s) => {
    const read = (field, offset = s) => document.querySelector(`[data-f="${field}"][data-o="${offset}"]`)?.textContent ?? null;
    const rows = [...document.querySelectorAll('[data-f="reward-row"]')].map((row) => ({
      place: row.children[0]?.textContent ?? null,
      reward: row.children[1]?.textContent ?? null,
      now: row.querySelector('[data-f="reward-now"]')?.textContent ?? null,
    }));
    return {
      title: document.querySelector('[data-f="title"]')?.textContent ?? null,
      pot: document.querySelector('div[data-f="pot"]')?.textContent ?? null,
      fee: document.querySelector('dd [data-f="fee"]')?.textContent ?? (document.querySelector('[data-f="fee-none"]') ? null : 'missing'),
      deadline: document.querySelector('dd[data-f="deadline"]')?.textContent ?? null,
      entries: document.querySelector('dd[data-f="entries"]')?.textContent ?? null,
      left: document.querySelector('dd[data-f="left"]')?.textContent ?? null,
      status: document.querySelector('dd[data-f="status"]')?.textContent ?? null,
      description: document.querySelector('[data-f="description"]')?.textContent ?? '',
      rewards: rows,
      rewardTotal: document.querySelector('[data-f="reward-total"]')?.textContent ?? null,
    };
  }, slug);

  record('#/bounty', 'title', dom.title, body.title, 'the page title is not the API title', String(dom.title).trim() === String(body.title).trim());
  record('#/bounty', 'live pot', (dom.pot || '').replace(/\s*USD\s*$/, ''), usd(body.potUsd), 'the pot is not the API potUsd', sameNumber((dom.pot || '').replace(/\s*USD\s*$/, ''), usd(body.potUsd)));
  if (body.entryFeeUsd === null || body.entryFeeUsd === undefined) {
    record('#/bounty', 'entry fee', dom.fee, 'none', 'the page shows a fee the API does not set', dom.fee === null);
  } else {
    record('#/bounty', 'entry fee', dom.fee, usd(body.entryFeeUsd), 'the fee is not the API entryFeeUsd', sameNumber(dom.fee, usd(body.entryFeeUsd)));
  }
  record('#/bounty', 'deadline', dom.deadline, body.deadline, 'the deadline on the page is not the API deadline', sameDate(dom.deadline, body.deadline));
  record('#/bounty', 'entries', dom.entries, whole.format(Number(body.submissionCount) || 0), 'the entry count is not the API submissionCount', sameNumber(dom.entries, String(Number(body.submissionCount) || 0)));
  record('#/bounty', 'time left', dom.left, remaining(body.deadline, Date.now()), 'the clock does not match the API deadline', sameTime(dom.left, remaining(body.deadline, Date.now())));
  const live = Date.parse(body.deadline) > Date.now() && body.acceptingSubmissions !== false;
  const wantStatus = live ? 'live' : body.status === 'resolved' ? 'resolved' : 'closed';
  record('#/bounty', 'status', dom.status, wantStatus, 'the status is not the one the deadline and acceptingSubmissions give', String(dom.status).trim() === wantStatus);
  record('#/bounty', 'description shown', String(dom.description.trim().length > 40 ? 'shown' : String(dom.description.trim().length)), 'shown', 'the description is not on the page', dom.description.trim().length > 40);

  const rewardsNow = Array.isArray(body.rewardsNow) ? body.rewardsNow : [];
  record('#/bounty', 'reward rows', String(dom.rewards.length), String(rewardsNow.length), 'the rewards table does not hold one row per API reward place', dom.rewards.length === rewardsNow.length);
  for (const reward of rewardsNow) {
    const row = dom.rewards.find((r) => String(r.place).trim() === `Place ${reward.place}`);
    const field = `reward place ${reward.place}`;
    if (!row) {
      record('#/bounty', field, '—', usd(reward.amountUsd), 'the rewards table has no row for this place', false);
      continue;
    }
    record('#/bounty', `${field} with fees`, row.now, usd(reward.amountUsd), 'the live reward is not the API amountUsd', sameNumber(row.now, usd(reward.amountUsd)));
    record('#/bounty', `${field} base`, row.reward, body.rewards && body.rewards[String(reward.place)] !== undefined ? usd(body.rewards[String(reward.place)]) : '—', 'the base reward is not the API rewards[place]', body.rewards && sameNumber(row.reward, usd(body.rewards[String(reward.place)])));
  }
}

async function checkLeaderboard(page, problems) {
  const slug = 'makefun-frontend-01';
  const { status, body } = await apiJson(`/competitions/${slug}/leaderboard?rows=all`);
  if (status !== 200 || !body) throw new Error(`GET /competitions/${slug}/leaderboard answered ${status}`);
  await settle(page, `#/bounty/${slug}/leaderboard`);

  const columns = (Array.isArray(body.columns) ? body.columns : []).filter((c) => !c.hidden);
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const dom = await page.evaluate(() => ({
    headers: [...document.querySelectorAll('th[data-col-head]')].map((th) => th.dataset.colHead),
    rows: [...document.querySelectorAll('tr[data-f="lb-row"]')].map((tr) => {
      const metrics = {};
      for (const cell of tr.querySelectorAll('[data-f="lb-metric"]')) metrics[cell.dataset.col] = cell.textContent;
      return {
        rank: tr.querySelector('[data-f="lb-rank"]')?.textContent ?? null,
        handle: tr.querySelector('[data-f="lb-handle"]')?.textContent ?? null,
        title: tr.querySelector('[data-f="lb-title"]')?.textContent ?? '',
        metrics,
      };
    }),
  }));

  record('#/bounty/leaderboard', 'columns drawn', dom.headers.join(','), columns.map((c) => c.key).join(','), 'the table does not carry every API column, in the API order', dom.headers.join(',') === columns.map((c) => c.key).join(','));
  record('#/bounty/leaderboard', 'rows drawn', String(dom.rows.length), String(entries.length), 'the table does not hold one row per API entry', dom.rows.length === entries.length);

  for (const entry of entries) {
    const index = entries.indexOf(entry);
    const drawn = dom.rows[index];
    const field = `row ${index + 1} @${entry.handle}`;
    if (!drawn) {
      record('#/bounty/leaderboard', field, '—', entry.handle, 'the table has no row at this place', false);
      continue;
    }
    record('#/bounty/leaderboard', `${field} entrant`, drawn.handle, entry.handle, 'the row names another entrant than the API entry at this place', drawn.handle === entry.handle);
    if (entry.rank === null || entry.rank === undefined) {
      note('#/bounty/leaderboard', `${field} place`, 'the API withholds this entry\'s place (rank null), so the page prints a dash and there is no figure to compare');
    } else {
      record('#/bounty/leaderboard', `${field} place`, drawn.rank, String(entry.rank), 'the place is not the API rank', Number(drawn.rank) === Number(entry.rank));
    }
    for (const column of columns) {
      const want = lbCell(entry, column);
      if (want === '—') {
        note('#/bounty/leaderboard', `${field} ${column.title}`, `the API sends no value for ${column.key}`);
        continue;
      }
      const got = drawn.metrics[column.key];
      const ok = want.endsWith('%') || want.endsWith('B') || want.endsWith('iB')
        ? String(got).trim() === want
        : sameNumber(got, want) || String(got).trim() === want;
      record('#/bounty/leaderboard', `${field} ${column.title}`, got, want, `the ${column.key} figure is not the API value in its own unit`, ok);
    }
  }
}

async function checkProfile(page, problems) {
  const handle = 'superskie';
  const { status, body } = await apiJson(`/profiles/${handle}`);
  if (status !== 200 || !body) throw new Error(`GET /profiles/${handle} answered ${status}`);
  await settle(page, `#/u/${handle}`);
  const dom = await page.evaluate(() => ({
    handle: document.querySelector('[data-f="handle"]')?.textContent ?? null,
    entered: document.querySelector('[data-f="entered"]')?.textContent ?? null,
    placed: document.querySelector('[data-f="placed"]')?.textContent ?? null,
    won: document.querySelector('[data-f="won"]')?.textContent ?? null,
    prize: document.querySelector('[data-f="prize"]')?.textContent ?? null,
    avatar: document.querySelector('.profile-head img.avatar')?.getAttribute('src') ?? null,
    entries: [...document.querySelectorAll('[data-f="entry-row"]')].map((li) => ({
      id: li.dataset.o,
      place: li.querySelector('[data-f="entry-place"]')?.textContent ?? null,
      score: li.querySelector('[data-f="entry-score"]')?.textContent ?? null,
      title: li.querySelector('a')?.textContent ?? null,
    })),
  }));
  const record_ = body.record || {};
  record('#/u', 'handle', dom.handle, `@${body.handle}`, 'the page does not name the API handle', String(dom.handle).trim() === `@${body.handle}`);
  record('#/u', 'entered', dom.entered, whole.format(record_.competitions_entered), 'the entered count is not the API record', sameNumber(dom.entered, String(record_.competitions_entered)));
  record('#/u', 'placed', dom.placed, whole.format(record_.competitions_placed), 'the placed count is not the API record', sameNumber(dom.placed, String(record_.competitions_placed)));
  record('#/u', 'won', dom.won, whole.format(record_.competitions_won), 'the won count is not the API record', sameNumber(dom.won, String(record_.competitions_won)));
  record('#/u', 'prize money', dom.prize, usd(record_.prize_usd), 'the prize total is not the API record', sameNumber(dom.prize, usd(record_.prize_usd)));
  const avatarUrl = body.avatar && body.avatar.url ? body.avatar.url : body.image;
  record('#/u', 'avatar', dom.avatar, avatarUrl ? `https://make.fun${avatarUrl}` : '—', 'the avatar is not the API avatar', dom.avatar !== null && String(dom.avatar).endsWith(avatarUrl));

  const solutions = Array.isArray(body.solutions) ? body.solutions : [];
  record('#/u', 'entries listed', String(dom.entries.length), String(solutions.length), 'the page does not list every API entry', dom.entries.length === solutions.length);
  for (const solution of solutions) {
    const drawn = dom.entries.find((e) => e.id === solution.submission_id);
    const field = `entry ${solution.title ? solution.title.slice(0, 30) : solution.submission_id}`;
    if (!drawn) {
      record('#/u', field, '—', solution.submission_id, 'the entry is missing from the page', false);
      continue;
    }
    if (solution.placement === null || solution.placement === undefined) {
      note('#/u', `${field} place`, 'the API sends no placement for this entry, so the page prints a dash');
    } else {
      record('#/u', `${field} place`, drawn.place, `#${solution.placement}`, 'the place is not the API placement', String(drawn.place).trim() === `#${solution.placement}`);
    }
    if (solution.score === null || solution.score === undefined) {
      note('#/u', `${field} score`, 'the API sends no score for this entry');
    } else {
      const want = `${solution.score.display} ${solution.score.column ? solution.score.column.title : ''}`.trim();
      record('#/u', `${field} score`, drawn.score, want, 'the score is not the API score display with its column', String(drawn.score).trim() === want);
    }
  }
}

/** No horizontal overflow at the three widths: the document may not be wider than its own window. */
async function checkOverflow(page, hash) {
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : HEIGHT });
    await goHash(page, hash).catch(() => {});
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    const ok = overflow.scroll <= overflow.client + 1;
    record(hash, `overflow at ${width}px`, `${overflow.scroll}px`, `${overflow.client}px`, `the page scrolls sideways at ${width}px`, ok);
  }
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
}

/** A 404 route: the error state offers a retry, and the retry really asks make.fun again. */
async function checkErrorRoute(page) {
  const requests = [];
  page.on('request', (request) => {
    if (request.url().startsWith(`${API}/competitions/no-such-bounty-farmos`)) requests.push(request.url());
  });
  await settle(page, '#/bounty/no-such-bounty-farmos');
  const state = await page.evaluate(() => ({
    error: window.__error,
    ready: window.__shotReady,
    message: document.querySelector('[data-f="error-message"]')?.textContent ?? null,
    retry: !!document.querySelector('[data-f="error"] [data-action="retry"]'),
  }));
  record('#/bounty/<missing>', 'error flag', String(state.error), 'set', 'the error route does not set window.__error', typeof state.error === 'string' && state.error.length > 0);
  record('#/bounty/<missing>', 'error message', state.message, 'no competition no-such-bounty-farmos', 'the page does not repeat the API\'s own words', String(state.message || '').includes('no competition'));
  record('#/bounty/<missing>', 'retry offered', String(state.retry), 'true', 'the error state offers no retry', state.retry === true);
  const before = requests.length;
  if (state.retry) {
    await Promise.all([
      page.waitForFunction(() => window.__shotReady === true, null, { timeout: 30_000 }),
      page.locator('[data-f="error"] [data-action="retry"]').click(),
    ]);
    await page.waitForFunction(() => window.__error !== null || document.querySelector('[data-f="error"]'), null, { timeout: 10_000 }).catch(() => {});
  }
  const after = requests.length;
  record('#/bounty/<missing>', 'retry re-requests', String(after - before), '1', 'the retry did not ask make.fun again', after - before >= 1);
}

/* ---------------------------------------------------------------- the screenshots */

async function writeShots(page) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const plan = [
    { file: 'board.png', path: '#/' },
    { file: 'bounty.png', path: '#/bounty/makefun-frontend-01' },
    { file: 'leaderboard.png', path: '#/bounty/makefun-frontend-01/leaderboard' },
  ];
  config().theme = 'dark';
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  const sizes = [];
  for (const shot of plan) {
    await settle(page, shot.path);
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('farmos.theme', 'dark'); });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const file = join(SHOTS_DIR, shot.file);
    await page.screenshot({ path: file, type: 'png', fullPage: false });
    sizes.push({ file: shot.file, bytes: statSync(file).size });
  }
  const shotsJson = plan.map((shot) => ({ file: shot.file, path: shot.path, viewport: { width: WIDTH, height: HEIGHT } }));
  writeFileSync(join(ROOT, 'shots.json'), `${JSON.stringify(shotsJson, null, 2)}\n`);
  return sizes;
}

function config() {
  return verifyConfig;
}
const verifyConfig = { theme: 'dark' };

/* ---------------------------------------------------------------- the run */

function printTable() {
  const header = ['surface', 'field', 'DOM', 'API', 'reason'];
  const widths = [22, 34, 22, 26, 58];
  const cut = (text, n) => {
    const s = String(text ?? '—').replace(/\s+/g, ' ').trim();
    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
  };
  const line = (cells) => cells.map((c, i) => cut(c, widths[i]).padEnd(widths[i])).join(' | ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const row of rows) {
    if (row.ok === true) console.log(`\u001b[32m${line([row.surface, row.field, row.dom, row.api, row.reason])}\u001b[0m`);
    else if (row.ok === false) console.log(`\u001b[31m${line([row.surface, row.field, row.dom, row.api, row.reason])}\u001b[0m`);
    else console.log(`\u001b[90m${line([row.surface, row.field, row.dom, row.api, row.reason])}\u001b[0m`);
  }
}

async function main() {
  const failures = [];
  const { server, port } = await serve();
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: 'dark', deviceScaleFactor: 1 });
  const page = await context.newPage();
  await markRendered(page);
  page.__port = port;
  const problems = watch(page);

  try {
    await checkBoard(page, problems);
    await checkBounty(page, problems);
    await checkLeaderboard(page, problems);
    await checkProfile(page, problems);
    await checkOverflow(page, '#/');
    await checkOverflow(page, '#/bounty/makefun-frontend-01');
    await checkOverflow(page, '#/bounty/makefun-frontend-01/leaderboard');
    await checkOverflow(page, '#/u/superskie');
    await checkErrorRoute(page);
    if (WANT_SHOTS) {
      const sizes = await writeShots(page);
      for (const size of sizes) console.log(`shot screenshots/${size.file}  ${size.bytes} bytes`);
    }
  } catch (err) {
    problems.push(`verify: ${err && err.message ? err.message : err}`);
  } finally {
    await context.close();
    await browser.close();
    server.close();
    server.closeAllConnections();
  }

  printTable();
  for (const problem of problems) failures.push(problem);

  const percent = compared === 0 ? 0 : (matched / compared) * 100;
  const mismatches = rows.filter((row) => row.ok === false);
  if (problems.length > 0) {
    console.log('\nRuntime problems:');
    for (const problem of problems.slice(0, 20)) console.log(`  - ${problem}`);
    if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
  }
  if (mismatches.length > 0) {
    console.log('\nMismatches:');
    for (const row of mismatches.slice(0, 40)) console.log(`  - ${row.surface} · ${row.field}: DOM ${JSON.stringify(row.dom)} vs API ${JSON.stringify(row.api)} (${row.reason})`);
  }
  console.log('');
  console.log(`ACCURACY: ${matched}/${compared} = ${percent.toFixed(2)}%`);
  if (percent < THRESHOLD) {
    console.error(`below ${THRESHOLD}%: fix the app and measure again`);
    process.exitCode = 1;
  }
  if (failures.length > 0) {
    console.error(`${failures.length} runtime problem(s): console errors, page errors, failed requests, overflow or a retry that did not ask again`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`verify: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
