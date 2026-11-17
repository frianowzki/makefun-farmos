// farmOS: four hash routes over make.fun's public API.
//
//   #/                            the board of open bounties
//   #/bounty/<slug>               one bounty
//   #/bounty/<slug>/leaderboard   that bounty's leaderboard
//   #/u/<handle>                  a public profile
//
// window.__shotReady is false the moment a route starts loading and true once its data is on
// screen; window.__error holds the message when a route ends in an error. A retry re-requests.
// Every await is guarded, so nothing here can leave an unhandled rejection behind.

import { ApiError, fetchBoard, fetchBounty, fetchLeaderboard, fetchProfile } from './api.js';
import { isHandle, isSlug } from './format.js';
import { board, bounty, errorView, leaderboard, notFound, profile, skeleton } from './views.js';

const view = document.getElementById('view');
const main = document.getElementById('main');
const navLinks = [...document.querySelectorAll('[data-nav]')];
const PER_PAGE = 25;

/** The route the page is on, as far as the hash says. */
function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const path = raw.split('?')[0];
  const parts = path.split('/').filter(Boolean).map(decodePart);
  if (parts.length === 0) return { kind: 'board' };
  if (parts[0] === 'bounty' && parts.length >= 2) {
    if (!isSlug(parts[1])) return { kind: 'missing', what: 'bounty' };
    if (parts.length === 2) return { kind: 'bounty', slug: parts[1] };
    if (parts.length === 3 && parts[2] === 'leaderboard') return { kind: 'leaderboard', slug: parts[1] };
    return { kind: 'missing', what: 'route' };
  }
  if (parts[0] === 'u' && parts.length === 2) {
    if (!isHandle(parts[1])) return { kind: 'missing', what: 'profile' };
    return { kind: 'profile', handle: parts[1] };
  }
  return { kind: 'missing', what: 'route' };
}

function decodePart(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** The nav item the current route belongs to, for aria-current. */
function markNav(kind) {
  const want = kind === 'profile' ? 'profile' : kind === 'board' || kind === 'bounty' || kind === 'leaderboard' ? 'board' : '';
  for (const a of navLinks) {
    if (a.dataset.nav === want) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

/** Loading: the skeleton goes up, the flags say so, and the page keeps its own scroll position. */
function startLoad(kind) {
  window.__shotReady = false;
  window.__error = null;
  view.innerHTML = skeleton(kind);
}

/** Ready: data is drawn, the flag clears the way for a screenshot. */
function finish() {
  window.__shotReady = true;
}

/** An error a reader can act on, and a flag the verifier can read. */
function fail(err, what) {
  const message = err instanceof ApiError ? err.message : 'Something unexpected went wrong while loading this page.';
  const detail = err instanceof ApiError && err.status ? `${err.path} answered ${err.status}.` : err?.message ? String(err.message) : '';
  view.innerHTML = errorView({ title: what, message, detail });
  window.__error = message;
  main.focus({ preventScroll: true });
}

let current = 0;

async function render({ fromHash }) {
  const ticket = ++current;
  const route = parseRoute();
  markNav(route.kind);
  startLoad(route.kind);

  if (route.kind === 'missing') {
    document.title = 'Not found · farmOS';
    view.innerHTML = notFound('That page is not here.', 'farmOS knows four routes: the board, a bounty, a bounty’s leaderboard and a profile.');
    finish();
    return;
  }

  try {
    if (route.kind === 'board') {
      document.title = 'Bounties · farmOS';
      const data = await fetchBoard();
      if (ticket !== current) return;
      view.innerHTML = board(data);
      finish();
    } else if (route.kind === 'bounty') {
      const b = await fetchBounty(route.slug);
      if (ticket !== current) return;
      if (!b || !b.slug) {
        document.title = 'Not found · farmOS';
        view.innerHTML = notFound('No such bounty.', 'make.fun has no bounty with that address.');
        finish();
        return;
      }
      document.title = `${b.title} · farmOS`;
      view.innerHTML = bounty(b);
      finish();
    } else if (route.kind === 'leaderboard') {
      const lb = await fetchLeaderboard(route.slug);
      if (ticket !== current) return;
      document.title = `Leaderboard · ${lb?.competition?.title ?? route.slug} · farmOS`;
      view.innerHTML = leaderboard(lb, { perPage: PER_PAGE });
      pager();
      finish();
    } else {
      const p = await fetchProfile(route.handle);
      if (ticket !== current) return;
      if (!p || !p.handle) {
        document.title = 'Not found · farmOS';
        view.innerHTML = notFound('No such profile.', 'make.fun has no public profile with that handle.');
        finish();
        return;
      }
      document.title = `${p.handle} · farmOS`;
      view.innerHTML = profile(p);
      finish();
    }
    if (fromHash) {
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }
  } catch (err) {
    if (ticket !== current) return;
    if (err?.name === 'AbortError') return;
    if (err instanceof ApiError && err.status === 404) {
      document.title = 'Not found · farmOS';
      view.innerHTML = notFound('Not on make.fun.', err.message);
      finish();
      return;
    }
    document.title = 'Something went wrong · farmOS';
    fail(err, route.kind === 'board' ? 'The board did not load.' : 'This page did not load.');
  }
}

/** Paging a leaderboard redraws only the rows it shows; the data is already in memory. */
function pager() {
  view.querySelectorAll('[data-page]').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => pageTo(Number(btn.dataset.page)));
  });
}

async function pageTo(page) {
  const route = parseRoute();
  if (route.kind !== 'leaderboard') return;
  const at = Math.max(1, page);
  window.__shotReady = false;
  try {
    const lb = await fetchLeaderboard(route.slug);
    view.innerHTML = leaderboard(lb, { page: at, perPage: PER_PAGE });
    pager();
    finish();
    const table = view.querySelector('.table-wrap');
    if (table) table.scrollIntoView({ block: 'start' });
  } catch (err) {
    fail(err, 'The leaderboard did not load.');
  }
}

// One delegated listener: a retry re-runs the current route for real, page buttons page.
document.addEventListener('click', (event) => {
  const retry = event.target.closest?.('[data-retry]');
  if (retry) {
    window.__error = null;
    render({ fromHash: false });
    return;
  }
  const page = event.target.closest?.('[data-page]');
  if (page && !page.disabled) pageTo(Number(page.dataset.page));
});

window.addEventListener('hashchange', () => render({ fromHash: true }));
window.addEventListener('error', (event) => {
  if (!window.__shotReady) window.__error = String(event.message || 'Script error');
});
window.addEventListener('unhandledrejection', (event) => {
  if (!window.__shotReady) window.__error = String(event.reason?.message || event.reason || 'Unhandled rejection');
});

// ---------------------------------------------------------------- theme

const toggle = document.getElementById('theme-toggle');
const themeLabel = document.getElementById('theme-label');

/** What the reader chose in this browser, or null if they never chose. */
function storedTheme() {
  try {
    const v = localStorage.getItem('farmOS.theme');
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

/** The theme in force: the reader's choice, else the system's preference. */
const themeNow = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

/** Reflect a theme on the document and on the rail control. */
function paintTheme() {
  const theme = themeNow();
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  toggle?.setAttribute('aria-pressed', String(theme === 'dark'));
  if (themeLabel) themeLabel.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

// index.html sets data-theme before paint from the same two inputs (stored choice, then the
// system), so the first frame is already themed; this only makes it explicit and keeps the
// control in step.
if (!document.documentElement.getAttribute('data-theme')) {
  document.documentElement.setAttribute(
    'data-theme',
    storedTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );
}
paintTheme();

toggle?.addEventListener('click', () => {
  const next = themeNow() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('farmOS.theme', next);
  } catch {
    // Storage refused: the toggle still works for this page.
  }
  paintTheme();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (storedTheme()) return;
  document.documentElement.setAttribute('data-theme', themeNow() === 'dark' ? 'light' : 'dark');
  paintTheme();
});

render({ fromHash: false });
