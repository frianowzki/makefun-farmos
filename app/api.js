// The API: make.fun's public board, read over GET only, with no credentials.

const API = 'https://make.fun/api';

/** An API failure a page can show: what was asked, and what came back. */
export class ApiError extends Error {
  constructor(message, { status = 0, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

/** GET a path under /api and parse the JSON, turning any failure into an ApiError with a readable reason. */
export async function get(path, signal) {
  const url = API + path;
  let res;
  try {
    res = await fetch(url, { signal, headers: { accept: 'application/json' }, mode: 'cors', credentials: 'omit' });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('make.fun could not be reached.', { path: `/api${path}` });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) throw new ApiError(`make.fun answered ${res.status}.`, { status: res.status, path: `/api${path}` });
  }
  if (!res.ok) {
    // The API's errors are {success:false, error:[{message, path?}]}.
    const first = Array.isArray(body?.error) ? body.error[0] : null;
    const why = first?.message ? String(first.message) : `make.fun answered ${res.status}.`;
    throw new ApiError(why, { status: res.status, path: `/api${path}` });
  }
  if (body === null) throw new ApiError('make.fun answered with something that is not JSON.', { status: res.status, path: `/api${path}` });
  return body;
}

/** Every open bounty: the board lists them a page at a time, so follow next_cursor to its end. */
export async function listBounties(signal) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ status: 'open', activity: 'times' });
    if (cursor) q.set('cursor', cursor);
    const data = await get(`/competitions?${q}`, signal);
    if (!Array.isArray(data?.items)) throw new ApiError('The board arrived without its bounties.', { path: `/api/competitions` });
    items.push(...data.items);
    cursor = data.next_cursor ?? null;
    if (!cursor) break;
  }
  return items;
}

export const getBounty = (slug, signal) => get(`/competitions/${encodeURIComponent(slug)}`, signal);

export const getLeaderboard = (slug, signal) => get(`/competitions/${encodeURIComponent(slug)}/leaderboard`, signal);

export const getProfile = (handle, signal) => get(`/profiles/${encodeURIComponent(handle.replace(/^@/, ''))}`, signal);

/** An API-supplied avatar's https URL; null when there is none or it names another scheme or origin. */
export function avatarUrl(profile) {
  for (const candidate of [profile?.avatar, profile?.image]) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      const url = new URL(candidate);
      // A relative picture route is make.fun's own; anything else must be the https URL the API gave.
      if (url.protocol === 'https:' || candidate.startsWith('/api/')) return url.protocol === 'https:' ? url.href : `https://make.fun${url.pathname}`;
    } catch {
      // Not a URL at all: skip it.
    }
  }
  return null;
}
