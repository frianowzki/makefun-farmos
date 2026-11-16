// The app's shell: hash routes, the theme, and the two flags a screenshot harness reads.
//
//   #/                                   the board
//   #/?cat=Games&sort=pot                the board, filtered and sorted
//   #/bounty/<slug>                      one bounty
//   #/bounty/<slug>/leaderboard          its standings  (?page=1 is the second page)
//   #/u/<handle>                         an account's public profile
//
// window.__shotReady is false from the moment a route starts loading until its data is on
// screen; window.__error is null, then the failed route's message when a route ends in an
// error state.

import * as api from './data.js';
import { emptyState, errorState, loading } from './ui.js';
import { boardView } from './view-board.js';
import { bountyView } from './view-bounty.js';
import { leaderboardView } from './view-leaderboard.js';
import { moreEntries, profileView } from './view-profile.js';

const out = document.getElementById('view');

window.__shotReady = false;
window.__error = null;

// ---------------------------------------------------------------- the theme

const THEME_KEY = 'farm-os.theme';
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

/** The reader's kept choice, or null on a first visit. */
function keptTheme() {
  try {
    const kept = localStorage.getItem(THEME_KEY);
    return kept === 'dark' || kept === 'light' ? kept : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  const next = theme === 'dark' ? 'light' : 'dark';
  button.setAttribute('aria-label', `Switch to the ${next} theme`);
  button.setAttribute('title', `Switch to the ${next} theme`);
  button.dataset.now = theme;
  const label = button.querySelector('[data-theme-label]');
  if (label) label.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

applyTheme(keptTheme() ?? (prefersDark.matches ? 'dark' : 'light'));

document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // A browser that keeps no storage still gets the theme for this visit.
  }
});

// ---------------------------------------------------------------- routing

/** The route the hash names. */
export function parseRoute(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  if (parts.length === 0) return { name: 'board', params };
  if (parts[0] === 'bounty' && parts[1]) {
    if (parts[2] === 'leaderboard') return { name: 'leaderboard', slug: parts[1], params };
    return { name: 'bounty', slug: parts[1], params };
  }
  if (parts[0] === 'u' && parts[1]) return { name: 'profile', handle: parts[1], params };
  return { name: 'notfound', params };
}

/** The rail item a route belongs to. */
const railFor = (route) => (route.name === 'profile' ? 'profile' : route.name === 'board' ? 'board' : 'bounty');

function syncRail(route) {
  const active = railFor(route);
  for (const link of document.querySelectorAll('[data-rail]')) {
    if (link.dataset.rail === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

const TITLES = {
  board: 'The bounty board',
  bounty: 'Bounty',
  leaderboard: 'Leaderboard',
  profile: 'Profile',
  notfound: 'Not found',
};

const setTitle = (text) => {
  document.title = `${text} · FarmOS`;
};

/** The skeleton a route paints while its read is in flight. */
const skeletonFor = (name) => loading(name === 'notfound' ? 'board' : name);

/** A route's data as `{ title, view }`. */
async function load(route) {
  if (route.name === 'board') {
    const data = await api.board();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      return {
        title: TITLES.board,
        view: emptyState({
          title: 'No open bounties',
          message: 'Every bounty on make.fun is closed, or its results are published. Fresh ones open all the time.',
          action: '<a class="btn" href="#/">Check again</a>',
        }),
      };
    }
    return {
      title: TITLES.board,
      view: boardView(data, { category: route.params.get('cat') ?? 'all', sort: route.params.get('sort') ?? 'deadline' }),
    };
  }
  if (route.name === 'bounty') {
    const b = await api.bounty(route.slug);
    return { title: b.title, view: bountyView(b) };
  }
  if (route.name === 'leaderboard') {
    const data = await api.leaderboard(route.slug);
    const page = Number(route.params.get('page') ?? 0);
    return {
      title: `Leaderboard · ${data?.competition?.title ?? route.slug}`,
      view: leaderboardView(data, { page: Number.isFinite(page) ? page : 0 }),
    };
  }
  if (route.name === 'profile') {
    const p = await api.profile(route.handle);
    return { title: p.display_name || `@${p.handle}`, view: profileView(p) };
  }
  return {
    title: TITLES.notfound,
    view: emptyState({
      title: 'That page is not here',
      message: 'The board is at #/, a bounty at #/bounty/<slug>, its standings at #/bounty/<slug>/leaderboard, and an account at #/u/<handle>.',
      action: '<a class="btn btn--primary" href="#/">Go to the board</a>',
    }),
  };
}

/** What a failed route says. */
function errorFor(route, error) {
  const status = error?.status ?? 0;
  const subject = {
    board: 'the board',
    bounty: `bounty ${route.slug}`,
    leaderboard: `a leaderboard for ${route.slug}`,
    profile: `a profile for @${route.handle}`,
    notfound: 'this page',
  }[route.name];
  const missing = status === 404;
  const title = missing ? 'Not found on make.fun' : 'make.fun did not answer';
  return {
    title,
    view: errorState({
      title,
      message: missing ? `make.fun has no ${subject}.` : error?.message,
      status,
      retry: route.name === 'notfound' ? 'board' : route.name,
    }),
  };
}

/** One route from start to finish. Only the newest render may paint. */
let generation = 0;

async function render(route = parseRoute(), { silent = false } = {}) {
  const mine = ++generation;
  window.__shotReady = false;
  window.__error = null;
  syncRail(route);
  if (!silent) out.innerHTML = skeletonFor(route.name);
  try {
    const result = await load(route);
    if (mine !== generation) return;
    out.innerHTML = result.view;
    setTitle(result.title);
    window.__shotReady = true;
  } catch (error) {
    if (mine !== generation) return;
    const failed = errorFor(route, error);
    out.innerHTML = failed.view;
    setTitle(failed.title);
    window.__error = error?.message ?? String(error);
    window.__shotReady = true;
  }
  const heading = out.querySelector('h1');
  if (heading) heading.setAttribute('tabindex', '-1');
  if (!silent) {
    out.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
}

window.addEventListener('hashchange', () => render());
render();

// ---------------------------------------------------------------- interactions

out.addEventListener('click', async (event) => {
  const retry = event.target.closest('[data-retry]');
  if (retry) {
    const route = parseRoute();
    retry.disabled = true;
    retry.textContent = 'Trying again…';
    // A retry is a fresh read: the route's path leaves the cache's failure memory and goes to make.fun again.
    api.retry(retry.dataset.retry, route.slug ?? route.handle);
    await render(route);
    return;
  }

  // A profile's "show more" draws the next batch from the answer already read.
  const more = event.target.closest('[data-more-entries]');
  if (more) {
    const route = parseRoute();
    const shown = Number(more.dataset.moreEntries) || 0;
    const p = await api.profile(route.handle);
    const total = p.solutions?.length ?? shown;
    const next = Math.min(shown + 24, total);
    const list = out.querySelector('.entry-list');
    if (list) list.innerHTML = moreEntries(p, next);
    if (next >= total) {
      more.parentElement.remove();
    } else {
      more.dataset.moreEntries = String(next);
      more.textContent = `Show ${Math.min(24, total - next)} more`;
      const note = more.parentElement.querySelector('.muted');
      if (note) note.textContent = `Showing ${next} of ${total}`;
    }
    return;
  }

  // A leaderboard page link repaints the table in place and keeps the keyboard close by.
  const page = event.target.closest('[data-page]');
  if (page) {
    event.preventDefault();
    history.replaceState(null, '', page.getAttribute('href'));
    await render(parseRoute(), { silent: true });
    const wasNext = page.getAttribute('rel') === 'next';
    const pager = out.querySelectorAll('.pager [data-page]');
    const target = wasNext ? pager[pager.length - 1] : pager[0];
    if (target) target.focus();
  }
});

// A sort choice is a URL too, so back and forward step through it.
out.addEventListener('change', (event) => {
  const select = event.target.closest('[data-sort]');
  if (!select) return;
  const params = new URLSearchParams(parseRoute().params);
  params.set('sort', select.value);
  const cat = params.get('cat');
  const query = new URLSearchParams({ sort: select.value });
  if (cat) query.set('cat', cat);
  location.hash = `#/?${query.toString()}`;
});
