// make.fun's public API, read over GET only from https://make.fun/api.
//
// Every answer is kept in memory for a couple of minutes and revalidated with the ETag the
// API sends, so walking back to a page you already read costs one cheap 304 instead of a
// fresh payload. Two callers of the same path share the request that is in flight.

const API = 'https://make.fun/api';

/** Reads a reader asked to try again: the next read of that path goes to the network, never to the failure memory. */
const forced = new Set();

/** How long an answer is served from memory before it is revalidated with its ETag. */
const FRESH_MS = 120_000;
/** How long a failed read is left alone before the cache goes to the network again. */
const FAILED_MS = 15_000;
/** How often a board that is still being built (503 with Retry-After) is asked again. */
const PENDING_TRIES = 3;

/** path -> { at, etag, body } for a read that answered, or { failedAt, wait } while one is in flight or failed. */
const cache = new Map();

/** An API answer that is not a 2xx, with what the API said when it said anything. */
export class ApiError extends Error {
  constructor(message, { status = 0, retryAfter = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** The message in an API error body ({ success: false, error: [{ message }] }), or null. */
function problemOf(text) {
  try {
    const body = JSON.parse(text);
    const first = Array.isArray(body?.error) ? body.error[0] : null;
    return typeof first?.message === 'string' ? first.message : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One GET, asking again while the API says a board is still being built. */
async function send(path, headers) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(API + path, { method: 'GET', headers, credentials: 'omit', mode: 'cors' });
    } catch {
      throw new ApiError('Could not reach make.fun. Check your connection and try again.');
    }
    if ((response.status === 503 || response.status === 429) && attempt < PENDING_TRIES) {
      const after = Number(response.headers.get('retry-after'));
      await sleep(Math.min(Number.isFinite(after) && after > 0 ? after : 2, 4) * 1000);
      continue;
    }
    return response;
  }
}

/**
 * A GET of `path` (from the API root, starting with /), as parsed JSON. An answer younger
 * than FRESH_MS is served from memory; an older one goes back with its ETag as
 * If-None-Match, and a 304 keeps the stored body.
 */
export function get(path, { force = false } = {}) {
  const mustAsk = force || forced.delete(path);
  const hit = cache.get(path);
  const now = Date.now();
  if (hit === undefined) return load(path, null);
  if (hit.wait !== undefined) {
    if (!mustAsk && now - hit.failedAt < FAILED_MS) return hit.wait;
    return load(path, null);
  }
  if (!mustAsk && now - hit.at < FRESH_MS) return Promise.resolve(hit.body);
  return load(path, hit.etag);
}

/** The target of a retry: `kind` is the route's name, and `subject` its slug or handle. */
function pathFor(kind, subject) {
  if (kind === 'board') return '/competitions?status=open&activity=times&limit=100';
  if (kind === 'bounty') return `/competitions/${encodeURIComponent(subject)}`;
  if (kind === 'leaderboard') return `/competitions/${encodeURIComponent(subject)}/leaderboard?rows=first`;
  if (kind === 'profile') return `/profiles/${encodeURIComponent(subject)}`;
  return null;
}

/**
 * Mark a route's read to be taken from the network next time, so a reader's "Try again" asks make.fun again
 * instead of replaying the failure it remembers.
 */
export function retry(kind, subject) {
  const path = pathFor(kind, subject);
  if (path) forced.add(path);
}

/** Runs the request for `path`, shared with every caller that asks while it is in flight. */
function load(path, etag) {
  const stored = cache.get(path)?.body;
  const headers = typeof etag === 'string' && etag !== '' ? { 'If-None-Match': etag } : {};
  const wait = (async () => {
    const response = await send(path, headers);
    if (response.status === 304 && stored !== undefined) {
      cache.set(path, { at: Date.now(), etag, body: stored });
      return stored;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(problemOf(text) ?? `make.fun answered ${response.status}.`, {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
      });
    }
    const body = await response.json();
    cache.set(path, { at: Date.now(), etag: response.headers.get('etag'), body });
    return body;
  })();
  const inFlight = { failedAt: Date.now(), wait };
  cache.set(path, inFlight);
  // Whoever awaits `wait` gets the rejection; this keeps the cache from holding a promise
  // nothing listens to once that caller has moved on.
  wait.catch(() => {
    if (cache.get(path) === inFlight) cache.set(path, { failedAt: Date.now(), wait });
  });
  return wait;
}

// ---------------------------------------------------------------- the reads

/** The open bounties, each with its live pot and fee bookkeeping: { items, next_cursor }. */
export const board = () => get('/competitions?status=open&activity=times&limit=100');

/** The bounties whose results are published: { items }. */
export const results = () => get('/competitions?status=resolved&activity=times&limit=100');

/** One bounty by slug. */
export const bounty = (slug) => get(`/competitions/${encodeURIComponent(slug)}`);

/** One bounty's board: `rows=first` paints a first page small, ten whole rows and the rest slim. */
export const leaderboard = (slug) => get(`/competitions/${encodeURIComponent(slug)}/leaderboard?rows=first`);

/** One account's public profile: its record, links and entries. */
export const profile = (handle) => get(`/profiles/${encodeURIComponent(handle)}`);
