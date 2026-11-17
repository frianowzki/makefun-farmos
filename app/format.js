// Formatting: every number and date the pages show goes through here, so units stay honest.

const usd = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

/** A dollar amount from the API ('731.00', 0.5 or null) as '$731' or '$0.50'; '—' for none. */
export function money(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? usd(n) : '—';
}

/** A count as 1,044 or 12,629. */
export function count(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

/** Plain escape for text put into HTML. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '16 Nov 2026' in UTC. */
export function date(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** '16 Nov 2026, 18:00 UTC'. */
export function dateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date(iso)}, ${hh}:${mm} UTC`;
}

/** Time until an instant: '2d 6h', '5h 12m', '41m', or null once it has passed. */
export function till(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** '4m ago', '3h ago', '5d ago' for a past instant. */
export function ago(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60000) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 60 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

/**
 * A column's value as the API displays it, with a note when the number carries a unit the raw digits hide.
 * Values are shown exactly as `display` gives them — a signup count stays a count, never a percentage.
 */
export function columnValue(column, entry) {
  const shown = entry?.display?.[column.key];
  if (shown !== undefined && shown !== null && String(shown) !== '') return String(shown);
  const raw = entry?.values?.[column.key];
  if (raw === null || raw === undefined) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  const precision = Number(column?.precision);
  return Number.isFinite(precision) && precision > 0 ? n.toFixed(precision) : count(n);
}

/**
 * A rank key is a count of people ('signups', 'bytes', 'elo', 'judge win rate'...): say which, so a mileage
 * figure is never read as a percentage.
 */
const UNIT_NOTES = [
  [/signup/i, 'people who signed up'],
  [/win_rate|judge$/i, 'judge win-rate units'],
  [/elo/i, 'Elo points'],
  [/bytes|size/i, 'bytes'],
  [/score|points/i, 'points'],
  [/pnl/i, 'USDC'],
  [/cpu|time|ms|micro/i, 'scored units'],
];

export function unitNote(key) {
  const hit = UNIT_NOTES.find(([re]) => re.test(key ?? ''));
  return hit ? hit[1] : '';
}

/** A share of a maximum, 0 to 1. */
export function share(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** A markdown string (headings, paragraphs, lists, inline code, links to make.fun) as safe HTML. */
export function markdown(src) {
  if (typeof src !== 'string' || src.trim() === '') return '';
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, (_m, pre, url) => {
        let href = url;
        try {
          const u = new URL(url);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${pre}${url}`;
          href = u.href;
        } catch {
          return `${pre}${url}`;
        }
        return `${pre}<a href="${href}" rel="noopener noreferrer" target="_blank">${url}</a>`;
      });
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    if (head) {
      flushPara();
      flushList();
      const level = Math.min(3, Math.max(2, head[1].length));
      out.push(`<h${level}>${inline(head[2])}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      (list ??= []).push(bullet[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('');
}
