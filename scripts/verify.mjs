#!/usr/bin/env node
// scripts/verify.mjs — the accuracy contract for app/.
//
// Serves app/ over real HTTP, drives real Chromium at 1280x800, waits for each route to reach
// window.__shotReady === true, reads what the page actually renders from the DOM, fetches the same
// resources straight from https://make.fun/api, computes the expected value for every field
// independently, and compares them field by field.
//
//   node scripts/verify.mjs            compare, print the table and the ACCURACY line, exit 1 below 95%
//   node scripts/verify.mjs --shots    the same, and write the three screenshots + shots.json
//
// Node 22, standard library plus the Playwright installed beside this repository's parent
// (C:/Users/friok/makefun/node_modules/playwright). Playwright is loaded dynamically; the comparison
// itself needs nothing but fetch.
//
// Honesty rules this file keeps: no expected value is ever normalised toward what the page printed;
// a comparison that cannot be made without guessing is reported in the EXCLUDED list with its reason
// and left out of both the numerator and the denominator; every API answer is fetched, never invented.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const API = 'https://make.fun/api';
const BOUNTY = 'makefun-frontend-01';
const LEADERBOARD = 'markdown-render-speed-02';
const THRESHOLD = 95;
const WIDTH = 1280;
const HEIGHT = 800;
const SHOTS = process.argv.includes('--shots');

// ------------------------------------------------------------------ failures the contract asserts

const hardFailures = [];
const fail = (what, why) => hardFailures.push(`${what}: ${why}`);

// ------------------------------------------------------------------ expected-value formatting
//
// These re-derive what a correct renderer must print. They are written from the API's own types
// (numbers vs decimal strings) independently of app/format.js, so a formatter bug cannot hide.

const fixed = (n, digits) => n.toFixed(digits);
const groups = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const digits = Number.isInteger(n) ? 0 : 2;
  return `$${groups(fixed(n, digits))}`;
};
const countOf = (v) => (Number.isFinite(Number(v)) ? groups(Number(v)) : '—');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = (v) => {
  if (typeof v === 'number') {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return Number.isInteger(v) ? groups(v) : String(v);
  }
  if (typeof v === 'string') return v; // a display string is already what the API publishes
  return v === null || v === undefined ? null : String(v);
};
const dateOf = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const dateTimeOf = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${dateOf(iso)}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
};
/** The API displays a column value itself in `display`; when it does not, values[p] === precision digits. */
const columnExpected = (column, entry) => {
  const shown = entry?.display?.[column.key];
  if (shown !== undefined && shown !== null && String(shown) !== '') return String(shown);
  const raw = entry?.values?.[column.key];
  if (raw === null || raw === undefined) return '—';
  if (typeof raw === 'string' && !Number.isFinite(Number(raw))) return raw;
  const precision = Number(column?.precision);
  return Number.isInteger(precision) && precision > 0 ? Number(raw).toFixed(precision) : groupNumber(Number(raw));
};
const groupNumber = (n) => (Number.isFinite(n) ? groups(n) : String(n));

/** Every count the title bar shows, as digits with group separators. */
const statNumber = (n) => countOf(n);

// ------------------------------------------------------------------ comparison table

const rows = [];
const excluded = [];
const notes = [];

/**
 * One compared field. `dom` is text read out of the page; `api` is what the API says must appear there.
 * `ok` is only ever computed from those two, never set by hand.
 */
function compare(surface, field, dom, api, { why, test } = {}, extras) {
  const domText = dom === null || dom === undefined ? null : String(dom).replace(/\s+/g, ' ').trim();
  const apiText = api === null || api === undefined ? null : String(api).replace(/\s+/g, ' ').trim();
  if (domText === null) {
    return rows.push({ surface, field, dom: '(missing)', api: apiText, ok: false, reason: why ?? 'the page does not render this field at all' });
  }
  if (apiText === null) {
    return excluded.push({ surface, field, dom: domText, reason: why ?? 'the API does not publish a figure to compare' });
  }
  // a URL comparison is enormous and unreadable in a table; the verdict is what matters
  const shorten = (s) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  // equality unless the caller supplies the rule that is right for a grouped field
  const ok = test ? Boolean(test(domText, apiText, extras ?? {})) : domText === apiText;
  rows.push({ surface, field, dom: shorten(domText), api: shorten(apiText), ok, reason: ok ? '' : (why ?? mismatchReason(field, domText, apiText)) });
}

/**
 * A field the API publishes that the page only has to contain, not equal: a caption that also names
 * the phase, a footer that adds the join date. It matches only when the API's own text is in the DOM.
 */
function contains(surface, field, dom, api, why) {
  compare(surface, field, dom, api, { why, test: (d, a) => a !== '' && d.includes(a) });
}

/**
 * A value the page renders as a group of places sharing one line ("$20.59 each"), or whose text is
 * derived from the API's figure rather than equal to it. `rule` is the full comparison and returns
 * { ok, note } — it is given the raw DOM text and the raw API value.
 */
function derived(surface, field, dom, api, rule, why) {
  const domText = dom === null || dom === undefined ? null : String(dom).replace(/\s+/g, ' ').trim();
  const apiText = api === null || api === undefined ? null : String(api).replace(/\s+/g, ' ').trim();
  if (domText === null || apiText === null) return compare(surface, field, dom, api, { why });
  const verdict = rule(domText, apiText) ?? { ok: false };
  const shorten = (s) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  rows.push({ surface, field, dom: shorten(domText), api: shorten(apiText), ok: Boolean(verdict.ok), reason: verdict.ok ? '' : (verdict.note ?? why ?? 'the derived value does not hold') });
}

/**
 * A claim about behaviour that has no API figure on the other side: "the skeleton gave way to the
 * board", "the retry made a second request". It has a DOM side, no API side, and is compared as a
 * predicate — never as a phrase a renderer could match by accident.
 */
function assertState(surface, field, dom, passed, whyIfFailed) {
  const domText = dom === null || dom === undefined ? '(missing)' : String(dom).replace(/\s+/g, ' ').trim();
  rows.push({ surface, field, dom: domText.length > 160 ? `${domText.slice(0, 159)}…` : domText, api: passed ? 'as asserted' : 'not as asserted', ok: Boolean(passed) && dom !== null, reason: passed && dom !== null ? '' : (whyIfFailed ?? 'the assertion does not hold') });
}

function mismatchReason(field, dom, api) {
  const num = (s) => (s && /^-?\$?[\d,]+(\.\d+)?$/.test(s) ? Number(s.replace(/[$,]/g, '')) : null);
  const d = num(dom);
  const a = num(api);
  if (d !== null && a !== null) {
    const diff = d - a;
    return `the page shows ${d} where the API says ${a} (off by ${diff > 0 ? '+' : ''}${Number(diff.toFixed(6))})`;
  }
  return `the page shows "${dom}" where the API says "${api}"`;
}const exclude = (surface, field, dom, reason) => excluded.push({ surface, field, dom: dom ?? '(missing)', reason });

// ------------------------------------------------------------------ the API, fetched directly

async function apiGet(path) {
  const res = await fetch(API + path, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok) {
    const why = Array.isArray(body?.error) ? body.error[0]?.message : null;
    throw new Error(`GET ${API}${path} answered ${res.status}${why ? ` (${why})` : ''}`);
  }
  if (body === null) throw new Error(`GET ${API}${path} answered something that is not JSON`);
  return body;
}

import { readFileSync as _unused } from 'node:fs'; // eslint-disable-line

async function apiBountiesOpen() {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ status: 'open', activity: 'times' });
    if (cursor) q.set('cursor', cursor);
    const data = await apiGet(`/competitions?${q}`);
    if (!Array.isArray(data?.items)) throw new Error('the API returned a board without items');
    items.push(...data.items);
    cursor = data.next_cursor ?? null;
    if (!cursor) break;
  }
  return items;
}

// ------------------------------------------------------------------ Playwright

const require_ = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    join(repo, '..', 'node_modules', 'playwright'),
    'C:/Users/friok/makefun/node_modules/playwright',
    'playwright',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'playwright' || existsSync(c)) return require_(c);
    } catch (err) {
      notes.push(`playwright at ${c} failed to load: ${err.message}`);
    }
  }
  throw new Error(`Playwright not found (tried ${candidates.join(', ')})`);
}

// ------------------------------------------------------------------ server

async function spawnServer() {
  const { spawn } = await import('node:child_process');
  const port = 8100 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [join(here, 'serve.mjs'), '--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/index.html`);
      if (res.ok) {
        await res.text();
        return { base, stop: () => child.kill() };
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`the static server did not start on ${base}`);
}

// ------------------------------------------------------------------ the run

async function main() {
  const { chromium } = loadPlaywright();
  const server = await spawnServer();
  const browser = await chromium.launch();

  try {
    // ---- API first: the expected numbers, then the DOM that has to agree with them
    const board = await apiBountiesOpen();
    if (board.length === 0) throw new Error('the API reports no open bounties; nothing can be compared');
    const bounty = await apiGet(`/competitions/${BOUNTY}`);
    const lbBounty = await apiGet(`/competitions/${LEADERBOARD}`);
    const leaderboard = await apiGet(`/competitions/${LEADERBOARD}/leaderboard`);

    // A real handle, read from the API: the leader is the most visible maker on the measured board.
    const profileHandle = await pickHandle(leaderboard);
    const profileJ = await apiGet(`/profiles/${encodeURIComponent(profileHandle)}`);

    // ---- page 1: the board
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const health = observe(page);

    await open(page, server.base, '#/');
    await compareBoard(page, board);

    // screenshots are of the first three surfaces, in order: board, bounty, leaderboard
    if (SHOTS) await capture(page, '1-board.jpg');
    health.check('#/');

    // ---- page 2: one bounty
    health.reset();
    await open(page, server.base, `#/bounty/${BOUNTY}`);
    await compareBounty(page, bounty);
    if (SHOTS) await capture(page, '2-bounty.jpg');
    health.check(`#/bounty/${BOUNTY}`);

    // ---- page 3: its leaderboard
    health.reset();
    await open(page, server.base, `#/bounty/${BOUNTY}/leaderboard`);
    await compareFrontendLeaderboard(page, await apiGet(`/competitions/${BOUNTY}/leaderboard`), bounty);
    health.check(`#/bounty/${BOUNTY}/leaderboard`);

    // ---- page 4: the measured leaderboard (kept off the screenshots so the three stay the requested set)
    health.reset();
    await open(page, server.base, `#/bounty/${LEADERBOARD}/leaderboard`);
    await compareLeaderboard(page, leaderboard, lbBounty);
    health.check(`#/bounty/${LEADERBOARD}/leaderboard`);

    // ---- page 5: a real profile
    health.reset();
    await open(page, server.base, `#/u/${encodeURIComponent(profileHandle)}`);
    await compareProfile(page, profileJ);
    health.check(`#/u/${profileHandle}`);

    // ---- the board again, by hash, to prove a second visit paints the same numbers (no stale rows)
    health.reset();
    await open(page, server.base, '#/');
    compare('#/ (second visit)', 'open bounties', (await page.$$eval('ul.board > li', (l) => l.length)), board.length);
    health.check('#/ (second visit)');

    // ---- assertions that are not field comparisons
    await assertLoadingTransition(browser, server.base);
    await assertForced404(page, server.base);
    await assertOverflow(browser, server.base, profileHandle);
    health.finish();

    if (SHOTS) writeShots();

    // ---- report
    report();
  } finally {
    await browser.close();
    server.stop();
  }
}

// ------------------------------------------------------------------ opening a route and waiting for it

/** Load (or hash-navigate to) a route, then wait for the app to say its data is on screen. */
async function open(page, base, hash) {
  const current = await page.evaluate(() => location.hash).catch(() => null);
  if (current !== null && current !== hash && page.url().startsWith(base)) {
    await page.evaluate(() => {
      window.__shotReady = false;
      window.__error = null;
    });
    const navigated = page.waitForFunction((h) => location.hash === h, hash, { timeout: 15000 });
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
    await navigated;
  } else {
    await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForFunction(() => window.__shotReady === true, undefined, { timeout: 45000 });
  await settle(page);
}

/** Fonts and the paint, so text measured from the DOM is the text a person would see. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

// ------------------------------------------------------------------ per-surface comparisons

const txt = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent)).catch(() => null);

/** Date.now() read inside the page: the countdown labels are computed from the browser's clock. */
const pageNow = (page) => page.evaluate(() => Date.now());

/**
 * A profile the app can open: a handle read from the API. The leaderboard's leader is the most
 * visible maker on the board, so that is the one used — fetched fresh, never assumed.
 */
async function pickHandle(leaderboard) {
  const handle = (Array.isArray(leaderboard.entries) ? leaderboard.entries : []).find((e) => e.handle)?.handle;
  if (!handle) throw new Error(`the ${LEADERBOARD} leaderboard publishes no handle to open a profile for`);
  return handle;
}

/** The frontend leaderboard carries a phase the caption should name. */
const fbPhaseCaption = (lb) => Boolean(lb.phase && (lb.phase.title ?? lb.phase.key));

async function compareBoard(page, board) {
  const S = '#/';

  // every row, keyed by the bounty it links to — the page's own href decides which bounty a row is about
  const rowsDom = await page.$$eval('ul.board > li > a.row', (anchors) =>
    anchors.map((a) => {
      const cells = [...a.querySelectorAll('.cell')];
      return {
        href: a.getAttribute('href') ?? '',
        title: a.querySelector('.rowtitle')?.textContent ?? null,
        sub: a.querySelector('.rowsub')?.textContent ?? null,
        values: cells.map((c) => c.querySelector('b')?.textContent ?? null),
        labels: cells.map((c) => c.querySelector('.lbl')?.textContent ?? null),
      };
    }),
  );

  compare(S, 'board: row count', rowsDom.length, board.length, { why: `the page lists ${rowsDom.length} bounties; the API reports ${board.length} open bounties` });
  // The board is ordered newest first by publishedAt — that is the app's stated order, and it has to be
  // stable, so it is recomputed here from the API's own timestamps and ties are broken by slug.
  const inAppOrder = [...board].sort((a, b) => new Date(b.publishedAt ?? 0) - new Date(a.publishedAt ?? 0) || String(a.slug).localeCompare(String(b.slug)));
  compare(S, 'board: row order (newest published first)', rowsDom.map((r) => r.href).join(' '), inAppOrder.map((b) => `#/bounty/${encodeURIComponent(b.slug)}`).join(' '),
    { why: 'the rows are not newest-first by publishedAt' });

  const bySlug = new Map(board.map((b) => [`#/bounty/${encodeURIComponent(b.slug)}`, b]));
  const now = await pageNow(page);
  for (const row of rowsDom) {
    const b = bySlug.get(row.href);
    const tag = b ? b.slug : row.href;
    if (!b) {
      compare(S, `${tag}: row`, row.href, null, { why: 'a row links to a bounty the API does not list as open' });
      continue;
    }
    compare(S, `${tag}: title`, row.title, b.title);
    compare(S, `${tag}: live pot`, row.values[0], money(b.potUsd ?? b.rewardAmount), {
      why: 'the "Live pot" cell must show potUsd (the reward plus entry fees paid in)',
    });
    compare(S, `${tag}: entry fee`, row.values[1], money(b.entryFeeUsd), {
      why: 'the "Entry fee" cell must show entryFeeUsd, and "—" when the API sends null (no fee)',
    });
    compare(S, `${tag}: entries`, row.values[2], countOf(b.submissionCount));
    // the deadline cell is a phrase ("10h 45m left") whose text depends on the clock, so it is not
    // compared by equality; its date half is, and the label is checked for the right preposition.
    const deadlineCell = row.labels[3] ?? '';
    const wantsOpen = b.status === 'open' && new Date(b.deadline).getTime() > now;
    const counted = row.values[3] ?? '';
    if (/^by /.test(deadlineCell) === wantsOpen) {
      compare(S, `${tag}: deadline date`, deadlineCell.replace(/^(by|on) /, ''), dateOf(b.deadline));
    } else {
      compare(S, `${tag}: deadline preposition`, deadlineCell, wantsOpen ? 'by <date>' : 'on <date>', { why: 'a bounty still taking entries says "by <date>"; a closed one says "on <date>"' });
    }
    // a bounty still taking entries must show a countdown; a closed one must say "Closed"
    const stateOk = wantsOpen ? /left$/.test(counted) : counted === 'Closed';
    assertState(S, `${tag}: time left state`, counted, stateOk, 'the cell beside the deadline must be a countdown ending in "left" while the bounty is open, and "Closed" once it is not');
  }

  await compareBoardTotals(page, board);

  // the sub line: category, sponsor, and the column the bounty is ranked by
  const subLines = rowsDom.map((row) => {
    const b = bySlug.get(row.href);
    if (!b) return null;
    const parts = [b.category ?? 'Bounty', b.sponsor?.name, b.resolution?.metric?.name].filter(Boolean);
    const dom = (row.sub ?? '').split(' · ');
    const missing = parts.filter((part) => !dom.includes(part));
    return { b, missing, expected: parts.join(' · '), dom: row.sub };
  });
  compare(S, 'board: row sub-lines (category · sponsor · measured by)', subLines.filter((s) => s && s.dom === s.expected).length, subLines.length,
    { why: 'a row sub-line does not read "category · sponsor · measured by" exactly as the API publishes them' });
}

async function compareBoardTotals(page, board) {
  const S = '#/';
  const stats = await page.$$eval('.head .stats li', (lis) => lis.map((li) => ({ num: li.querySelector('.num')?.textContent ?? null, label: li.querySelector('.lbl')?.textContent ?? null })));
  const stat = (label) => stats.find((s) => s.label === label && s.num !== null)?.num ?? null;

  const now = Date.now();
  const pot = board.reduce((n, b) => n + (Number(b.potUsd) || 0), 0);
  const received = board.reduce((n, b) => n + (Number(b.submissionCount) || 0), 0);
  const withFee = board.filter((b) => b.entryFeeUsd !== null && b.entryFeeUsd !== undefined).length;
  const taking = board.filter((b) => b.status === 'open' && new Date(b.deadline).getTime() > now).length;
  const bucket = (label) => {
    const v = stat(label);
    if (v === null) compare(S, `board stat: ${label}`, null, '', { why: `the page has no stat labelled "${label}"` });
    return v;
  };
  compare(S, 'board stat: open bounties', bucket('Open bounties'), countOf(board.length));
  compare(S, 'board stat: total live pot', bucket('Total live pot'), money(pot), { why: 'the total live pot is the sum of every open bounty\'s potUsd' });
  compare(S, 'board stat: entries received', bucket('Entries received'), countOf(received), { why: 'entries received is the sum of submissionCount over the open board' });
  compare(S, 'board stat: still taking entries', bucket('Still taking entries'), countOf(taking), { why: 'a bounty is still taking entries when its deadline has not passed (UTC)' });
  compare(S, 'board stat: with an entry fee', bucket('With an entry fee'), countOf(withFee));
}

async function compareBounty(page, b) {
  const S = `#/bounty/${b.slug}`;
  const facts = await page.$$eval('.potcard .facts > div', (divs) => {
    const out = {};
    for (const d of divs) out[d.querySelector('dt')?.textContent?.trim() ?? '?'] = d.querySelector('dd')?.textContent?.trim() ?? null;
    return out;
  });
  const pot = await page.$eval('.potcard .pot', (e) => e.textContent.trim()).catch(() => null);
  const h1 = await page.$eval('h1', (e) => e.textContent.trim()).catch(() => null);
  const now = Date.now();
  const open = b.status === 'open' && new Date(b.deadline).getTime() > now && b.acceptingSubmissions !== false;
  const metric = b.resolution?.metric ?? null;
  const baseline = b.baseline ?? null;
  const rewardsNow = Array.isArray(b.rewardsNow) ? b.rewardsNow : [];
  const rewards = Array.isArray(b.rewards) ? [] : Object.entries(b.rewards ?? {}).sort((x, y) => Number(x[0]) - Number(y[0]));
  const statusText = open ? 'Open' : String(b.status ?? 'closed');

  compare(S, 'title', h1, b.title);
  compare(S, 'live pot', pot, money(b.potUsd ?? b.rewardAmount), { why: 'the live pot is potUsd: the reward plus the entry fees paid into it' });
  compare(S, 'reward', facts.Reward, money(b.rewardAmount));
  compare(S, 'entry fee', facts['Entry fee'], b.entryFeeUsd === null || b.entryFeeUsd === undefined ? 'None' : money(b.entryFeeUsd), {
    why: 'a bounty with no entry fee says "None"; one that charges says the amount',
  });
  compare(S, 'entries', facts.Entries, countOf(b.submissionCount));
  compare(S, 'status', facts.Status, statusText);
  compare(S, 'deadline', facts.Deadline, dateTimeOf(b.deadline));
  compare(S, 'published', facts.Published, dateOf(b.publishedAt));
  if (metric) compare(S, 'measured by', facts['Measured by'], `${metric.name}${metric.unit ? ` · ${metric.unit}` : ''}`);
  else exclude(S, 'measured by', facts['Measured by'], 'the API publishes no resolution.metric for this bounty');
  if (baseline) {
    const label = baseline.label ?? 'Baseline';
    const expected = `${String(baseline.display ?? '—')}${baseline.unit ? ` ${baseline.unit}` : ''}`;
    compare(S, `baseline (${label})`, facts[label], expected);
  } else exclude(S, 'baseline', '(none rendered)', 'the API publishes no baseline for this bounty');
  if (b.sponsor?.name) compare(S, 'sponsor', facts.Sponsor, b.sponsor.name);
  else exclude(S, 'sponsor', facts.Sponsor, 'the API publishes no sponsor for this bounty');
  exclude(S, 'time left', facts['Time left'], 'a countdown is a reading of the clock, not an API field; the deadline it counts to is compared above');

  // the fee line under the pot: what part of it is entry fees, from how many payers
  const sub = await page.$eval('.potcard .sub', (e) => e.textContent.trim()).catch(() => null);
  const payers = Number(b.entryFeePayers) || 0;
  const feesIn = Number(b.entryFeesUsd) || 0;
  const feeLine = b.entryFeeUsd === null || b.entryFeeUsd === undefined || payers === 0
    ? 'No entry fees paid in yet.'
    : `${money(feesIn)} of it from ${countOf(payers)} ${payers === 1 ? 'entrant' : 'entrants'}.`;
  compare(S, 'pot breakdown', sub, feeLine, { why: 'the line under the pot states entryFeesUsd and entryFeePayers' });

  // the rewards, as amounts (fees included) from rewardsNow
  const rewardAmounts = await page.$$eval('.rewards .amt', (els) => els.map((e) => e.firstChild?.textContent?.trim() ?? null)).catch(() => []);
  if (rewardsNow.length) {
    // the page groups places that pay the same, so the amount is read as the first token of each
    // line ("$29.40 each" is the amount $29.40), and every place's amount must appear exactly once
    const domAmounts = rewardAmounts.map((a) => String(a ?? '').split(' ')[0]);
    const wanted = rewardsNow.map((r) => money(r.amountUsd));
    compare(
      S,
      'reward lines',
      domAmounts.join(' | '),
      [...new Set(wanted)].join(' | '),
      {
        why: 'every place amount rewardsNow publishes must appear on exactly one rewards line',
        // the page groups equal amounts onto one line, so equality is on the distinct amounts in order,
        // and each published amount must appear exactly once
        test: (dom, _api, extras) => extras.eachExactlyOnce && extras.distinctMatch,
      },
      { eachExactlyOnce: wanted.every((amount) => domAmounts.filter((a) => a === amount).length === 1), distinctMatch: domAmounts.length === new Set(wanted).size },
    );
    for (const r of rewardsNow.slice(0, 3)) {
      const want = money(r.feeShareUsd);
      const text = await page.$eval('.rewards', (e) => e.textContent).catch(() => '');
      if (Number(r.feeShareUsd) > 0) {
        assertState(S, `place ${r.place} fee share`, text.includes(`${want} of fees`) ? `${want} of fees` : `"${want} of fees" not found`,
          text.includes(`${want} of fees`), `place ${r.place} pays ${want} of the entry fees and the page does not say so`);
      }
    }
  } else if (rewards.length) {
    const wanted = rewards.map(([, v]) => money(v));
    compare(S, 'rewards list', rewardAmounts.map((a) => String(a ?? '').split(' ')[0]).join(' | '), [...new Set(wanted)].join(' | '));
  } else exclude(S, 'rewards', '(none rendered)', 'the API publishes neither rewardsNow nor rewards');

  // the leaderboard CTA has to point at this bounty's leaderboard
  const cta = await page.$$eval('a[href$="/leaderboard"]', (as) => as.map((a) => a.getAttribute('href')));
  compare(S, 'leaderboard link', [...new Set(cta)].sort().join(' '), `#/bounty/${encodeURIComponent(b.slug)}/leaderboard`);

  // criteria ("Rules") are rendered one to one
  const criteria = Array.isArray(b.resolution?.criteria) ? b.resolution.criteria.length : 0;
  const rules = await page.$$eval('.rulelist li', (lis) => lis.length).catch(() => 0);
  if (criteria) compare(S, 'rules count', rules, criteria);
  else exclude(S, 'rules count', rules, 'the API publishes no resolution.criteria for this bounty');
}

async function compareFrontendLeaderboard(page, lb, b) {
  const S = `#/bounty/${BOUNTY}/leaderboard`;
  const head = await page.$$eval('table thead th', (ths) => ths.map((t) => t.textContent));
  const body = await page.$$eval('table tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  const caption = await page.$eval('table caption', (e) => e.textContent.trim()).catch(() => null);
  const entries = Array.isArray(lb.entries) ? lb.entries : [];
  const rest = Array.isArray(lb.rest) ? lb.rest : [];
  const shown = (Array.isArray(lb.columns) ? lb.columns : []).filter((c) => !c.hidden);

  compare(S, 'entries shown', head.length - 2, shown.length, { why: 'the table must have one column per visible API column' });
  compare(S, 'row count', body.length, entries.length + Math.min(rest.length, 100));
  // the ranking column, then every visible column of the first five rows
  for (const e of entries.slice(0, 5)) {
    const row = body.find((r) => r[1]?.includes(e.handle ?? '\u0000'));
    if (!row) {
      compare(S, `${e.handle}: row`, null, e.handle, { why: `${e.handle} is rank ${e.rank} in the API board and has no row` });
      continue;
    }
    compare(S, `${e.handle}: rank`, row[0], String(e.prize_rank ?? e.rank ?? '—'));
    shown.forEach((c, i) => compare(S, `${e.handle}: ${c.key}`, row[2 + i], columnExpected(c, e)));
  }
  compare(S, 'leader', (await page.$eval('.stats li:nth-child(4) .num', (e) => e.textContent).catch(() => null)), entries[0]?.handle ?? null);
  if (caption) compare(S, 'caption bounty', caption, lb.competition?.title ?? b.title);
  const pageTitle = await page.$eval('h1', (e) => e.textContent.trim());
  compare(S, 'title', pageTitle, lb.title ?? `${b.title}: results`);
}

async function compareLeaderboard(page, lb, b) {
  const S = `#/bounty/${LEADERBOARD}/leaderboard`;
  const head = await page.$$eval('table thead th', (ths) => ths.map((t) => t.textContent.trim()));
  const body = await page.$$eval('table tbody tr', (trs) =>
    trs.map((tr) => [...tr.children].map((td) => {
      // the bar under a value is decoration, not the value
      const clone = td.cloneNode(true);
      for (const bar of clone.querySelectorAll('.bar')) bar.remove();
      return clone.textContent;
    })),
  );
  const stats = await page.$$eval('.stats li', (lis) => lis.map((li) => ({ num: li.querySelector('.num')?.textContent ?? null, label: li.querySelector('.lbl')?.textContent ?? null })));
  const entries = Array.isArray(lb.entries) ? lb.entries : [];
  const rest = Array.isArray(lb.rest) ? lb.rest : [];
  const shown = (Array.isArray(lb.columns) ? lb.columns : []).filter((c) => !c.hidden);
  const rankKey = lb.rank_key ?? shown[0]?.key;
  const rankColumn = shown.find((c) => c.key === rankKey);

  compare(S, 'entries shown', stats.find((s) => s.label === 'Entries shown')?.num ?? null, countOf(entries.length + rest.length));
  compare(S, 'phase', stats.find((s) => s.label === 'Phase')?.num ?? null, lb.phase ? String(lb.phase.title ?? lb.phase.key) : null);
  compare(S, `best ${rankColumn.title}`, stats.find((s) => s.label === `Best ${rankColumn.title}`)?.num ?? null, columnExpected(rankColumn, entries[0]));
  compare(S, 'leading', stats.find((s) => s.label === 'Leading')?.num ?? null, entries[0]?.handle ?? null);

  // every visible column, on the first three rows and the last three rows: the top of the board
  // and its foot, so a column that renders right at one end and wrong at the other cannot slip by
  const sample = [...entries.slice(0, 3), ...entries.slice(-3)];
  compare(S, 'columns rendered', head.length - 2, shown.length);
  for (const e of sample) {
    const row = body.find((r) => r[1]?.includes(e.handle ?? '\u0000'));
    if (!row) {
      compare(S, `${e.handle}: row`, null, e.handle, { why: `${e.handle} is on the API board and has no row` });
      continue;
    }
    compare(S, `${e.handle}: rank`, row[0], String(e.prize_rank ?? e.rank ?? '—'));
    shown.forEach((c, i) => {
      const column = head[2 + i] ?? '';
      if (!column.startsWith(c.title.slice(0, 12))) compare(S, `${e.handle}: column ${c.key} heading`, column, c.title, { why: 'the column heading is not the API column title' });
      compare(S, `${e.handle}: ${c.key}`, row[2 + i], columnExpected(c, e));
    });
  }
  // the caption names the bounty and the phase; the bounty title must be in it exactly as published
  const caption = await page.$eval('table caption', (e) => e.textContent.trim()).catch(() => null);
  contains(S, 'caption bounty', caption, lb.competition?.title ?? b.title);
  if (fbPhaseCaption(lb)) contains(S, 'caption phase', caption, String(lb.phase.title ?? lb.phase.key));

  // link integrity: every handle on a row goes to that profile
  const links = await page.$$eval('table tbody tr a.entrytitle', (as) => as.slice(0, 5).map((a) => a.getAttribute('href')));
  compare(S, 'row links', links.join(' '), entries.slice(0, 5).map((e) => `#/u/${encodeURIComponent(e.handle ?? '')}`).join(' '));
}

async function compareProfile(page, p) {
  const S = `#/u/${p.handle}`;
  const stats = await page.$$eval('.stats li', (lis) => lis.map((li) => ({ num: li.querySelector('.num')?.textContent ?? null, label: li.querySelector('.lbl')?.textContent ?? null })));
  const h1 = await page.$eval('h1', (e) => e.textContent.trim()).catch(() => null);
  const record = p.record ?? {};
  const stat = (label) => stats.find((s) => s.label === label)?.num ?? null;

  compare(S, 'handle', h1, `@${p.handle}`);
  compare(S, 'bounties entered', stat('Bounties entered'), countOf(record.competitions_entered));
  compare(S, 'times placed', stat('Times placed'), countOf(record.competitions_placed));
  compare(S, 'wins', stat('Wins'), countOf(record.competitions_won));
  compare(S, 'podiums', stat('Podiums'), countOf(record.podium_finishes));
  compare(S, 'prizes won', stat('Prizes won'), money(record.prize_usd ?? 0));

  const solutions = Array.isArray(p.solutions) ? p.solutions : [];
  const rows = await page.$$eval('.entries > li', (lis) => lis.map((li) => ({
    title: li.querySelector('a')?.textContent ?? null,
    href: li.querySelector('a')?.getAttribute('href') ?? null,
    score: li.querySelector('.score b')?.textContent ?? null,
  })));
  compare(S, 'entries listed', rows.length, solutions.length);
  const sorted = [...solutions].sort((a, b) => new Date(b.entered_at ?? 0) - new Date(a.entered_at ?? 0));
  for (const s of sorted.slice(0, 5)) {
    const row = rows.find((r) => r.href === `#/bounty/${encodeURIComponent(s.competition?.slug ?? '')}` && r.title === (s.title ?? 'Untitled entry'));
    if (!row) {
      compare(S, `entry "${s.title}": row`, null, s.title, { why: 'the profile does not list this entry' });
      continue;
    }
    compare(S, `entry "${s.title}": score`, row.score, s.score?.display ? String(s.score.display) : '—');
  }
  const joined = await page.$$eval('.page > .note', (ns) => ns.map((n) => n.textContent.trim()).join(' '));
  if (p.joined_at) contains(S, 'joined', joined, dateOf(p.joined_at), 'the footer does not state the API joined_at date');
  else exclude(S, 'joined', joined, 'the API publishes no joined_at');
}

// ------------------------------------------------------------------ page health while a route runs

function observe(page) {
  const state = { errors: [], pageErrors: [], failed: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') state.errors.push(m.text());
  });
  page.on('pageerror', (e) => state.pageErrors.push(e.message));
  page.on('requestfailed', (r) => {
    const f = r.failure();
    // a route the app itself cancelled (AbortController on navigation) is not a failure
    if (f?.errorText?.includes('ERR_ABORTED')) return;
    state.failed.push(`${r.url()} (${f?.errorText ?? 'failed'})`);
  });
  let label = '(none)';
  return {
    reset() {
      state.errors.length = 0;
      state.pageErrors.length = 0;
      state.failed.length = 0;
    },
    check(where) {
      label = where;
      if (state.errors.length) fail(`${where}: console errors`, state.errors.slice(0, 3).join(' | '));
      if (state.pageErrors.length) fail(`${where}: page errors`, state.pageErrors.slice(0, 3).join(' | '));
      if (state.failed.length) fail(`${where}: failed requests`, state.failed.slice(0, 3).join(' | '));
    },
    finish() {
      void label;
    },
  };
}

// ------------------------------------------------------------------ non-field assertions

/** The loading skeleton must be on screen first, and only then the data. */
async function assertLoadingTransition(browser, base) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  try {
    // A nth-load delay: the first board request is held briefly, so the skeleton is observable rather
    // than a race; every later request goes straight through.
    let held = 0;
    await page.route('**/api/competitions?**', async (route) => {
      if (held++ === 0) await new Promise((r) => setTimeout(r, 900));
      await route.continue();
    });
    await page.goto(`${base}/#/`, { waitUntil: 'domcontentloaded' });
    const sawLoading = await page.waitForFunction(() => document.querySelector('.loading') !== null && window.__shotReady !== true, undefined, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (!sawLoading) fail('loading → ready', 'the page never showed its loading state before the data landed');
    await page.waitForFunction(() => window.__shotReady === true, undefined, { timeout: 30000 });
    const stillLoading = await page.evaluate(() => document.querySelector('.loading') !== null);
    if (stillLoading) fail('loading → ready', 'the skeleton was still on screen after __shotReady became true');
    else {
      const rowCount = await page.$$eval('ul.board > li', (l) => l.length);
      assertState('#/', 'loading → ready', `skeleton first, then ${rowCount} rows`, rowCount > 0, 'the skeleton must give way to the board');
    }

    // and the reverse transition: a hash change must put __shotReady back to false while the next route loads
    const resetOnChange = await page.evaluate(async () => {
      const next = location.hash === '#/bounties' ? '#/' : '#/bounties';
      const seen = [];
      const observer = new MutationObserver(() => seen.push(window.__shotReady));
      observer.observe(document.getElementById('view'), { childList: true });
      location.hash = next;
      seen.push(window.__shotReady);
      await new Promise((r) => setTimeout(r, 600));
      observer.disconnect();
      seen.push(window.__shotReady);
      return seen;
    }).catch(() => []);
    const sawFalse = Array.isArray(resetOnChange) && resetOnChange.some((v) => v === false);
    assertState('#/', 'loading → ready: a hash change resets readiness', `__shotReady while the next route loaded: ${JSON.stringify(resetOnChange)}`, sawFalse,
      'window.__shotReady was not false while the new route loaded, so a capture could shoot a stale page');
  } finally {
    await page.close();
  }
}

/**
 * A forced 404: the API answered 500 the first time and its real 404 the second. The page has to show
 * an error state carrying the status, and its retry button has to make a new request — a retry that
 * only re-paints the old error cannot pass.
 */
async function assertForced404(page, base) {
  const slug = 'zzz-no-such-bounty';
  const url = `**/api/competitions/${slug}*`;
  let calls = 0;
  await page.route(url, async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: [{ message: 'forced failure: the harness held this request' }] }),
      });
    } else {
      await route.continue();
    }
  });
  const label = `#/bounty/${slug}`;
  try {
    await page.goto(`${base}/${label}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__shotReady === true, undefined, { timeout: 30000 });
    const error = await page.evaluate(() => window.__error);
    const alert = await page.$eval('[role="alert"]', (e) => e.textContent.trim()).catch(() => null);
    if (!alert) fail(`${label}: error state`, 'the page rendered no [role="alert"] error block');
    if (!error) fail(`${label}: error state`, 'window.__error is null although the request was forced to fail');
    else compare(label, 'forced 404: status surfaced', String(error.status ?? ''), '500', { why: 'the error state must carry the status the API answered' });

    const retry = await page.$('[data-retry]');
    if (!retry) fail(`${label}: retry`, 'the error state offers no retry button');
    else {
      const before = calls;
      await retry.click();
      await page.waitForFunction(() => window.__shotReady === true, undefined, { timeout: 30000 });
      if (calls <= before) fail(`${label}: retry`, 'the retry button made no new request');
      else assertState(label, 'forced 404: retry re-requests', `forced request answered 500, then ${calls - before} retry request(s) reached the API`, calls > before, 'the retry button did not make a new request');

      const after = await page.evaluate(() => window.__error);
      compare(label, 'forced 404: not-found status', String(after?.status ?? ''), '404', { why: "the second answer was the API's real 404 and the page must show it as one" });
      const text = await page.$eval('[role="alert"]', (e) => e.textContent).catch(() => '');
      compare(label, 'forced 404: reason shown', /not there|not found/i.test(text) ? 'not found' : text.replace(/\s+/g, ' ').trim().slice(0, 60), 'not found', {
        why: 'a 404 must read as a missing page, not as a broken one',
      });
    }
  } finally {
    await page.unroute(url);
  }
}

/** No horizontal overflow at 360, 768 and 1280, on all four surfaces (the profile is the real handle). */
async function assertOverflow(browser, base, profileHandle) {
  const routes = ['#/', `#/bounty/${LEADERBOARD}`, `#/bounty/${LEADERBOARD}/leaderboard`, `#/u/${encodeURIComponent(profileHandle)}`];
  for (const width of [360, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    // the board's ledger of 16 bounties is loaded once per width; the other routes are hash changes
    await page.goto(`${base}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__shotReady === true, undefined, { timeout: 45000 });
    try {
      for (const route of routes) {
        await open(page, base, route);
        const box = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          win: window.innerWidth,
        }));
        const widest = Math.max(box.doc, box.body);
        if (widest > box.win) fail(`overflow @${width}px ${route}`, `the page is ${widest}px wide in a ${box.win}px window`);
        else compare(`overflow @${width}px`, route, `${widest}px`, `${widest}px`);
      }
    } finally {
      await page.close();
    }
  }
}

// ------------------------------------------------------------------ screenshots

const SHOT_FILES = [];

async function capture(page, file) {
  const dir = join(repo, 'screenshots');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  const hash = await page.evaluate(() => location.hash);
  await page.screenshot({ path, type: 'jpeg', quality: 82, animations: 'disabled', caret: 'hide' });
  const bytes = statSync(path).size;
  if (bytes > 262144) fail(`screenshot ${file}`, `${bytes} bytes is over the 256 KiB cap`);
  SHOT_FILES.push({ file, path: `#${hash}`, bytes });
}

function writeShots() {
  const shots = SHOT_FILES.map(({ file, path }) => ({ file, path, viewport: { width: WIDTH, height: HEIGHT } }));
  writeFileSync(join(repo, 'shots.json'), `${JSON.stringify(shots, null, 2)}\n`);
  console.log('');
  for (const shot of SHOT_FILES) console.log(`SHOT ${shot.file}  ${shot.bytes} bytes  ${shot.path}`);
}

// ------------------------------------------------------------------ report

function report() {
  const width = { surface: 0, field: 0, dom: 0, api: 0 };
  for (const r of rows) {
    width.surface = Math.max(width.surface, r.surface.length);
    width.field = Math.max(width.field, r.field.length);
    width.dom = Math.max(width.dom, String(r.dom).length);
    width.api = Math.max(width.api, String(r.api).length);
  }
  const cap = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
  const pad = (s, n) => String(s).padEnd(n);

  console.log('');
  console.log(`${pad('SURFACE', width.surface)}  ${pad('FIELD', width.field)}  ${pad('RESULT', 8)}  ${pad('DOM', Math.min(width.dom, 48))}  API`);
  console.log('-'.repeat(width.surface + width.field + Math.min(width.dom, 48) + width.api + 16));
  for (const r of rows) {
    console.log(
      `${pad(r.surface, width.surface)}  ${pad(r.field, width.field)}  ${pad(r.ok ? 'match' : 'MISMATCH', 8)}  ${pad(cap(r.dom, Math.min(width.dom, 48)), Math.min(width.dom, 48))}  ${cap(r.api, width.api)}`,
    );
  }

  const bad = rows.filter((r) => !r.ok);
  if (bad.length) {
    console.log('');
    console.log(`MISMATCHES (${bad.length})`);
    for (const r of bad) {
      console.log(`  ${r.surface} · ${r.field}`);
      console.log(`    page: ${r.dom}`);
      console.log(`    api : ${r.api}`);
      console.log(`    why : ${r.reason}`);
    }
  }

  if (excluded.length) {
    console.log('');
    console.log(`EXCLUDED (${excluded.length}, not compared, out of numerator and denominator)`);
    for (const e of excluded) console.log(`  ${e.surface} · ${e.field}: ${e.reason}`);
  }

  if (hardFailures.length) {
    console.log('');
    console.log(`ASSERTION FAILURES (${hardFailures.length})`);
    for (const f of hardFailures) console.log(`  ${f}`);
  }

  const matched = rows.filter((r) => r.ok).length;
  const compared = rows.length;
  const percent = compared === 0 ? 0 : (matched / compared) * 100;
  const shownPercent = Math.floor(percent * 10) / 10; // never round a figure up into a pass
  console.log('');
  console.log(`ACCURACY: ${matched}/${compared} = ${shownPercent}%`);

  const pass = shownPercent >= THRESHOLD && hardFailures.length === 0;
  if (!pass) {
    const reasons = [];
    if (shownPercent < THRESHOLD) reasons.push(`${shownPercent}% is below the ${THRESHOLD}% floor`);
    if (hardFailures.length) reasons.push(`${hardFailures.length} assertion failure(s)`);
    console.log(`FAIL: ${reasons.join('; ')}.`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${shownPercent}% of ${compared} fields match and every assertion holds (floor ${THRESHOLD}%).`);
  }
}

await main();
