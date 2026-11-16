// #/bounty/<slug>/leaderboard — one bounty's standings, every column the API gives, in the
// unit each column is in. A long board is paged, twenty rows at a time, from what the API
// sent rather than from a read per page.

import { avatar, bountyHref, esc, eyebrow, icon, integer, leaderboardHref, profileHref, shortDate, statePill } from './ui.js';

/** The unit a column's value is in, read from the API's own class of values. */
function unitOf(column) {
  const key = String(column.key ?? '');
  const source = String(column.source ?? '');
  if (key === 'bytes' || /\.bytes$/.test(source)) return 'bytes';
  if (key === 'valid' || /\.valid$/.test(source)) return 'count';
  if (/micro$/.test(key) || /micro$/.test(source) || /_low$|_high$/.test(key)) return 'micro';
  return 'number';
}

/** A value as its column's own display string, or one worked out from the numbers given. */
function cell(row, column) {
  const shown = row.display?.[column.key];
  if (typeof shown === 'string' && shown !== '') return shown;
  const value = row.values?.[column.key];
  if (value === null || value === undefined) return '—';
  if (unitOf(column) === 'bytes') return `${integer(value)} B`;
  return integer(value);
}

/** The unit caption under a column's name. */
function unitLabel(column) {
  switch (unitOf(column)) {
    case 'bytes':
      return 'bytes';
    case 'count':
      return 'count';
    case 'micro':
      return column.key.includes('low') ? 'low end' : column.key.includes('high') ? 'high end' : 'per 100';
    default:
      return '';
  }
}

/** The slim rows a `rows=first` board sends past its first ten: enough to page through. */
function slimRow(row) {
  const performance = row.performance ?? row.rank ?? null;
  return {
    rank: row.rank,
    ranks: { performance },
    prize_rank: row.prize_rank,
    submission_id: row.submission_id,
    handle: row.handle,
    title: row.title,
    baseline: row.baseline,
    house: row.house,
    received_at: row.received_at,
    status: row.judged === false ? 'not yet judged' : 'finished',
    values: { judge: row.value ?? null },
    display: { judge: row.display ?? '—' },
    interval: row.interval ?? null,
    slim: true,
  };
}

/** The board's rows in rank order: the ten whole rows, then the slim ones. */
export function rowsOf(data) {
  const whole = Array.isArray(data?.entries) ? data.entries : [];
  const slim = Array.isArray(data?.rest) ? data.rest.map(slimRow) : [];
  const all = [...whole, ...slim];
  all.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  return all;
}

const PAGE = 20;

/** The standings, with page `page` (0-based) of PAGE rows. */
export function leaderboardView(data, { page = 0 } = {}) {
  const all = rowsOf(data);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const at = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(at * PAGE, at * PAGE + PAGE);
  const columns = Array.isArray(data?.columns) && data.columns.length > 0
    ? data.columns
    : [{ key: 'judge', title: 'Score', source: '' }];
  const phase = data?.phase ?? {};
  const comp = data?.competition ?? {};
  const rankTitle = columns[0]?.title ?? 'Score';
  const base = leaderboardHref(comp.slug ?? '');

  const head = `
    <tr>
      <th scope="col" class="col-rank">Place</th>
      <th scope="col" class="col-entry">Entry</th>
      ${columns.map((c) => `<th scope="col" class="col-num"><span>${esc(c.title ?? c.key)}</span>${unitLabel(c) ? `<span class="th-unit">${esc(unitLabel(c))}</span>` : ''}</th>`).join('')}
      <th scope="col" class="col-date">Received</th>
    </tr>`;

  const body = slice
    .map((row) => {
      const handle = row.handle ?? '';
      const place = row.rank ?? row.ranks?.performance;
      const status = [row.house ? 'house' : '', row.baseline ? 'baseline' : ''].filter(Boolean).join(', ');
      return `
      <tr${row.slim ? ' class="is-slim"' : ''}>
        <td class="col-rank"><span class="place">${place === null || place === undefined ? '—' : esc(place)}</span></td>
        <td class="col-entry">
          <a class="entry" href="${esc(profileHref(handle))}">
            ${avatar(row.image, handle, { size: 28 })}
            <span class="entry__text"><span class="entry__title">${esc(row.title ?? handle)}</span><span class="entry__by">@${esc(handle)}${status ? ` <span class="entry__flag">${esc(status)}</span>` : ''}</span></span>
          </a>
        </td>
        ${columns.map((c) => `<td class="col-num num${c.key === 'judge' ? ' num--key' : ''}">${esc(cell(row, c))}</td>`).join('')}
        <td class="col-date">${shortDate(row.received_at)}</td>
      </tr>`;
    })
    .join('');

  const pageLink = (n, label) => {
    if (n < 0 || n >= pages) return '';
    return `<a class="btn btn--sm" href="${esc(base)}?page=${n}" data-page="${n}" rel="${n < at ? 'prev' : 'next'}">${label}</a>`;
  };

  return `
    <section class="page lb">
      <a class="crumb" href="${esc(bountyHref(comp.slug ?? ''))}">${icon('<path d="M19 12H5M11 18l-6-6 6-6"/>', { size: 16 })} ${esc(comp.title ?? 'The bounty')}</a>
      ${eyebrow(`Leaderboard${phase.title ? ` · ${esc(phase.title)} phase` : ''}`)}
      <h1 class="title">${esc(data?.title ?? 'Standings')}</h1>
      <p class="lede">${esc(rankTitle)} ranks the field${data?.tie_break ? `, then ${esc(data.tie_break.title?.toLowerCase() ?? 'the tie-break')}` : ''}. ${all.length ? `${all.length} entries on the board.` : ''}</p>

      <div class="lb-meta">
        ${statePill(phase.scores_visible === false || phase.placements_held ? 'judging' : comp.status === 'resolved' ? 'resolved' : 'open')}
        ${phase.scores_visible === false ? '<span class="pill pill--quiet">Scores held until the phase is finalized</span>' : ''}
        ${phase.ends_at ? `<span class="muted">Phase closes ${shortDate(phase.ends_at)}</span>` : ''}
        ${data?.harness_kind ? `<span class="muted">Harness ${esc(data.harness_kind)}</span>` : ''}
      </div>

      ${all.length === 0
        ? `<div class="card card--pad empty"><p><strong>No entries are listed yet.</strong></p><p class="muted">${phase.placements_held ? 'This bounty holds its places until its ranking phase is finalized, so scores stay hidden for now.' : 'The board is empty.'}</p></div>`
        : `<div class="table-wrap">
            <table class="table table--lb">
              <caption class="sr-only">Standings for ${esc(comp.title ?? 'this bounty')}, page ${at + 1} of ${pages}</caption>
              <thead>${head}</thead>
              <tbody>${body}</tbody>
            </table>
          </div>
          <nav class="pager" aria-label="Leaderboard pages">
            ${pageLink(at - 1, 'Previous')}
            <span class="pager__at">Page ${at + 1} of ${pages}<span class="muted"> · rows ${at * PAGE + 1}–${Math.min(all.length, (at + 1) * PAGE)} of ${all.length}</span></span>
            ${pageLink(at + 1, 'Next')}
          </nav>`}
      <p class="fine">Values are shown as make.fun states them for each column; a score per 100 is a win rate out of 100, and bytes are the entry's size. ${all.some((r) => r.slim) ? 'Rows past the first ten are the slim form the API sends for them, so only their standing score is shown.' : ''}</p>
    </section>`;
}
