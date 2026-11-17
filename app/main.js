// farmOS: hash-routed views over make.fun's public API.
//
//   #/                          the bounty board
//   #/bounty/<slug>             one bounty
//   #/bounty/<slug>/leaderboard its leaderboard
//   #/u/<handle>                a public profile
//
// window.__shotReady is false while a route loads and true once its data is on screen; window.__error
// holds the reason when a route ends in an error (and is null otherwise).

import { ApiError, getBounty, getLeaderboard, getProfile, listBounties } from './api.js';
import { esc } from './format.js';
import { icons } from './icons.js';
import { boardView, bountyView, leaderboardView, profileView } from './views.js';

const view = document.getElementById('view');
const themeBtn = document.getElementById('theme-btn');
const themeIcon = document.getElementById('theme-icon');
const themeLabel = document.getElementById('theme-label');
const navLinks = [...document.querySelectorAll('[data-nav]')];

/** The loading skeleton: fixed heights, so the layout does not shift when data lands. */
const LOADING = `<div class="loading" aria-busy="true" role="status">
  <div class="skel skel-eyebrow"></div>
  <div class="skel skel-title"></div>
  <div class="skel skel-lede"></div>
  <div class="skel skel-card"></div>
  <span class="sr">Loading</span>
</div>`;

/** The rail's destinations carry their icons, authored in icons.js. */
const NAV_ICONS = { board: icons.board, bounties: icons.ledger, profile: icons.user };
for (const link of navLinks) {
  const icon = link.querySelector('.icon');
  if (icon) icon.innerHTML = NAV_ICONS[link.dataset.nav] ?? '';
  const label = link.lastChild;
  if (label && label.nodeType === Node.TEXT_NODE) {
    const span = document.createElement('span');
    span.className = 'label';
    span.textContent = label.textContent;
    link.replaceChild(span, label);
  }
}

// ---------------------------------------------------------------- theme

const applyTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
  const dark = theme === 'dark';
  themeBtn.setAttribute('aria-pressed', String(dark));
  themeIcon.innerHTML = dark ? icons.sun : icons.moon;
  themeLabel.textContent = dark ? 'Light' : 'Dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
};

const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
applyTheme(currentTheme());

themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('farmos.theme', next);
  } catch {
    // A browser with storage off keeps the theme for this visit only.
  }
});

// ---------------------------------------------------------------- routing

/** What a route is: a name, its parameters, and the rail item it belongs to. */
function routeOf(hash) {
  const path = (hash || '#/').replace(/^#/, '');
  const parts = path.split('/').filter(Boolean).map(decodeSegment);
  if (parts.length === 0) return { name: 'board', nav: 'board' };
  if (parts[0] === 'bounty' && parts.length >= 2) {
    const slug = parts[1];
    if (parts.length >= 3 && parts[2] === 'leaderboard') return { name: 'leaderboard', slug, nav: 'board' };
    return { name: 'bounty', slug, nav: 'board' };
  }
  if (parts[0] === 'bounties') return { name: 'bounties', nav: 'bounties' };
  if (parts[0] === 'u' && parts.length >= 2) return { name: 'profile', handle: parts[1], nav: 'profile' };
  return { name: 'notfound', nav: null, path };
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The route being shown, so a stale response never paints over a newer one. */
let generation = 0;
let inflight = null;

const setNav = (nav) => {
  for (const link of navLinks) {
    const on = nav !== null && link.dataset.nav === nav;
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
};

const setTitle = (text) => {
  document.title = text ? `${text} · farmOS` : 'farmOS — make.fun bounties';
};

/** An honest error page: what failed, why, and a retry that really runs the route again. */
function errorView(error) {
  const isApi = error instanceof ApiError;
  const status = isApi && error.status ? `HTTP ${error.status}` : '';
  const reason = isApi ? error.message : 'Something on this page failed.';
  const detail = [isApi ? error.path : '', status].filter(Boolean).join(' · ');
  return `
  <div class="page">
    <p class="eyebrow">${isApi && error.status === 404 ? 'Not found' : 'Could not load'}</p>
    <div class="error" role="alert">
      <h1>${esc(isApi && error.status === 404 ? 'That page is not there.' : 'This page could not be loaded.')}</h1>
      <p>${esc(reason)}</p>
      ${detail ? `<p class="detail">${esc(detail)}</p>` : ''}
      <button class="btn" type="button" data-retry>${icons.refresh}Try again</button>
      <p class="note" style="margin-top:14px">The board and every bounty are read live from make.fun's public API.</p>
    </div>
  </div>`;
}

const notFoundView = (path) => `
  <div class="page">
    <p class="eyebrow">Not found</p>
    <div class="error">
      <h1>No such page.</h1>
      <p>farmOS has four places: the board, a bounty, a bounty's leaderboard and a maker's profile.</p>
      <p class="detail">${esc(path || '/')}</p>
      <a class="btn" href="#/">Go to the board</a>
    </div>
  </div>`;

async function load(route, signal) {
  switch (route.name) {
    case 'board': {
      const items = await listBounties(signal);
      return { html: boardView(items), title: 'Bounty board' };
    }
    case 'bounties': {
      const items = await listBounties(signal);
      const sorted = [...items].sort((a, b) => Number(b.potUsd ?? 0) - Number(a.potUsd ?? 0));
      return { html: boardView(sorted), title: 'Bounty ledger' };
    }
    case 'bounty': {
      const bounty = await getBounty(route.slug, signal);
      return { html: bountyView(bounty), title: bounty.title ?? route.slug };
    }
    case 'leaderboard': {
      const [bounty, board] = await Promise.all([getBounty(route.slug, signal), getLeaderboard(route.slug, signal)]);
      return { html: leaderboardView(bounty, board), title: `Leaderboard · ${bounty.title ?? route.slug}` };
    }
    case 'profile': {
      const profile = await getProfile(route.handle, signal);
      return { html: profileView(profile), title: `@${profile.handle ?? route.handle}` };
    }
    default:
      return { html: notFoundView(route.path), title: 'Not found', notFound: true };
  }
}

async function render() {
  const route = routeOf(location.hash);
  const mine = ++generation;
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;

  window.__shotReady = false;
  window.__error = null;
  setNav(route.nav);

  if (route.name === 'notfound') {
    view.innerHTML = notFoundView(route.path);
    setTitle('Not found');
    window.scrollTo(0, 0);
    window.__shotReady = true;
    return;
  }

  view.innerHTML = LOADING;

  try {
    const result = await load(route, controller.signal);
    if (mine !== generation) return;
    view.innerHTML = result.html;
    setTitle(result.title);
    if (document.activeElement && document.activeElement !== document.body && !view.contains(document.activeElement)) {
      // Keep focus on the page, not on a link that the new view replaced.
      view.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
    window.__shotReady = true;
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (mine !== generation) return;
    const error = err instanceof ApiError ? err : new ApiError(err?.message ?? 'Unexpected failure.', {});
    window.__error = { message: error.message, status: error.status, path: error.path };
    view.innerHTML = errorView(error);
    setTitle('Error');
    window.scrollTo(0, 0);
    window.__shotReady = true;
    console.warn('farmOS:', error.message);
  }
}

// A retry button inside an error page re-renders the current route from scratch.
view.addEventListener('click', (event) => {
  const retry = event.target.closest('[data-retry]');
  if (retry) {
    retry.disabled = true;
    render();
  }
});

window.addEventListener('hashchange', () => {
  window.__shotReady = false;
  render();
});

// The skip link lands on the view, which is focusable for exactly this.
document.querySelector('.skip')?.addEventListener('click', () => {
  view.focus({ preventScroll: false });
});

// A rejected fetch that nothing awaited must never surface as an unhandled rejection.
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  window.__error = { message: String(event.reason?.message ?? event.reason ?? 'Unhandled failure.') };
  console.warn('farmOS:', event.reason);
});

render();
