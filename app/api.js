// Talking to make.fun: GET only, no credentials, one origin.
//
// Every call returns parsed JSON or throws an ApiError whose message is safe to put on screen.
// Failures are tagged so the view can tell a missing bounty from a network problem.

const BASE = 'https://make.fun/api';

export class ApiError extends Error {
  constructor(message, { status = 0, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

/** GET `path` under /api and parse it. `signal` lets a route cancel its own request. */
async function readJson(path, signal) {
  let res;
  try {
    res = await fetch(BASE + path, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('Could not reach make.fun. Check the connection and try again.', { path });
  }
  if (!res.ok) {
    const why =
      res.status === 404
        ? 'make.fun has nothing at that address.'
        : res.status === 429
          ? 'make.fun is rate limiting this browser. Wait a moment, then retry.'
          : `make.fun answered ${res.status} ${res.statusText || ''}`.trim() + '.';
    throw new ApiError(why, { status: res.status, path });
  }
  try {
    return await res.json();
  } catch {
    throw new ApiError('make.fun sent a reply that is not JSON.', { status: res.status, path });
  }
}

/** Every open bounty, with entry times. */
export function fetchBoard(signal) {
  return readJson('/competitions?status=open&activity=times', signal);
}

/** One bounty, by slug: rewards, rules, phases, the lot. */
export function fetchBounty(slug, signal) {
  return readJson(`/competitions/${encodeURIComponent(slug)}`, signal);
}

// The leaderboard is megabytes: roughly a megabyte gzipped for a popular bounty. It is fetched
// once per route visit (cached for a minute in memory, so paging and returning do not refetch) and
// the route only draws the rows it needs.
const lbCache = new Map();

export function fetchLeaderboard(slug, { signal, maxAgeMs = 60_000, rows = 'all' } = {}) {
  const key = `${slug}|${rows}`;
  const hit = lbCache.get(key);
  if (hit && hit.rows === rows && Date.now() - hit.at < maxAgeMs) return hit.body.then((b) => b);
  const body = readJson(`/competitions/${encodeURIComponent(slug)}/leaderboard?rows=${rows}`, signal).catch((err) => {
    lbCache.delete(key);
    throw err;
  });
  lbCache.set(key, { at: Date.now(), rows, body });
  return body;
}

/** A public profile, by handle. */
export function fetchProfile(handle, signal) {
  return readJson(`/profiles/${encodeURIComponent(handle)}`, signal);
}

/** An absolute URL for something the API named: it may be a path on make.fun or another origin. */
export function absolute(ref) {
  if (!ref) return '';
  try {
    return new URL(ref, BASE + '/').href;
  } catch {
    return '';
  }
}
