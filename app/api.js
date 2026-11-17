/* Reading and shaping make.fun's public answers.
   Every request is a GET on https://make.fun/api. Answers are kept for a minute and revalidated with
   their ETag after that, so walking back and forth through the app costs no body when nothing changed. */

const ORIGIN = 'https://make.fun';
const TTL_MS = 60_000;

/** One shared store: url → { at, etag, value }. The answers are small JSON, so the map holds them whole. */
const store = new Map();
/** Requests in flight, so two views asking for the same board share one call. */
const pending = new Map();

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Resolves a path the API answers, like `/api/competitions?limit=30`. A path from an answer
 *  (`/api/avatars/…`) goes through here too, so no other origin is ever read. */
export function apiUrl(path) {
  return String(path).startsWith('http') ? String(path) : ORIGIN + path;
}

/** The API's error text, from its ApiError shape: { success:false, error:[{message}] }. */
function errorText(body, status) {
  const listed = body && Array.isArray(body.error) ? body.error : null;
  if (listed && listed.length > 0) return listed.map((e) => (e && e.message) || String(e)).join('; ');
  if (body && typeof body.message === 'string') return body.message;
  return status === 404 ? 'make.fun has nothing at this address' : `make.fun answered ${status}`;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text === '' ? null : JSON.parse(text);
  } catch {
    throw new ApiError('make.fun answered something that is not JSON', response.status);
  }
}

/** GET a JSON answer, cached and conditional. `force` skips the cache for a retry. */
export async function getJson(path, { force = false } = {}) {
  const url = apiUrl(path);
  const hit = store.get(url);
  const now = Date.now();
  if (!force && hit && now - hit.at < TTL_MS) return hit.value;
  const busy = pending.get(url);
  if (busy) return busy;

  const task = (async () => {
    const headers = { accept: 'application/json' };
    if (hit && hit.etag) headers['if-none-match'] = hit.etag;
    let response;
    try {
      response = await fetch(url, { method: 'GET', headers, mode: 'cors', credentials: 'omit' });
    } catch (err) {
      throw new ApiError(navigator.onLine === false ? 'You are offline: make.fun cannot be reached' : 'make.fun could not be reached from here', 0);
    }
    if (response.status === 304 && hit) {
      hit.at = Date.now();
      return hit.value;
    }
    const body = await readJson(response);
    if (!response.ok) throw new ApiError(errorText(body, response.status), response.status);
    store.set(url, { at: Date.now(), etag: response.headers.get('etag'), value: body });
    return body;
  })();

  pending.set(url, task);
  try {
    return await task;
  } finally {
    pending.delete(url);
  }
}

/* ---------------------------------------------------------------- board */

const BOARD_LIMIT = '30';

/** One page of the board. `status` is the API's own filter; the views decide what still takes entries
 *  by each bounty's deadline, since a closed bounty may read open until its results are posted. */
export function fetchBoard({ status = 'open', cursor = null, force = false } = {}) {
  let path = `/api/competitions?limit=${BOARD_LIMIT}&status=${status}&activity=times`;
  if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
  return getJson(path, { force }).then((body) => ({
    items: Array.isArray(body && body.items) ? body.items : [],
    nextCursor: typeof (body && body.next_cursor) === 'string' ? body.next_cursor : null,
  }));
}

/** Every board page, up to a sane ceiling, so the summary counts see the whole field. */
export async function fetchBoardAll({ status = 'open', force = false } = {}) {
  const seen = new Set();
  const items = [];
  let cursor = null;
  for (let page = 0; page < 12; page++) {
    const chunk = await fetchBoard({ status, cursor, force });
    for (const item of chunk.items) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      items.push(item);
    }
    cursor = chunk.nextCursor;
    if (!cursor || chunk.items.length === 0) break;
  }
  return items;
}

/** One bounty, without the entry list or the rules text: enough for the page's head, its money and its dates. */
export function fetchBounty(slug, { force = false } = {}) {
  return getJson(`/api/competitions/${encodeURIComponent(slug)}`, { force });
}

/** The same bounty with its rules text, read only when the reader opens them. */
export function fetchRules(slug, { force = false } = {}) {
  return getJson(`/api/competitions/${encodeURIComponent(slug)}?submissions=summary`, { force });
}

export function fetchLeaderboard(slug, { force = false } = {}) {
  return getJson(`/api/competitions/${encodeURIComponent(slug)}/leaderboard?rows=all`, { force });
}

export function fetchProfile(handle, { force = false } = {}) {
  return getJson(`/api/profiles/${encodeURIComponent(handle)}`, { force });
}
