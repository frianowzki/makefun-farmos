// The accuracy contract for the app in app/, measured rather than asserted.
//
//   node scripts/verify.mjs            measure every surface, print one table and one ACCURACY line
//   node scripts/verify.mjs --shots    also write the three screenshots shots.json names
//
// For each of the four surfaces this drives a real Chromium at 1280x800 against app/ served over HTTP, waits for
// the app's own window.__shotReady flag, reads what the page shows from the DOM, then fetches the same resources
// from https://make.fun/api with fetch and computes what each field should read. Every field compared is one unit;
// a field whose expected value cannot be derived honestly from the API is listed as excluded with the reason, and
// counts in neither the numerator nor the denominator. Anything short of 95% matched exits non-zero.
//
// The honesty rules this file keeps: no value is special-cased to pass, no mismatch is rounded into a match, and no
// API answer is invented. Both sides are read from their own source and compared as they are.

import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(join(repo, 'app'));
const API = 'https://make.fun/api';
const SHOTS = process.argv.includes('--shots');
const THRESHOLD = 95;

const SLUG = 'makefun-frontend-01';
const HANDLE = 'nightshift-labs';
const ROUTES = {
  board: '#/',
  bounty: `#/bounty/${SLUG}`,
  leaderboard: `#/bounty/${SLUG}/leaderboard`,
  profile: `#/u/${HANDLE}`,
};
const MISSING = `#/bounty/makefun-verify-no-such-bounty-${Date.now()}`;
const VIEWPORT = { width: 1280, height: 800 };
// The API's answers change while this runs (a bug bounty's pot grows by the minute, a profile's record by the
// entry), so a DOM read and the fetch it is compared with are taken as close together as the two allow and the
// tolerance for a value that can move while the app is open stays small.
const MONEY_EPS = 0.005;

// ---------------------------------------------------------------- the API side

/** One GET of the public API, as parsed JSON. Throws with the API's own words when it does not answer 2xx. */
async function apiGet(path) {
  const response = await fetch(API + path, { headers: { accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// The formatters the app uses, rebuilt here so the expected string is produced the same way the DOM's is.
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const COUNT = new Intl.NumberFormat('en-US');
const DECIMAL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const money = (v) => USD.format(Number(v));
const count = (v) => COUNT.format(Number(v));
const integer = (v) => (Number.isInteger(Number(v)) ? COUNT.format(Number(v)) : DECIMAL.format(Number(v)));
const shortDate = (iso) => SHORT_DATE.format(new Date(iso));
const close = (a, b, eps = MONEY_EPS) => Math.abs(a - b) <= eps;

/** The pot the app shows for a bounty: potUsd where the API states it, else the reward. */
const potOf = (b) => Number(b.potUsd ?? b.rewardAmount);
const feeOf = (b) => Number(b.entryFeeUsd);
const hasFee = (b) => Number(b.entryFeeUsd) > 0;

/** `2d 4h` / `35m` / `closed`, to compare a time-left label against the deadline, and how far it may be off. */
function timeLeftParts(iso, now) {
  const ms = new Date(iso).getTime() - now;
  if (!(ms > 0)) return { closed: true };
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return { days, hours };
  if (hours > 0) return { hours, minutes: minutes % 60 };
  return { minutes: Math.max(minutes, 1) };
}

/**
 * Whether a `2d 4h` label agrees with a deadline. The label is whole units, so it must match the deadline's own
 * reading at the instant of the check or the one a minute later: the page drew it a moment before we read it.
 */
function timeLeftMatches(label, iso, now) {
  const text = String(label ?? '').trim();
  for (const at of [now, now - 60_000, now + 60_000]) {
    const p = timeLeftParts(iso, at);
    if (p.closed) return text === 'closed' || text === '—';
    if (p.days !== undefined && text === `${p.days}d ${p.hours}h`) return true;
    if (p.days === undefined && p.hours !== undefined && text === `${p.hours}h ${p.minutes}m`) return true;
    if (p.days === undefined && p.hours === undefined && text === `${p.minutes}m`) return true;
  }
  return false;
}

/** The unit a leaderboard column's value is in, from the column's own source, as the app reads it. */
function unitOf(column) {
  const key = String(column.key ?? '');
  const source = String(column.source ?? '');
  if (key === 'bytes' || /\.bytes$/.test(source)) return 'bytes';
  if (key === 'valid' || /\.valid$/.test(source)) return 'count';
  if (/micro$/.test(key) || /micro$/.test(source) || /_low$|_high$/.test(key)) return 'micro';
  return 'number';
}

// ---------------------------------------------------------------- the DOM side

/** Every rendered cell of a row, with the label the page puts on it. */
const readRows = (page, selector) =>
  page.$$eval(selector, (nodes) =>
    nodes.map((row) => {
      const cells = {};
      for (const cell of row.querySelectorAll('[class*="row__cell"]')) {
        const key = cell.querySelector('.row__k')?.textContent?.trim() ?? '';
        const value = [...cell.querySelectorAll(':scope > span')]
          .filter((s) => !s.classList.contains('row__k'))
          .map((s) => s.textContent.trim())
          .join(' ');
        cells[key] = value;
      }
      const kpis = [...row.querySelectorAll('.figure, .stat')].map((k) => ({
        k: k.querySelector('.figure__k, .stat__k')?.textContent?.trim() ?? '',
        v: k.querySelector('.figure__v, .stat__v')?.textContent?.trim() ?? '',
        s: k.querySelector('.figure__s, .stat__s')?.textContent?.trim() ?? '',
      }));
      return {
        title: row.querySelector('.row__title, .entry-row__title')?.textContent?.trim() ?? '',
        href: row.querySelector('a')?.getAttribute('href') ?? '',
        cells,
        kpis,
        text: row.textContent.replace(/\s+/g, ' ').trim(),
        meta: row.querySelector('.row__meta')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        place: row.querySelector('.place')?.textContent?.trim() ?? '',
        entry: row.querySelector('.entry__text')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        nums: [...row.querySelectorAll('.col-num')].map((c) => c.textContent.trim()),
      };
    }),
  );

const statCards = (page, scope = '') =>
  page.$$eval(`${scope} .stat`.trim() || '.stat', (nodes) =>
    nodes.map((n) => ({
      k: n.querySelector('.stat__k')?.textContent?.trim() ?? '',
      v: n.querySelector('.stat__v')?.textContent?.trim() ?? '',
      s: n.querySelector('.stat__s')?.textContent?.trim() ?? '',
    })),
  );

const figureCards = (page) =>
  page.$$eval('.figure', (nodes) =>
    nodes.map((n) => ({
      k: n.querySelector('.figure__k')?.textContent?.trim() ?? '',
      v: n.querySelector('.figure__v')?.textContent?.trim() ?? '',
      s: n.querySelector('.figure__s')?.textContent?.trim() ?? '',
    })),
  );

const facts = (page) =>
  page.$$eval('.fact', (nodes) => {
    const out = {};
    for (const n of nodes) out[n.querySelector('dt')?.textContent?.trim() ?? ''] = n.querySelector('dd')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return out;
  });

/** Wait for the app's own readiness flag, then for a beat so lazy images and the final layout settle. */
async function ready(page, route) {
  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 45_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// ---------------------------------------------------------------- the report

const comparisons = [];
const excluded = [];
const failures = [];
const problems = [];

/** One unit of the contract: what the page shows, what the API says it should, and whether they agree. */
function compare({ surface, field, dom, api, ok, reason = '' }) {
  comparisons.push({ surface, field, dom: String(dom), api: String(api), ok });
  if (!ok) problems.push(`${surface} · ${field}: DOM ${JSON.stringify(String(dom))} ≠ API ${JSON.stringify(String(api))} — ${reason}`);
}

/** A field the API cannot honestly support. Out of both the numerator and the denominator, and said out loud. */
function skip({ surface, field, dom, why }) {
  excluded.push({ surface, field, dom: String(dom ?? ''), why });
}

// ---------------------------------------------------------------- the static server (as scripts/smoke.mjs)

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
const base = `http://127.0.0.1:${server.address().port}/`;

// ---------------------------------------------------------------- the API baseline, read once

let board, bounty, leaderboard, profile;
try {
  [board, bounty, leaderboard, profile] = await Promise.all([
    apiGet('/competitions?status=open&activity=times&limit=100'),
    apiGet(`/competitions/${SLUG}`),
    apiGet(`/competitions/${SLUG}/leaderboard?rows=first`),
    apiGet(`/profiles/${HANDLE}`),
  ]);
} catch (error) {
  console.log(`Could not read make.fun's API, so nothing can be measured: ${error.message}`);
  server.close();
  process.exit(1);
}

const browser = await chromium.launch();

/** A context with the callbacks that decide whether the page behaved. */
async function newPage({ colorScheme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // A route deliberately asked to fail answers 404, and Chromium logs that status as a console error. The
    // request going unanswered is the state under test; the fetch's own rejection is judged by the error state.
    if (/the server responded with a status of (404|5\d\d)\b/.test(text)) return;
    problems.push(`console error on ${page.url()}: ${text}`);
  });
  page.on('pageerror', (e) => problems.push(`page error on ${page.url()}: ${e.message}`));
  page.on('requestfailed', (r) => {
    const failed = r.failure()?.errorText ?? 'unknown';
    // A cancelled image whose src is swapped while the markup is repainted is not a broken request.
    if (failed.includes('ERR_ABORTED')) return;
    problems.push(`request failed on ${page.url()}: ${r.url()} (${failed})`);
  });
  return { ctx, page };
}

const measured = {};
const { ctx: mainCtx, page } = await newPage();

// ---------------------------------------------------------------- #/ — the board

await ready(page, ROUTES.board);
{
  const surface = 'board';
  const dom = await page.evaluate(() => ({
    ledger: document.querySelector('.lede')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    stats: [...document.querySelectorAll('.stat')].map((n) => ({
      k: n.querySelector('.stat__k')?.textContent?.trim() ?? '',
      v: n.querySelector('.stat__v')?.textContent?.trim() ?? '',
      s: n.querySelector('.stat__s')?.textContent?.trim() ?? '',
    })),
    rows: [...document.querySelectorAll('.rows--board .row')].map((row) => {
      const cells = {};
      for (const cell of row.querySelectorAll('[class*="row__cell"]')) {
        const key = cell.querySelector('.row__k')?.textContent?.trim() ?? '';
        cells[key] = [...cell.querySelectorAll(':scope > span')]
          .filter((s) => !s.classList.contains('row__k'))
          .map((s) => s.textContent.replace(/\s+/g, ' ').trim())
          .join(' ');
      }
      return {
        title: row.querySelector('.row__title')?.textContent?.trim() ?? '',
        href: row.querySelector('a')?.getAttribute('href') ?? '',
        meta: row.querySelector('.row__meta')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        cells,
      };
    }),
  }));
  const now = Date.now();
  measured.board = dom;

  // Read the board again now that the DOM is in hand, so a pot that grew while the app was open is visible.
  const live = await apiGet('/competitions?status=open&activity=times&limit=100');
  const items = Array.isArray(live.items) ? live.items : [];

  // The live pot the page states: its Total, its ledger line, and each row's own Pot cell.
  const sumPot = items.reduce((n, b) => n + potOf(b), 0);
  const sumEntries = items.reduce((n, b) => n + (Number(b.submissionCount) || 0), 0);
  const sumFees = items.reduce((n, b) => n + (Number(b.entryFeesUsd) || 0), 0);
  const feeCharged = items.filter(hasFee).length;

  const potStat = dom.stats.find((s) => s.k === 'Live pot')?.v ?? '';
  compare({
    surface,
    field: 'Live pot total',
    dom: potStat,
    api: money(sumPot),
    ok: close(Number(String(potStat).replace(/[^0-9.]/g, '')), sumPot),
    reason: 'the sum of each open bounty\'s potUsd (or rewardAmount where no pot is stated)',
  });
  const entriesStat = dom.stats.find((s) => s.k === 'Entries')?.v ?? '';
  compare({
    surface,
    field: 'Entries total',
    dom: entriesStat,
    api: count(sumEntries),
    ok: Number(String(entriesStat).replace(/[^0-9.]/g, '')) === sumEntries,
    reason: 'the sum of submissionCount over the same bounties',
  });

  // The ledger line: "<n> live bounties, $<pot> to share."
  const ledgerMatch = dom.ledger.match(/^(\d[\d,]*) live bount(?:y|ies), (\$[\d,.]+) to share/);
  compare({
    surface,
    field: 'Board ledger · live count',
    dom: ledgerMatch?.[1] ?? '(no live count in the ledger)',
    api: count(items.length),
    ok: ledgerMatch ? Number(ledgerMatch[1].replace(/,/g, '')) === items.length : false,
    reason: 'the number of items the board answered with',
  });
  compare({
    surface,
    field: 'Board ledger · pot to share',
    dom: ledgerMatch?.[2] ?? '(no pot in the ledger)',
    api: money(sumPot),
    ok: ledgerMatch ? close(Number(ledgerMatch[2].replace(/[^0-9.]/g, '')), sumPot) : false,
    reason: 'the same pot total as the Live pot figure',
  });

  // The fee line under the pot figure: "<n> bounties charge a fee · $<fees> in fees so far".
  const feeStat = dom.stats.find((s) => s.k === 'Live pot')?.s ?? '';
  const feeMatch = feeStat.match(/(\d[\d,]*) bount(?:y|ies) (?:charges|charge) a fee · (\$[\d,.]+) in fees so far/);
  compare({
    surface,
    field: 'Fees · bounties charging a fee',
    dom: feeMatch?.[1] ?? '(no fee count in the line)',
    api: String(feeCharged),
    ok: feeMatch ? Number(feeMatch[1].replace(/,/g, '')) === feeCharged : false,
    reason: 'the bounties whose entryFeeUsd is above zero',
  });
  compare({
    surface,
    field: 'Fees paid so far',
    dom: feeMatch?.[2] ?? '(no fee sum in the line)',
    api: money(sumFees),
    ok: feeMatch ? close(Number(feeMatch[2].replace(/[^0-9.]/g, '')), sumFees) : false,
    reason: 'the sum of each open bounty\'s entryFeesUsd',
  });

  // The board's "Next deadline": the soonest deadline ahead of now, and its time left.
  const ahead = items.filter((b) => b.deadline).sort((a, b) => new Date(a.deadline) - new Date(b.deadline))[0];
  const nextStat = dom.stats.find((s) => s.k === 'Next deadline');
  compare({
    surface,
    field: 'Next deadline · time left',
    dom: nextStat?.v ?? '',
    api: ahead ? (timeLeftParts(ahead.deadline, now).closed ? 'closed' : (() => {
      const p = timeLeftParts(ahead.deadline, now);
      return p.days !== undefined ? `${p.days}d ${p.hours}h` : p.hours !== undefined ? `${p.hours}h ${p.minutes}m` : `${p.minutes}m`;
    })()) : '—',
    ok: ahead ? timeLeftMatches(nextStat?.v, ahead.deadline, now) : nextStat?.v === '—',
    reason: `the soonest deadline on the board (${ahead?.slug ?? 'none'}) counted from now`,
  });
  compare({
    surface,
    field: 'Next deadline · bounty named',
    dom: nextStat?.s ?? '',
    api: ahead?.title ?? '',
    ok: Boolean(ahead) && String(nextStat?.s ?? '').startsWith(ahead.title),
    reason: 'the bounty holding the soonest deadline',
  });

  // Each row: the bounty it names, its pot, its fee, its time left and its entries.
  const bySlug = new Map(items.map((b) => [`#/bounty/${b.slug}`, b]));
  compare({
    surface,
    field: 'Rows shown',
    dom: dom.rows.length,
    api: items.length,
    ok: dom.rows.length === items.length,
    reason: 'one row per open bounty, the default sort being closing soonest',
  });
  for (const row of dom.rows) {
    const b = bySlug.get(row.href);
    const name = row.title.slice(0, 34) || row.href;
    if (!b) {
      compare({ surface, field: `row "${name}" · bounty`, dom: row.href, api: 'no such slug', ok: false, reason: 'the row links to a slug the board does not carry' });
      continue;
    }
    compare({
      surface,
      field: `row "${name}" · title`,
      dom: row.title,
      api: b.title,
      ok: row.title === b.title,
      reason: 'the bounty\'s own title',
    });
    const potCell = row.cells.Pot ?? '';
    compare({
      surface,
      field: `row "${name}" · pot`,
      dom: potCell,
      api: money(potOf(b)),
      ok: close(Number(potCell.replace(/[^0-9.]/g, '')), potOf(b)),
      reason: `potUsd for ${b.slug}`,
    });
    const feeCell = row.cells['Entry fee'] ?? '';
    compare({
      surface,
      field: `row "${name}" · entry fee`,
      dom: feeCell,
      api: hasFee(b) ? money(feeOf(b)) : 'None',
      ok: hasFee(b) ? close(Number(feeCell.replace(/[^0-9.]/g, '')), feeOf(b)) : feeCell === 'None',
      reason: `entryFeeUsd for ${b.slug}`,
    });
    const leftCell = row.cells.Closes ?? '';
    compare({
      surface,
      field: `row "${name}" · time left`,
      dom: leftCell,
      api: `${shortDate(b.deadline)} · ${timeLeftParts(b.deadline, now).closed ? 'closed' : 'ahead'}`,
      ok: leftCell.startsWith(shortDate(b.deadline)) && timeLeftMatches(leftCell.split('·')[1], b.deadline, now),
      reason: 'the deadline\'s UTC day and the distance to it from now',
    });
    const entriesKey = Object.keys(row.cells).find((k) => /^entry$|^entries$/.test(k)) ?? '';
    compare({
      surface,
      field: `row "${name}" · entries`,
      dom: row.cells[entriesKey] ?? '',
      api: count(b.submissionCount ?? 0),
      ok: Number(String(row.cells[entriesKey] ?? '').replace(/[^0-9.]/g, '')) === Number(b.submissionCount ?? 0),
      reason: `submissionCount for ${b.slug}`,
    });
  }
}

// ---------------------------------------------------------------- #/bounty/<slug> — one bounty

await ready(page, ROUTES.bounty);
{
  const surface = 'bounty';
  const dom = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent?.trim() ?? '',
    lede: document.querySelector('.lede')?.textContent?.trim() ?? '',
    figures: [...document.querySelectorAll('.figure')].map((n) => ({
      k: n.querySelector('.figure__k')?.textContent?.trim() ?? '',
      v: n.querySelector('.figure__v')?.textContent?.trim() ?? '',
      s: n.querySelector('.figure__s')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    })),
    facts: Object.fromEntries(
      [...document.querySelectorAll('.fact')].map((n) => [
        n.querySelector('dt')?.textContent?.trim() ?? '',
        n.querySelector('dd')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      ]),
    ),
    rewardsRows: [...document.querySelectorAll('.table--rewards tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()),
    ),
    rewardsPill: document.querySelector('#rewards .pill')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }));
  measured.bounty = dom;
  const b = await apiGet(`/competitions/${SLUG}`);
  const now = Date.now();
  const fig = (k) => dom.figures.find((f) => f.k.toLowerCase().startsWith(k.toLowerCase()));
  const expectedPot = potOf(b);

  compare({ surface, field: 'Title', dom: dom.title, api: b.title, ok: dom.title === b.title, reason: 'the bounty\'s title' });
  compare({
    surface,
    field: 'Summary',
    dom: dom.lede,
    api: b.summary ?? '',
    ok: dom.lede === String(b.summary ?? '').trim(),
    reason: 'the bounty\'s summary',
  });

  compare({
    surface,
    field: 'Live pot (figure)',
    dom: fig('live pot')?.v ?? '',
    api: money(expectedPot),
    ok: close(Number(String(fig('live pot')?.v ?? '').replace(/[^0-9.]/g, '')), expectedPot),
    reason: 'potUsd, the reward plus the fees paid into it',
  });
  compare({
    surface,
    field: 'Live pot (details)',
    dom: dom.facts['Live pot'] ?? '',
    api: money(expectedPot),
    ok: close(Number(String(dom.facts['Live pot'] ?? '').replace(/[^0-9.]/g, '')), expectedPot),
    reason: 'the same potUsd as the figure above',
  });
  compare({
    surface,
    field: 'Entry fee (figure)',
    dom: fig('live pot')?.s?.match(/(\$[\d,.]+) entry fee/)?.[1] ?? '',
    api: hasFee(b) ? money(feeOf(b)) : 'No entry fee',
    ok: hasFee(b)
      ? close(Number(String(fig('live pot')?.s?.match(/(\$[\d,.]+) entry fee/)?.[1] ?? '').replace(/[^0-9.]/g, '')), feeOf(b))
      : Boolean(fig('live pot')?.s?.includes('No entry fee')),
    reason: 'entryFeeUsd',
  });
  compare({
    surface,
    field: 'Entry fee (details)',
    dom: dom.facts['Entry fee'] ?? '',
    api: hasFee(b) ? money(feeOf(b)) : 'None',
    ok: hasFee(b) ? close(Number(String(dom.facts['Entry fee'] ?? '').replace(/[^0-9.]/g, '')), feeOf(b)) : dom.facts['Entry fee'] === 'None',
    reason: 'entryFeeUsd',
  });
  compare({
    surface,
    field: 'Fees paid in (details)',
    dom: dom.facts['Fees paid in'] ?? '',
    api: Number(b.entryFeesUsd) > 0 ? money(b.entryFeesUsd) : '—',
    ok: Number(b.entryFeesUsd) > 0
      ? close(Number(String(dom.facts['Fees paid in'] ?? '').replace(/[^0-9.]/g, '')), Number(b.entryFeesUsd))
      : dom.facts['Fees paid in'] === '—',
    reason: 'entryFeesUsd',
  });

  const entryFigure = dom.figures.find((f) => /^Entr(?:y|ies)$/i.test(f.k));
  compare({
    surface,
    field: 'Entries (figure)',
    dom: entryFigure?.v ?? '',
    api: count(b.submissionCount ?? 0),
    ok: Number(String(entryFigure?.v ?? '').replace(/[^0-9.]/g, '')) === Number(b.submissionCount ?? 0),
    reason: 'submissionCount',
  });
  compare({
    surface,
    field: 'Entries (details)',
    dom: dom.facts.Entries ?? '',
    api: count(b.submissionCount ?? 0),
    ok: Number(String(dom.facts.Entries ?? '').replace(/[^0-9.]/g, '')) === Number(b.submissionCount ?? 0),
    reason: 'submissionCount',
  });

  compare({
    surface,
    field: 'Opened',
    dom: dom.facts.Opened ?? '',
    api: shortDate(b.publishedAt),
    ok: dom.facts.Opened === shortDate(b.publishedAt),
    reason: 'publishedAt, as its UTC day',
  });
  const closes = dom.facts.Closes ?? '';
  compare({
    surface,
    field: 'Closes',
    dom: closes,
    api: `${shortDate(b.deadline)} · ${timeLeftParts(b.deadline, now).closed ? 'closed' : 'ahead'}`,
    ok: closes.startsWith(shortDate(b.deadline)) && timeLeftMatches(closes.split('·')[1]?.replace(/left$/, ''), b.deadline, now),
    reason: 'the deadline\'s UTC day and the distance to it',
  });
  compare({
    surface,
    field: 'Harness',
    dom: dom.facts.Harness ?? '',
    api: b.harnessKind ?? '—',
    ok: dom.facts.Harness === (b.harnessKind ?? '—'),
    reason: 'harnessKind',
  });

  // The rewards table: every place's base, its fee share and its total, against rewardsNow.
  const rewardsNow = Array.isArray(b.rewardsNow) ? [...b.rewardsNow].sort((x, y) => x.place - y.place) : [];
  const placedFigure = dom.figures.find((f) => /^Places paid$/i.test(f.k));
  compare({
    surface,
    field: 'Places paid',
    dom: placedFigure?.v ?? '',
    api: count(rewardsNow.length),
    ok: Number(String(placedFigure?.v ?? '').replace(/[^0-9.]/g, '')) === rewardsNow.length,
    reason: 'the places rewardsNow pays',
  });
  compare({
    surface,
    field: 'Rewards table · rows',
    dom: dom.rewardsRows.length,
    api: rewardsNow.length,
    ok: dom.rewardsRows.length === rewardsNow.length,
    reason: 'one row per paid place',
  });
  const sumAmounts = rewardsNow.reduce((n, r) => n + Number(r.amountUsd), 0);
  compare({
    surface,
    field: 'Rewards table · sum of totals',
    dom: money(dom.rewardsRows.reduce((n, r) => n + Number(String(r[3] ?? '').replace(/[^0-9.]/g, '')), 0)),
    api: money(expectedPot),
    ok: close(dom.rewardsRows.reduce((n, r) => n + Number(String(r[3] ?? '').replace(/[^0-9.]/g, '')), 0), expectedPot),
    reason: 'the table\'s totals must add up to potUsd (rewardsNow sums to the pot)',
  });
  for (const r of rewardsNow) {
    const row = dom.rewardsRows.find((cells) => Number(cells[0]) === Number(r.place));
    if (!row) {
      compare({ surface, field: `place ${r.place}`, dom: 'no row', api: money(r.amountUsd), ok: false, reason: 'rewardsNow pays a place the table does not show' });
      continue;
    }
    compare({ surface, field: `place ${r.place} · reward`, dom: row[1], api: money(r.baseUsd), ok: close(Number(String(row[1]).replace(/[^0-9.]/g, '')), Number(r.baseUsd)), reason: 'baseUsd' });
    compare({ surface, field: `place ${r.place} · fees`, dom: row[2], api: money(r.feeShareUsd), ok: close(Number(String(row[2]).replace(/[^0-9.]/g, '')), Number(r.feeShareUsd)), reason: 'feeShareUsd' });
    compare({ surface, field: `place ${r.place} · now`, dom: row[3], api: money(r.amountUsd), ok: close(Number(String(row[3]).replace(/[^0-9.]/g, '')), Number(r.amountUsd)), reason: 'amountUsd' });
  }
  skip({
    surface,
    field: 'Rewards pill (pot across n places)',
    dom: dom.rewardsPill,
    why: `an aggregate the API does not state: it repeats potUsd, which the Live pot units already compare, and its place count repeats Places paid`,
  });
  skip({
    surface,
    field: 'Judging criteria list',
    dom: `${await page.$$eval('.rules li', (n) => n.length)} items`,
    why: 'prose the API carries in resolution.criteria but which no numeric field states, so there is no value to compare',
  });
}

// ---------------------------------------------------------------- #/bounty/<slug>/leaderboard — the standings

await ready(page, ROUTES.leaderboard);
{
  const surface = 'leaderboard';
  const dom = await page.evaluate(() => ({
    head: [...document.querySelectorAll('.table--lb thead th')].map((th) =>
      [...th.childNodes].filter((n) => !(n.nodeType === 1 && n.classList?.contains('th-unit'))).map((n) => n.textContent.trim()).join(' ').trim(),
    ),
    rows: [...document.querySelectorAll('.table--lb tbody tr')].map((tr) => ({
      place: tr.querySelector('.place')?.textContent?.trim() ?? '',
      entry: tr.querySelector('.entry__text')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      href: tr.querySelector('a.entry')?.getAttribute('href') ?? '',
      nums: [...tr.querySelectorAll('.col-num')].map((td) => td.textContent.trim()),
      slim: tr.classList.contains('is-slim'),
    })),
    pager: document.querySelector('.pager__at')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    lede: document.querySelector('.lede')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }));
  measured.leaderboard = dom;
  const d = await apiGet(`/competitions/${SLUG}/leaderboard?rows=first`);
  const columns = Array.isArray(d.columns) ? d.columns : [];
  const whole = Array.isArray(d.entries) ? d.entries : [];
  const rest = Array.isArray(d.rest) ? d.rest : [];
  const total = whole.length + rest.length;

  compare({
    surface,
    field: 'Document title',
    dom: await page.title(),
    api: `Leaderboard · ${d.competition?.title} · FarmOS`,
    ok: (await page.title()) === `Leaderboard · ${d.competition?.title} · FarmOS`,
    reason: 'the bounty\'s own title, as the page\'s document title',
  });
  compare({
    surface,
    field: 'Entries on the board (lede)',
    dom: dom.lede.match(/(\d[\d,]*) entries on the board/)?.[1] ?? dom.lede,
    api: count(total),
    ok: Number(String(dom.lede.match(/(\d[\d,]*) entries on the board/)?.[1] ?? '').replace(/,/g, '')) === total,
    reason: 'the entries and rest rows the API sent',
  });
  compare({
    surface,
    field: 'Page of rows',
    dom: dom.pager,
    api: `Page 1 of ${Math.ceil(total / 20)} · rows 1–${Math.min(total, 20)} of ${total}`,
    ok: dom.pager.replace(/\s+/g, ' ').trim() === `Page 1 of ${Math.ceil(total / 20)} · rows 1–${Math.min(total, 20)} of ${total}`,
    reason: 'twenty rows to a page, from the rows the API sent',
  });
  compare({
    surface,
    field: 'Column headings',
    dom: dom.head.slice(2, -1).join(' | '),
    api: columns.map((c) => c.title ?? c.key).join(' | '),
    ok: dom.head.slice(2, -1).join(' | ') === columns.map((c) => c.title ?? c.key).join(' | '),
    reason: 'the column titles the API names',
  });

  // Each leaderboard row's metric values: the ten whole rows are fully comparable; the slim rows carry only their
  // standing score, so only that column is compared on them.
  const rowsByRank = new Map();
  for (const e of whole) rowsByRank.set(e.rank, { row: e, whole: true });
  for (const r of rest) if (!rowsByRank.has(r.rank)) rowsByRank.set(r.rank, { row: r, whole: false });
  compare({
    surface,
    field: 'Rows rendered',
    dom: dom.rows.length,
    api: Math.min(total, 20),
    ok: dom.rows.length === Math.min(total, 20),
    reason: 'the first page holds twenty',
  });
  for (const shown of dom.rows) {
    const rank = Number(shown.place);
    const found = rowsByRank.get(rank);
    const label = `row ${rank}`;
    if (!found) {
      compare({ surface, field: `${label} · place`, dom: shown.place, api: 'not ranked', ok: false, reason: 'a row the API does not rank' });
      continue;
    }
    const { row, whole: isWhole } = found;
    compare({
      surface,
      field: `${label} · handle`,
      dom: shown.href.replace(/^#\/u\//, ''),
      api: row.handle,
      ok: shown.href === `#/u/${encodeURIComponent(row.handle)}`,
      reason: 'the entry\'s handle',
    });
    compare({
      surface,
      field: `${label} · entry title`,
      dom: shown.entry.replace(/^@\S+\s*/, '').replace(/\s*(house|baseline)(, (house|baseline))?$/, '').trim(),
      api: String(row.title ?? row.handle),
      ok: shown.entry.startsWith(String(row.title ?? row.handle)),
      reason: 'the submission\'s title',
    });
    const primaryKey = columns[0]?.key ?? 'judge';
    columns.forEach((column, i) => {
      const value = isWhole ? row.values?.[column.key] : primaryKey === column.key ? row.value : undefined;
      const display = isWhole ? row.display?.[column.key] : primaryKey === column.key ? row.display : undefined;
      const shownValue = shown.nums[i] ?? '';
      if (value === null || value === undefined || value === '') {
        compare({
          surface,
          field: `${label} · ${column.title}`,
          dom: shownValue,
          api: '—',
          ok: shownValue === '—',
          reason: `the API states no value for ${column.key} on this row, so the page must show a dash`,
        });
        return;
      }
      const expected = typeof display === 'string' && display !== ''
        ? display
        : unitOf(column) === 'bytes'
          ? `${integer(value)} B`
          : integer(value);
      compare({
        surface,
        field: `${label} · ${column.title}`,
        dom: shownValue,
        api: expected,
        ok: shownValue === expected,
        reason: isWhole ? `values.${column.key} as the API displays it` : `the slim row's own ${column.key} display`,
      });
    });
    if (!isWhole) {
      skip({
        surface,
        field: `${label} · interval and secondary columns`,
        dom: shown.nums.slice(1).join(' '),
        why: `rows past the tenth arrive slim: the API sends only their standing score, so the other columns cannot be compared on this row`,
      });
    }
  }
}

// ---------------------------------------------------------------- #/u/<handle> — a profile

await ready(page, ROUTES.profile);
{
  const surface = 'profile';
  const dom = await page.evaluate(() => ({
    name: document.querySelector('.title--profile')?.textContent?.trim() ?? '',
    handle: document.querySelector('.profile-handle')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    joined: document.querySelector('.profile-handle .muted')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    bio: document.querySelector('.lede')?.textContent?.trim() ?? '',
    stats: [...document.querySelectorAll('.stat')].map((n) => ({
      k: n.querySelector('.stat__k')?.textContent?.trim() ?? '',
      v: n.querySelector('.stat__v')?.textContent?.trim() ?? '',
      s: n.querySelector('.stat__s')?.textContent?.trim() ?? '',
    })),
    entriesPill: document.querySelector('.card .pill')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    entries: [...document.querySelectorAll('.entry-row')].map((row) => ({
      title: row.querySelector('.entry-row__title')?.textContent?.trim() ?? '',
      meta: row.querySelector('.entry-row__meta')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      href: row.querySelector('a')?.getAttribute('href') ?? '',
      cells: Object.fromEntries(
        [...row.querySelectorAll('.entry-row__cell')].map((c) => [
          c.querySelector('.row__k')?.textContent?.trim() ?? '',
          [...c.childNodes].filter((n) => !(n.nodeType === 1 && n.classList?.contains('row__k'))).map((n) => n.textContent.trim()).join(' ').trim(),
        ]),
      ),
    })),
  }));
  measured.profile = dom;
  const p = await apiGet(`/profiles/${HANDLE}`);
  const r = p.record ?? {};
  const stat = (k) => dom.stats.find((s) => s.k === k);
  const solutions = Array.isArray(p.solutions) ? p.solutions : [];

  compare({ surface, field: 'Name', dom: dom.name, api: p.display_name || p.handle, ok: dom.name === (p.display_name || p.handle), reason: 'display_name, else the handle' });
  compare({ surface, field: 'Handle', dom: dom.handle.split('·')[0].trim(), api: `@${p.handle}`, ok: dom.handle.startsWith(`@${p.handle}`), reason: 'the handle the URL names' });
  compare({ surface, field: 'Joined', dom: dom.joined, api: `joined ${shortDate(p.joined_at)}`, ok: dom.joined === `· joined ${shortDate(p.joined_at)}`, reason: 'joined_at, as its UTC day' });

  compare({ surface, field: 'Record · entered', dom: stat('Entered')?.v ?? '', api: count(r.competitions_entered), ok: stat('Entered')?.v === count(r.competitions_entered), reason: 'record.competitions_entered' });
  compare({ surface, field: 'Record · won', dom: stat('Won')?.v ?? '', api: count(r.competitions_won), ok: stat('Won')?.v === count(r.competitions_won), reason: 'record.competitions_won' });
  compare({ surface, field: 'Record · placed', dom: stat('Placed')?.v ?? '', api: count(r.competitions_placed), ok: stat('Placed')?.v === count(r.competitions_placed), reason: 'record.competitions_placed' });
  compare({ surface, field: 'Record · prize money', dom: stat('Prize money')?.v ?? '', api: money(r.prize_usd), ok: close(Number(String(stat('Prize money')?.v ?? '').replace(/[^0-9.]/g, '')), Number(r.prize_usd)), reason: 'record.prize_usd' });
  compare({
    surface,
    field: 'Record · best place',
    dom: stat('Prize money')?.s ?? '',
    api: r.best_placement ? `best place ${r.best_placement}` : 'none paid yet',
    ok: stat('Prize money')?.s === (r.best_placement ? `best place ${r.best_placement}` : 'none paid yet'),
    reason: 'record.best_placement',
  });

  compare({ surface, field: 'Entries · count in the heading', dom: dom.entriesPill, api: `${count(solutions.length)} entries`, ok: dom.entriesPill === `${count(solutions.length)} entries`, reason: 'the solutions the API sent' });
  compare({ surface, field: 'Entries · rows shown', dom: dom.entries.length, api: Math.min(12, solutions.length), ok: dom.entries.length === Math.min(12, solutions.length), reason: 'twelve entries, then a button for the rest' });
  solutions.slice(0, 12).forEach((s, i) => {
    const shown = dom.entries[i];
    if (!shown) return;
    compare({ surface, field: `entry ${i + 1} · title`, dom: shown.title, api: s.title ?? 'Untitled entry', ok: shown.title === (s.title ?? 'Untitled entry'), reason: 'the submission\'s title' });
    compare({
      surface,
      field: `entry ${i + 1} · bounty`,
      dom: shown.href,
      api: `#/bounty/${encodeURIComponent(s.competition?.slug ?? '')}`,
      ok: shown.href === `#/bounty/${encodeURIComponent(s.competition?.slug ?? '')}`,
      reason: 'the competition it was entered in',
    });
    compare({
      surface,
      field: `entry ${i + 1} · entered`,
      dom: shown.cells.Entered ?? '',
      api: shortDate(s.entered_at),
      ok: shown.cells.Entered === shortDate(s.entered_at),
      reason: 'entered_at, as its UTC day',
    });
    const place = typeof s.placement === 'number' ? `#${s.placement}` : '—';
    compare({
      surface,
      field: `entry ${i + 1} · place`,
      dom: shown.cells.Place ?? '',
      api: place,
      ok: (shown.cells.Place ?? '').startsWith(place),
      reason: 'submission.placement',
    });
    const score = s.score?.display ?? '—';
    const column = s.score?.column?.title ?? 'Score';
    compare({
      surface,
      field: `entry ${i + 1} · ${column}`,
      dom: shown.cells[column] ?? shown.cells.Score ?? '',
      api: score,
      ok: (shown.cells[column] ?? shown.cells.Score ?? '') === score,
      reason: 'submission.score.display',
    });
  });

  if (Array.isArray(p.payouts) && p.payouts.length > 0) {
    const dom0 = await page.$$eval('.payouts li', (nodes) => nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
    compare({ surface, field: 'Prizes paid · rows', dom: dom0.length, api: p.payouts.length, ok: dom0.length === p.payouts.length, reason: 'one row per payout' });
    p.payouts.forEach((pay, i) => {
      compare({ surface, field: `payout ${i + 1} · amount`, dom: dom0[i] ?? '', api: money(pay.amount_usd), ok: String(dom0[i] ?? '').startsWith(money(pay.amount_usd)), reason: 'payout.amount_usd' });
      compare({ surface, field: `payout ${i + 1} · place`, dom: dom0[i] ?? '', api: `place ${pay.place}`, ok: String(dom0[i] ?? '').includes(`for place ${pay.place}`), reason: 'payout.place' });
    });
  }
}

// ---------------------------------------------------------------- the states, the overflow, the failure path

const states = [];

// Every surface paints a loading state before its data, and is ready after it: read off what the DOM says.
{
  const fresh = await newPage();
  let sawLoading = false;
  let sawReady = false;
  for (const route of [ROUTES.board, ROUTES.bounty, ROUTES.leaderboard, ROUTES.profile]) {
    await fresh.page.goto(base + route, { waitUntil: 'commit' });
    // The skeleton is painted synchronously on load and carries aria-busy; poll for it before the data lands.
    const busy = await fresh.page
      .waitForFunction(() => Boolean(document.querySelector('[aria-busy="true"], .sk')), null, { timeout: 15_000, polling: 10 })
      .then(() => true)
      .catch(() => false);
    if (busy) sawLoading = true;
    const readied = await fresh.page
      .waitForFunction(() => window.__shotReady === true && !document.querySelector('[aria-busy="true"]'), null, { timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    if (readied) sawReady = true;
    states.push({ route, loading: busy, ready: readied });
  }
  if (!sawLoading) problems.push('no surface ever showed a loading state before its data');
  if (!sawReady) problems.push('a surface never became ready');
  await fresh.ctx.close();
}

// Horizontal overflow at three widths, on every surface, in both themes.
const overflows = [];
for (const colorScheme of ['dark', 'light']) {
  for (const width of [360, 768, 1280]) {
    const size = { width, height: 800 };
    const c = await browser.newContext({ viewport: size, colorScheme });
    const p = await c.newPage();
    p.on('pageerror', (e) => problems.push(`page error on ${page.url()}: ${e.message}`));
    for (const route of [ROUTES.board, ROUTES.bounty, ROUTES.leaderboard, ROUTES.profile]) {
      await p.goto(base + route, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 45_000 });
      const overflow = await p.evaluate(() => {
        const wide = [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed')
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
        return { px: document.documentElement.scrollWidth - window.innerWidth, wide };
      });
      overflows.push({ scheme: colorScheme, width, route, ...overflow });
      if (overflow.px > 0) problems.push(`horizontal overflow of ${overflow.px}px on ${route} at ${width}px (${colorScheme}): ${overflow.wide.join(', ')}`);
    }
    await c.close();
  }
}

// The failure path: a route the API has nothing for shows an error state and a button that really asks again.
const failure = { errorState: false, retry: false, retried: false, attempts: 0 };
{
  const f = await newPage();
  f.page.on('response', (r) => {
    if (r.url().includes('/competitions/makefun-verify-')) failure.attempts += 1;
  });
  await ready(f.page, MISSING);
  const shown = await f.page.evaluate(() => ({
    alert: Boolean(document.querySelector('[role="alert"]')),
    title: document.querySelector('[role="alert"] h1')?.textContent?.trim() ?? '',
    status: document.querySelector('.page.narrow .fine')?.textContent?.trim() ?? '',
    retry: Boolean(document.querySelector('[data-retry]')),
    busy: document.querySelector('[aria-busy="true"]') !== null,
    error: window.__error,
  }));
  failure.errorState = shown.alert;
  failure.retry = shown.retry;
  failure.status = shown.status;
  if (shown.retry) {
    // A retry that retries goes back to the API rather than repainting the stale failure from memory. The wait is
    // armed before the click, and it watches the request rather than the response: the 404 being retried has no
    // body, and the point is that the API is asked again, not that it answers differently.
    const askedAgain = f.page
      .waitForRequest((r) => r.url().includes('/competitions/makefun-verify-'), { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    // The button is disabled and relabelled on press, so this waits for the attribute rather than clickability.
    await f.page.click('[data-retry]', { noWaitAfter: true });
    failure.retried = await askedAgain;
    await f.page
      .waitForFunction(() => window.__shotReady === true && Boolean(document.querySelector('[data-retry]')), null, { timeout: 20_000 })
      .catch(() => {});
  }
  if (!shown.alert) problems.push('a missing bounty did not show an error state');
  if (!shown.retry) problems.push('the error state offered no retry');
  if (!failure.retried) problems.push('the retry button did not ask the API again');
  await f.ctx.close();
}

// ---------------------------------------------------------------- the screenshots

const shots = [];
if (SHOTS) {
  const plan = JSON.parse(readFileSync(join(repo, 'shots.json'), 'utf8'));
  const dir = join(repo, 'screenshots');
  mkdirSync(dir, { recursive: true });
  const c = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
  const p = await c.newPage();
  p.on('pageerror', (e) => problems.push(`page error while shooting ${p.url()}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error while shooting ${p.url()}: ${m.text()}`);
  });
  for (const shot of plan) {
    await p.goto(base + shot.path, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 45_000 });
    // Let the cross-origin avatars and the web font settle so the sheet is fully painted.
    await p.evaluate(async () => {
      await document.fonts.ready;
      const images = [...document.images];
      await Promise.all(images.map((img) => (img.complete ? null : new Promise((r) => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      }))));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const theme = await p.evaluate(() => document.documentElement.dataset.theme);
    if (theme !== 'dark') problems.push(`${shot.file}: shot taken in the ${theme} theme, not dark`);
    const file = join(dir, shot.file);
    await p.screenshot({ path: file, type: shot.file.endsWith('.png') ? 'png' : 'jpeg', ...(shot.file.endsWith('.png') ? {} : { quality: 86 }) });
    shots.push({ file: shot.file, path: shot.path, viewport: shot.viewport, bytes: statSync(file).size, theme });
  }
  await c.close();
}

await mainCtx.close();
await browser.close();
server.close();

// ---------------------------------------------------------------- the report

const pad = (s, n) => String(s).padEnd(n);
const rows = comparisons.map((c) => [
  pad(c.ok ? 'match' : 'MISMATCH', 9),
  pad(c.surface, 12),
  pad(c.field.length > 46 ? `${c.field.slice(0, 45)}…` : c.field, 47),
  pad(c.dom.length > 30 ? `${c.dom.slice(0, 29)}…` : c.dom, 31),
  pad(c.api.length > 30 ? `${c.api.slice(0, 29)}…` : c.api, 31),
  c.ok ? '' : c.reason,
]);
const header = ['RESULT', 'SURFACE', 'FIELD', 'DOM', 'API', 'WHY A MISMATCH'];
console.log('');
console.log('FIELD BY FIELD');
for (const r of [header, null, ...rows]) {
  if (r === null) {
    console.log(`${'-'.repeat(9)} ${'-'.repeat(12)} ${'-'.repeat(47)} ${'-'.repeat(31)} ${'-'.repeat(31)} ${'-'.repeat(40)}`);
    continue;
  }
  console.log(r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd([9, 12, 47, 31, 31][i]))).join(' '));
}

if (excluded.length) {
  console.log('\nNOT COMPARED (out of the numerator and the denominator)');
  for (const e of excluded) console.log(`  ${e.surface} · ${e.field} — ${e.why}${e.dom ? ` [page showed ${JSON.stringify(e.dom.slice(0, 60))}]` : ''}`);
}

console.log('\nTHE STATES');
for (const s of states) console.log(`  ${pad(s.route, 46)} loading state ${s.loading ? 'yes' : 'NO'} · ready ${s.ready ? 'yes' : 'NO'}`);
const worstOverflow = Math.max(0, ...overflows.map((o) => o.px));
console.log(`  overflow measured at 360/768/1280 in both themes: ${overflows.length} surfaces read, worst ${worstOverflow}px`);
console.log(`  forced 404: error state ${failure.errorState ? 'yes' : 'NO'} (${failure.status || 'no status line'}) · retry offered ${failure.retry ? 'yes' : 'NO'} · retry went back to the API ${failure.retried ? 'yes' : 'NO'} (${failure.attempts} API answer${failure.attempts === 1 ? '' : 's'} for the route)`);

for (const [name, dom] of Object.entries(measured)) {
  if (name === 'board') {
    const s = dom.stats.map((x) => `${x.k} ${x.v}`).join(' · ');
    const nowhere = overflows.filter((o) => o.px > 0).length;
    console.log(`\nFIRST LOAD · Totals (board): ${s}`);
    console.log(`PARITY · worst horizontal overflow ${worstOverflow}px across ${overflows.length} reads (${nowhere} with any)`);
  }
}

if (SHOTS) {
  console.log('\nSCREENSHOTS');
  for (const s of shots) console.log(`  ${pad(s.file, 14)} ${pad(String(s.bytes), 7)} bytes  ${s.path}  ${s.viewport.width}x${s.viewport.height}  ${s.theme}`);
  writeFileSync(join(repo, 'shots.json'), `${JSON.stringify(shots.map(({ file, path, viewport }) => ({ file, path, viewport })), null, 2)}\n`);
}

if (problems.length) {
  console.log('\nFAILURES OUTSIDE THE FIELD TABLE');
  for (const p of problems.filter((p) => !comparisons.some((c) => !c.ok && p.includes(c.field)))) console.log(`  ${p}`);
}

const matched = comparisons.filter((c) => c.ok).length;
const compared = comparisons.length;
const percent = compared === 0 ? 0 : Math.round((matched / compared) * 10000) / 100;
const mismatchCount = compared - matched;
console.log('');
if (mismatchCount) {
  console.log('MISMATCHES');
  for (const c of comparisons.filter((x) => !x.ok)) console.log(`  ${c.surface} · ${c.field}: DOM ${JSON.stringify(c.dom)} vs API ${JSON.stringify(c.api)} — ${c.reason}`);
  console.log('');
}
console.log(`ACCURACY: ${matched}/${compared} = ${percent}%`);
const ok = percent >= THRESHOLD && problems.length === 0;
if (!ok && percent >= THRESHOLD) console.log(`FAILED: the fields agree but ${problems.length} other contract check(s) failed`);
if (!ok && percent < THRESHOLD) console.log(`FAILED: ${percent}% is below the ${THRESHOLD}% contract`);
process.exit(ok ? 0 : 1);
