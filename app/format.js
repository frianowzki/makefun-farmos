// Turning API numbers and dates into the exact strings on screen. The verify script imports
// this module, so what it checks is what the app renders — never a second implementation.

/** Text safe for HTML text and quoted attributes. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Money as "$1,325" when the amount is whole, else "$0.50" — at least two decimals, and exactly
 * the decimals the amount has when it has more (never a rounded lie).
 */
export function usd(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const frac = /\.(\d+)/.exec(String(value))?.[1]?.length ?? 0;
  const digits = frac === 0 ? 0 : Math.max(2, frac);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A count with thousands separators: 10405 -> "10,405". */
export function count(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
}

/** 10405 -> "10.4k" for tight spots. */
export function short(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1000) return String(v);
  if (v < 100000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(v / 1000).toFixed(0)}k`;
}

const UTC = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' };

/** "Nov 17, 2026, 12:30 PM UTC" — dates in UTC so every reader sees the same instant. */
export function dateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleString('en-US', UTC)} UTC`;
}

/** Just the day: "Nov 17, 2026". */
export function day(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
}

/** Time from `now` (ms) to an ISO instant, coarse: "3d 4h left", "5h 12m left", "8m left", "closed". */
export function until(iso, now = Date.now()) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const ms = then - now;
  if (ms <= 0) return 'closed';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${Math.max(1, m)}m left`;
}

/** How far along a field is, 0-100, for the thin progress line. */
export function progress(startIso, endIso, now = Date.now()) {
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.min(100, Math.max(0, ((now - a) / (b - a)) * 100));
}

const SYMBOLS = { open: 'Open', closed: 'Closed', resolved: 'Resolved', draft: 'Draft', finished: 'Finished', running: 'Running' };

/** "open" -> "Open" for a status chip. */
export function statusLabel(status) {
  return SYMBOLS[String(status ?? '').toLowerCase()] ?? String(status ?? '—');
}

/**
 * A leaderboard cell as the API already printed it. `display` is the API's own formatting and is
 * preferred; a value with no display falls back to the raw number. Never rescaled: a count of
 * 288 signups stays 288, it is not turned into a percentage.
 */
export function cell(entry, key) {
  const shown = entry?.display?.[key];
  if (shown !== undefined && shown !== null && shown !== '') return String(shown);
  const raw = entry?.values?.[key];
  if (raw === undefined || raw === null) return '—';
  return String(raw);
}

/** Two letters for a placeholder avatar: "tidy-meteor-25" -> "TM". */
export function initials(handle) {
  const parts = String(handle ?? '').split(/[-_.\s]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const a = parts[0][0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] ?? '');
  return (a + b).toUpperCase();
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** Whether a hash path segment may be used as a slug (it is only ever interpolated into an API path). */
export const isSlug = (s) => typeof s === 'string' && SLUG.test(s);
export const isHandle = (s) => typeof s === 'string' && HANDLE.test(s);

/**
 * The bounty's rules are Markdown. This renders the subset make.fun actually writes — headings,
 * paragraphs, bullet and numbered lists, fenced code, inline code, bold, italic, links — into
 * escaped HTML, so nothing in a rule can inject markup.
 */
export function markdown(src) {
  const blocks = String(src ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of blocks) {
    const block = raw.trim();
    if (block === '') continue;
    if (block.startsWith('```')) {
      closeList();
      const body = block.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
      out.push(`<pre><code>${esc(body)}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(block);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullets = /^([-*+]|\d+\.)\s+/;
    if (bullets.test(block)) {
      const ordered = /^\d+\./.test(block);
      const want = ordered ? 'ol' : 'ul';
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      for (const line of block.split('\n')) {
        const item = line.replace(bullets, '').trim();
        if (item) out.push(`<li>${inline(item)}</li>`);
      }
      continue;
    }
    closeList();
    out.push(`<p>${inline(block.replace(/\n/g, ' '))}</p>`);
  }
  closeList();
  return out.join('');
}

/** Inline Markdown, escaped first so no source character survives as markup. */
function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener nofollow">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}
