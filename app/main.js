/* The router: one hash route decides one view. Every route starts loading by setting
   window.__shotReady to false and ends it once its data is on screen, so a checker (or a screenshot
   script) waits on the flag, never on a timer. A route that cannot load sets window.__error. */

import { boardView, bountyView, leaderboardView, profileView } from './views.js';
import { beginLoad, endLoad, mount } from './dom.js';
import { h } from './dom.js';

const THEME_KEY = 'farmos.theme';
const rail = {
  board: document.getElementById('nav-board'),
  live: document.getElementById('nav-live'),
  closed: document.getElementById('nav-closed'),
};

/** #/board, #/bounty/<slug>, #/bounty/<slug>/leaderboard, #/u/<handle>. Anything else is not a route. */
export function parseRoute(hash) {
  const path = String(hash || '').replace(/^#/, '') || '/';
  const parts = path.split('/').filter(Boolean).map((piece) => {
    try {
      return decodeURIComponent(piece);
    } catch {
      return piece;
    }
  });
  if (parts.length === 0) return { name: 'board', kind: 'open' };
  if (parts[0] === 'live' && parts.length === 1) return { name: 'board', kind: 'open' };
  if (parts[0] === 'closed' && parts.length === 1) return { name: 'board', kind: 'closed' };
  if (parts[0] === 'bounty' && parts.length === 2) return { name: 'bounty', slug: parts[1] };
  if (parts[0] === 'bounty' && parts.length === 3 && parts[2] === 'leaderboard') return { name: 'leaderboard', slug: parts[1] };
  if (parts[0] === 'u' && parts.length === 2) return { name: 'profile', handle: parts[1] };
  return { name: 'missing' };
}

/** Which rail item the current route belongs to. A bounty and its leaderboard both live under Board. */
function markRail(name) {
  const active = name === 'closed' ? rail.closed : 'board';
  for (const [key, link] of Object.entries(rail)) {
    if (key === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function missingView() {
  const { pathname } = location;
  return mount(h(
    'div',
    { class: 'head' },
    h('p', { class: 'eyebrow' }, 'Not found'),
    h('h1', { 'data-f': 'not-found' }, 'There is no such page'),
    h('p', { class: 'lede' }, `“${location.hash || pathname}” is not one of FarmOS's routes. The board, a bounty, its leaderboard and a profile are.`),
    h('p', { style: 'margin-top:18px' }, h('a', { class: 'btn primary', href: '#/' }, 'Back to the board')),
  ));
}

/** The theme control: the stored choice wins, the system's preference is the first-visit default. */
function wireTheme() {
  const button = document.getElementById('theme');
  const word = document.getElementById('theme-word');
  const apply = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    const dark = theme === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
    word.textContent = dark ? 'Light' : 'Dark';
  };
  apply(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  button.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* a private window with storage off: the choice lasts this page only */
    }
  });
}

let navToken = 0;

/** Renders the route in the hash. A slower earlier navigation never overwrites a newer one. */
async function route() {
  const token = ++navToken;
  window.__shotReady = false;
  window.__error = null;
  const parsed = parseRoute(location.hash);
  markRail(parsed.name === 'board' ? parsed.kind : parsed.name === 'closed' ? 'closed' : 'board');

  const again = () => {
    if (token === navToken) route();
  };

  try {
    if (parsed.name === 'missing') {
      beginLoad();
      missingView();
      document.title = 'Not found · FarmOS';
      endLoad();
      return;
    }
    // Opening the page's own load before the view is picked: a wait can already be looking at the flag between
    // `start()` setting it and the view's first await, and it must see the page loading, never the last one.
    beginLoad();
    if (parsed.name === 'board') {
      document.title = parsed.kind === 'closed' ? 'Closed bounties · FarmOS' : 'Live bounties · FarmOS';
      await boardView(parsed.kind, { onRetry: again });
    } else if (parsed.name === 'bounty') {
      await bountyView(parsed.slug, { onRetry: again });
    } else if (parsed.name === 'leaderboard') {
      await leaderboardView(parsed.slug, { onRetry: again });
    } else if (parsed.name === 'profile') {
      await profileView(parsed.handle, { onRetry: again });
    }
  } catch (err) {
    // A view that throws is still a page the reader must be able to retry.
    window.__error = err && err.message ? err.message : String(err);
    mount(h('div', { class: 'err', role: 'alert', 'data-f': 'error' },
      h('p', { class: 'eyebrow' }, 'Something went wrong'),
      h('h2', null, 'This page could not be read'),
      h('p', null, window.__error),
      h('button', { class: 'btn primary', type: 'button', 'data-action': 'retry', onclick: again }, 'Try again')));
  } finally {
    // Paired with the beginLoad() above, whether the route threw, returned or was superseded: only the newest
    // route closes the wait, and it closes it exactly once.
    if (token === navToken) endLoad();
  }
}

/** The title scrolls into view on a route change, except on the first paint, where the page is at its top. */
function settle(first) {
  if (!first) document.getElementById('main').focus({ preventScroll: false });
}

export function start() {
  window.__shotReady = false;
  window.__error = null;
  wireTheme();
  window.addEventListener('hashchange', () => {
    route().then(() => settle(false));
  });
  route().then(() => settle(true));
  // A frame after the first route settles, so layout and fonts are done when a shot is taken.
  requestAnimationFrame(() => requestAnimationFrame(() => {}));
}

// Anything a listener lets escape is reported to the page, never left as an unhandled rejection.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason ?? 'unknown error');
  window.__error = window.__error || reason;
  if (window.__shotReady !== true) window.__shotReady = true;
});

start();
