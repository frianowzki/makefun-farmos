/* Formatting: money, counts, dates and the two clocks the board runs on.
   Everything takes the API's own values (numbers, decimal strings, ISO times) and never guesses. */

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "$740", "$0.50": a dollar amount from a number or a decimal string, two decimals only when it needs them. */
export function usd(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return '—';
  return money.format(n);
}

/** A count with thin-space grouping: 1,284. */
export function count(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? whole.format(n) : '—';
}

/** A number of bytes as MiB with one decimal, for a dossier's size. */
export function bytes(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A rate the API keeps in millionths, as a percentage with two decimals: 956066 → "95.61%". */
export function rate(micro) {
  const n = typeof micro === 'number' ? micro : Number.parseFloat(String(micro ?? ''));
  if (!Number.isFinite(n)) return '—';
  return `${(n / 10_000).toFixed(2)}%`;
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DAY_TIME = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

/** "17 Nov 2026", in UTC so every reader sees the same day. */
export function day(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DAY.format(d);
}

/** "17 Nov 2026, 12:30 UTC". */
export function dayTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${DAY_TIME.format(d)} UTC`;
}

/** Milliseconds left until `iso` at `now`, or a negative number once it has passed. */
export function msLeft(iso, now = Date.now()) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? NaN : d.getTime() - now;
}

/** "2d 06h", "3h 12m", "04:31", "closed": the time left, at the precision the distance deserves. */
export function remaining(iso, now = Date.now()) {
  const ms = msLeft(iso, now);
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'closed';
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Whether a bounty's deadline is still ahead: the only honest test of "takes entries". */
export function stillTaking(from, iso, now = Date.now()) {
  if (from.acceptingSubmissions === false) return false;
  return msLeft(iso, now) > 0;
}

/** The status a reader cares about: live past its deadline reads "closing", not "open". */
export function liveStatus(bounty, now = Date.now()) {
  const iso = bounty.deadline;
  if (stillTaking(bounty, iso, now)) return 'live';
  const status = String(bounty.status || '');
  if (status === 'resolved') return 'resolved';
  if (status === 'closed' || status === 'draft') return 'closed';
  return 'closed';
}

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text for an HTML string: the five characters that matter, everything else as written. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => escapeMap[ch]);
}

/** An inline run of text with `code`, **strong** and bare links kept: the API's prose is trusted for
 *  its words, never for its markup, so only these three are read and all of it is escaped first. */
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2">$1</a>');
}

/** A bounty's prose, as safe HTML: headings, lists, paragraphs and quotes, nothing else.
 *  `limit` stops after that many blocks, for a description that should stay short. */
export function prose(markdown, limit = 0) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let para = [];
  let paraKind = '';

  const flushPara = () => {
    if (para.length === 0) return;
    const body = para.join(' ');
    out.push(paraKind === 'quote' ? `<blockquote><p>${inline(body)}</p></blockquote>` : `<p>${inline(body)}</p>`);
    para = [];
    paraKind = '';
  };
  const flushList = () => {
    if (list === null) return;
    out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const stop = () => limit > 0 && out.length >= limit;

  for (const raw of lines) {
    if (stop()) break;
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length <= 2 ? 'h2' : 'h4';
      out.push(`<${level}>${inline(heading[2])}</${level}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushList();
      if (paraKind !== 'quote') flushPara();
      paraKind = 'quote';
      para.push(line.replace(/^>\s?/, ''));
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list === null || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    if (/^\s*[-*]\s*$/.test(line)) {
      out.push('<hr>');
      continue;
    }
    if (paraKind === 'quote') flushPara();
    if (list !== null) flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('');
}

/** The first sentence-ish run of a description, for a card: its first paragraph, cut short. */
export function gist(markdown, max = 168) {
  const first = String(markdown || '').split(/\n\s*\n/).map((s) => s.trim()).find((s) => s !== '' && !s.startsWith('#'));
  if (!first) return '';
  const clean = first.replace(/^[-*]\s+/, '').replace(/[`*]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
