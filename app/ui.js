// What every page shares: the small escaping and formatting helpers, the link/label
// fragments, and the loading, error and empty states each route paints before and after
// its data arrives.

/** Text safe to put in HTML. */
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A bounty's address. */
export const bountyHref = (slug) => `#/bounty/${encodeURIComponent(slug)}`;
/** A bounty's leaderboard address. */
export const leaderboardHref = (slug) => `#/bounty/${encodeURIComponent(slug)}/leaderboard`;
/** An account's address. */
export const profileHref = (handle) => `#/u/${encodeURIComponent(handle)}`;

/** Spelled-out counts for the small labels: 1 place, 2 places. With `withCount`, the count comes with it. */
export const plural = (n, one, many = `${one}s`, withCount = false) =>
  withCount ? `${n} ${n === 1 ? one : many}` : n === 1 ? one : many;

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const COUNT = new Intl.NumberFormat('en-US');
const DECIMAL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const LONG_DATE = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const toNumber = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A USD string or number as `$716.50`; an integer shows no cents cell. */
export function money(value, { cents = 'auto' } = {}) {
  const n = toNumber(value);
  if (n === null) return '—';
  return MONEY.format(n);
}

/** A count with thousands separators: 12,379. */
export function count(value) {
  const n = toNumber(value);
  return n === null ? '—' : COUNT.format(n);
}

/** A small ratio: a 0.5 to 1 chance is 50%. */
export function percent(ratio) {
  const n = toNumber(ratio);
  return n === null ? '—' : `${DECIMAL.format(n * 100)}%`;
}

/** A timestamp as `17 Nov 2026`, in UTC like the API. */
export function longDate(iso) {
  const t = iso ? new Date(iso) : null;
  return t && Number.isFinite(t.valueOf()) ? LONG_DATE.format(t) : '—';
}

/** A timestamp as `17 Nov`, with the hour as the title. */
export function shortDate(iso, title = true) {
  const t = iso ? new Date(iso) : null;
  if (!t || !Number.isFinite(t.valueOf())) return '—';
  const text = SHORT_DATE.format(t);
  return title ? `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(text)}</time>` : esc(text);
}

/** The distance from now to `iso`, in whole words: `2d 4h`, `35m`, or `closed`. */
export function timeLeft(iso, now = Date.now()) {
  const target = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(target)) return '—';
  const ms = target - now;
  if (ms <= 0) return 'closed';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(minutes, 1)}m`;
}

/** Whether an ISO deadline still lies ahead. */
export const isOpen = (iso, now = Date.now()) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) && t > now;
};

/** A value from the openapi's units (`micro`, `usd`) as a display string: 950587 micro is 95.06%. */
export function micro(value) {
  const n = toNumber(value);
  return n === null ? '—' : DECIMAL.format(n / 10_000);
}

/** A whole number that arrived as an integer keeps its digits; anything else keeps two decimals. */
export function integer(value) {
  const n = toNumber(value);
  if (n === null) return '—';
  return Number.isInteger(n) ? COUNT.format(n) : DECIMAL.format(n);
}

// ---------------------------------------------------------------- fragments

/** An inline SVG from an icon path, 1.5px strokes in currentColor. */
export function icon(d, { size = 18, fill = false } = {}) {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${fill ? ' fill="currentColor" stroke="none"' : ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'}>${d}</svg>`;
}

/** The small caps eyebrow above a heading. */
export const eyebrow = (text) => `<p class="eyebrow">${esc(text)}</p>`;

/** A pill: a status or a tag, never the only carrier of meaning. */
export const pill = (text, tone = '') => `<span class="pill${tone ? ` pill--${tone}` : ''}">${esc(text)}</span>`;

/** The state a bounty is in, read from its deadline first and its status second. */
export function stateOf(bounty, now = Date.now()) {
  if (bounty.status === 'resolved') return 'resolved';
  if (isOpen(bounty.deadline, now)) return 'open';
  if (bounty.placementsHeld) return 'judging';
  return 'closed';
}

const STATE_LABEL = { open: 'Taking entries', judging: 'Judging', closed: 'Entries closed', resolved: 'Results in' };

export const statePill = (state) => pill(STATE_LABEL[state] ?? state, `state-${state}`);

/** The avatar of an account, or its initial in a circle. The API's images load cross-origin. */
export function avatar(src, handle, { size = 32, cls = '' } = {}) {
  const initial = String(handle ?? '?').slice(0, 1).toUpperCase();
  const extra = cls ? ` ${cls}` : '';
  if (!src) {
    return `<span class="avatar avatar--letter${extra}" style="--s:${size}px" aria-hidden="true">${esc(initial)}</span>`;
  }
  return `<img class="avatar${extra}" style="--s:${size}px" src="${esc(absoluteImage(src))}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" crossorigin="anonymous">`;
}

/** An API image path as an absolute https://make.fun URL. */
export function absoluteImage(path) {
  const value = String(path ?? '');
  if (/^https?:\/\//i.test(value)) return value;
  return `https://make.fun${value.startsWith('/') ? '' : '/'}${value}`;
}

// ---------------------------------------------------------------- states

/** The skeleton of a page: an eyebrow, a title and rows, all in the space the data takes. */
export function loading(kind) {
  const bar = (w) => `<span class="sk" style="--w:${w}"></span>`;
  if (kind === 'board') {
    return `
      <section class="page" aria-busy="true">
        <p class="eyebrow">The board</p>
        <h1 class="title">Loading the board<span class="dots" aria-hidden="true"></span></h1>
        <p class="lede">${bar('46ch')}</p>
        <div class="stats">${Array.from({ length: 4 }, () => `<div class="stat"><span class="sk sk--sm"></span><span class="sk sk--lg"></span></div>`).join('')}</div>
        <ul class="rows" aria-hidden="true">${Array.from({ length: 6 }, () => `<li class="row"><span class="sk sk--lg"></span><span class="sk"></span></li>`).join('')}</ul>
        <p class="sr-only" role="status">Loading the board</p>
      </section>`;
  }
  if (kind === 'leaderboard') {
    return `
      <section class="page" aria-busy="true">
        <p class="eyebrow">Leaderboard</p>
        <h1 class="title">Loading standings<span class="dots" aria-hidden="true"></span></h1>
        <p class="lede">${bar('40ch')}</p>
        <div class="table-wrap" aria-hidden="true"><table class="table"><tbody>${Array.from({ length: 8 }, () => `<tr><td><span class="sk sk--sm"></span></td><td><span class="sk"></span></td><td><span class="sk sk--sm"></span></td></tr>`).join('')}</tbody></table></div>
        <p class="sr-only" role="status">Loading the leaderboard</p>
      </section>`;
  }
  if (kind === 'profile') {
    return `
      <section class="page" aria-busy="true">
        <div class="profile-head"><span class="sk sk--avatar"></span><div class="profile-id"><span class="sk sk--sm"></span><span class="sk sk--lg"></span></div></div>
        <p class="lede">${bar('52ch')}</p>
        <div class="stats">${Array.from({ length: 4 }, () => `<div class="stat"><span class="sk sk--sm"></span><span class="sk sk--lg"></span></div>`).join('')}</div>
        <ul class="rows" aria-hidden="true">${Array.from({ length: 4 }, () => `<li class="row"><span class="sk sk--lg"></span><span class="sk"></span></li>`).join('')}</ul>
        <p class="sr-only" role="status">Loading the profile</p>
      </section>`;
  }
  return `
    <section class="page" aria-busy="true">
      <p class="eyebrow">Bounty</p>
      <h1 class="title"><span class="sk sk--xl"></span></h1>
      <p class="lede">${bar('58ch')}</p>
      <div class="two-col"><div class="card card--pad"><span class="sk sk--lg"></span><span class="sk"></span><span class="sk"></span></div><div class="card card--pad"><span class="sk sk--sm"></span><span class="sk sk--lg"></span></div></div>
      <p class="sr-only" role="status">Loading the bounty</p>
    </section>`;
}

/**
 * An error a reader can act on: what failed, what to do, and a button that asks again.
 * `retry` is one of 'board', 'bounty', 'leaderboard', 'profile'.
 */
export function errorState({ title, message, status, retry, back = true }) {
  const detail = status === 404
    ? 'There is nothing at this address. It may have been renamed, or it may never have existed.'
    : message ?? 'make.fun did not answer as expected.';
  return `
    <section class="page narrow" role="alert">
      ${eyebrow('Something went wrong')}
      <h1 class="title">${esc(title)}</h1>
      <p class="lede">${esc(detail)}</p>
      <div class="actions">
        <button class="btn btn--primary" type="button" data-retry="${esc(retry)}">Try again</button>
        ${back ? '<a class="btn" href="#/">Back to the board</a>' : ''}
      </div>
      ${status ? `<p class="fine">Status ${esc(status)}.</p>` : ''}
    </section>`;
}

/** A page with nothing to show, said plainly. */
export function emptyState({ title, message, action = '' }) {
  return `
    <section class="page narrow">
      ${eyebrow('Nothing here yet')}
      <h1 class="title">${esc(title)}</h1>
      <p class="lede">${esc(message)}</p>
      ${action ? `<div class="actions">${action}</div>` : ''}
    </section>`;
}
