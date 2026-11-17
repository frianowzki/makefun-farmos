/* The four surfaces. Each view owns its own markup, its own live numbers and its own data
   attributes, so the checker can read exactly the figure the page shows beside its label. */

import { h, svg, clear, mount, beginLoad, endLoad } from './dom.js';
import { fetchBoardAll, fetchBounty, fetchRules, fetchLeaderboard, fetchProfile, apiUrl } from './api.js';
import { usd, count, bytes, rate, day, dayTime, remaining, msLeft, liveStatus, stillTaking, prose, gist, esc } from './format.js';

/* ---------------------------------------------------------------- pieces */

/** The numbers every board card carries, named once so the card and a checker agree. */
function moneyCells(bounty) {
  return [
    h('span', { class: 'cell', 'data-f': 'pot', 'data-o': bounty.slug }, h('b', { class: 'num' }, usd(bounty.potUsd)), ' live pot'),
    h('span', {
      class: 'cell',
      'data-f': 'fee',
      'data-o': bounty.slug,
    }, bounty.entryFeeUsd === null || bounty.entryFeeUsd === undefined ? 'no entry fee' : `${usd(bounty.entryFeeUsd)} to enter`),
    h('span', { class: 'cell', 'data-f': 'left', 'data-o': bounty.slug }, `closes in ${remaining(bounty.deadline)}`),
    h('span', { class: 'right cell', 'data-f': 'entries', 'data-o': bounty.slug }, `${count(bounty.submissionCount)} entries`),
  ];
}

function statusBadge(bounty) {
  const state = liveStatus(bounty);
  const word = state === 'live' ? 'live' : state === 'resolved' ? 'resolved' : 'closed';
  return h('span', { class: `badge ${state === 'live' ? 'live' : 'done'}`, 'data-f': 'status', 'data-o': bounty.slug }, word);
}

export function bountyCard(bounty) {
  const line = gist(bounty.description, 150);
  return h(
    'a',
    { class: 'card', href: `#/bounty/${encodeURIComponent(bounty.slug)}`, 'data-slug': bounty.slug },
    h('div', { class: 'meta' }, h('span', null, bounty.category || 'bounty'), statusBadge(bounty)),
    h('h3', null, bounty.title),
    line ? h('p', { class: 'dim', style: 'margin:8px 0 0;font-size:13px' }, line) : null,
    h('div', { class: 'foot' }, moneyCells(bounty)),
  );
}

/** A card-shaped skeleton: the same height as a card, so a load never shifts the grid. */
function cardSkeleton() {
  return h(
    'div',
    { class: 'skelcard', 'aria-hidden': 'true' },
    h('div', { class: 'skel bar', style: 'width:32%' }),
    h('div', { class: 'skel serif', style: 'width:82%' }),
    h('div', { class: 'skel line', style: 'width:94%;margin-top:14px' }),
    h('div', { class: 'skel line', style: 'width:60%' }),
  );
}

function summaryStrip(cells) {
  return h('div', { class: 'summary' }, cells.map(([label, value, attr, note]) =>
    h('div', null, h('div', { class: 'k' }, label), h('div', { class: 'v', 'data-f': attr }, value, note ? h('small', null, ` ${note}`) : null)),
  ));
}

/** An error with a retry that really asks again: the button re-runs the route's loader. */
export function errorPanel(message, onRetry) {
  const note = h('p', { 'data-f': 'error-message' }, message);
  return h(
    'div',
    { class: 'err', role: 'alert', 'data-f': 'error' },
    h('p', { class: 'eyebrow' }, 'Something went wrong'),
    h('h2', null, 'This page could not be read'),
    note,
    h('button', { class: 'btn primary', type: 'button', 'data-action': 'retry', onclick: onRetry }, 'Try again'),
  );
}

function head(eyebrow, title, lede) {
  return h('div', { class: 'head' }, h('p', { class: 'eyebrow' }, eyebrow), h('h1', null, title), lede ? h('p', { class: 'lede' }, lede) : null);
}

/* ---------------------------------------------------------------- the board */

/** The rows the live board draws: the API's open filter also lists bounties whose deadline has passed but
 *  whose results are not posted, so the board keeps only the ones still taking entries. */
function stillTakingEntries(items, now = Date.now()) {
  return items.filter((bounty) => stillTaking(bounty, bounty.deadline, now));
}

const BOARD_COPY = {
  open: {
    eyebrow: 'The board',
    title: 'Live bounties',
    lede: 'Every bounty still taking entries on make.fun, with its live pot, its entry fee and the time it has left. The pot is the reward plus every entry fee paid so far.',
    status: 'open',
    empty: 'No bounty is taking entries right now.',
  },
  closed: {
    eyebrow: 'The archive',
    title: 'Closed bounties',
    lede: 'Bounties whose deadline has passed, newest first. Their leaderboards stay readable.',
    status: 'closed',
    empty: 'No bounty has closed yet.',
  },
};

/** The header's four figures over the whole field: how many, what they are worth, how many entries,
 *  and the bounty that closes first. */
function boardTotals(items) {
  let pot = 0;
  let entries = 0;
  let soonest = null;
  for (const bounty of items) {
    pot += Number.parseFloat(bounty.potUsd ?? '0') || 0;
    entries += Number(bounty.submissionCount) || 0;
    const left = msLeft(bounty.deadline);
    if (left > 0 && (soonest === null || left < soonest.left)) soonest = { left, bounty };
  }
  return {
    bounties: items.length,
    pot,
    entries,
    soonest: soonest === null ? null : soonest.bounty,
  };
}

function summaryCells(totals) {
  return [
    ['Bounties on the board', h('span', { class: 'num' }, count(totals.bounties)), 'bounties'],
    ['Live pot', h('span', { class: 'num' }, usd(totals.pot)), 'pot'],
    ['Entries', h('span', { class: 'num' }, count(totals.entries)), 'entries'],
    ['Next to close', h('span', { 'data-f': 'soonest' }, totals.soonest ? remaining(totals.soonest.deadline) : '—'), 'soonest'],
  ];
}

/** The board: every bounty of one status, as cards, plus a summary over the whole field. */
export async function boardView(kind, { onRetry } = {}) {
  const copy = BOARD_COPY[kind];
  const summaryHost = h('div', null, summaryStrip([
    ['Bounties on the board', h('span', { class: 'skel bar', style: 'width:38px;display:inline-block' }), 'bounties'],
    ['Live pot', h('span', { class: 'skel bar', style: 'width:64px;display:inline-block' }), 'pot'],
    ['Entries', h('span', { class: 'skel bar', style: 'width:52px;display:inline-block' }), 'entries'],
    ['Next to close', h('span', { class: 'skel bar', style: 'width:48px;display:inline-block' }), 'soonest'],
  ]));
  const grid = h('div', { class: 'cards' });
  for (let i = 0; i < 6; i++) grid.appendChild(cardSkeleton());
  mount(h('div', null, head(copy.eyebrow, copy.title, copy.lede), summaryHost, grid));
  beginLoad();

  let items;
  try {
    items = await fetchBoardAll({ status: copy.status });
    if (kind === 'open') items = stillTakingEntries(items);
  } catch (err) {
    window.__error = err.message;
    endLoad();
    mount(errorPanel(err.message, () => onRetry()));
    return;
  }

  const totals = boardTotals(items);
  clear(summaryHost);
  summaryHost.appendChild(summaryStrip(summaryCells(totals)));

  clear(grid);
  if (items.length === 0) {
    grid.appendChild(h('div', { class: 'emptystate' }, copy.empty));
  } else {
    for (const bounty of items) grid.appendChild(bountyCard(bounty));
  }
  endLoad();
}

/* ---------------------------------------------------------------- one bounty */

function rewardRows(bounty) {
  const now = Array.isArray(bounty.rewardsNow) ? bounty.rewardsNow : [];
  const base = bounty.rewards || {};
  const rows = [];
  const total = Number.parseFloat(bounty.rewardAmount ?? '0') || 0;
  const totalNow = now.reduce((n, r) => n + (Number.parseFloat(r.amountUsd) || 0), 0);
  for (const r of now) {
    const original = Number.parseFloat(base[String(r.place)]) || 0;
    rows.push(
      h('tr', { 'data-f': 'reward-row', 'data-o': bounty.slug },
        h('td', null, `Place ${r.place}`),
        h('td', null, usd(original)),
        h('td', { 'data-f': 'reward-now' }, usd(r.amountUsd))),
    );
  }
  if (rows.length === 0) {
    for (const [place, amount] of Object.entries(base)) {
      rows.push(h('tr', null, h('td', null, `Place ${place}`), h('td', null, usd(amount)), h('td', null, usd(amount))));
    }
  }
  const foot = h('tfoot', null, h('tr', null, h('td', null, 'Total'), h('td', null, usd(total)), h('td', { 'data-f': 'reward-total' }, usd(totalNow || total))));
  return h(
    'table',
    { class: 'rewards', 'data-f': 'rewards' },
    h('thead', null, h('tr', null, h('th', null, 'Place'), h('th', null, 'Reward'), h('th', null, 'With fees'))),
    h('tbody', null, rows),
    foot,
  );
}

function moneyPanel(bounty) {
  const fee = bounty.entryFeeUsd;
  const feeLine = fee === null || fee === undefined
    ? h('span', { 'data-f': 'fee-none' }, 'none')
    : h('span', { 'data-f': 'fee' }, usd(fee));
  const kv = h(
    'dl',
    { class: 'kv' },
    h('dt', null, 'Entry fee'),
    h('dd', null, feeLine),
    h('dt', null, 'Fees paid'),
    h('dd', null, `${count(bounty.entryFeePayers)} × ${fee === null || fee === undefined ? usd(0) : usd(fee)}`),
    h('dt', null, 'Entries'),
    h('dd', { 'data-f': 'entries' }, count(bounty.submissionCount)),
    h('dt', null, 'Deadline'),
    h('dd', { 'data-f': 'deadline' }, dayTime(bounty.deadline)),
    h('dt', null, 'Closes in'),
    h('dd', { 'data-f': 'left' }, remaining(bounty.deadline)),
    h('dt', null, 'Status'),
    h('dd', { 'data-f': 'status' }, liveStatus(bounty)),
    h('dt', null, 'Opened'),
    h('dd', null, day(bounty.publishedAt || bounty.opensAt || bounty.deadline)),
    h('dt', null, 'Category'),
    h('dd', null, bounty.category || '—'),
  );
  return h(
    'aside',
    { class: 'panel', 'aria-label': 'Pot, fee and dates' },
    h('p', { class: 'eyebrow', 'data-f': 'pot-label' }, 'Live pot'),
    h('div', { class: 'pot', 'data-f': 'pot' }, usd(bounty.potUsd), h('small', null, 'USD')),
    h('p', { class: 'dim', style: 'margin:6px 0 0;font-size:13px' }, 'The reward plus every entry fee paid so far.'),
    kv,
    bounty.houseOnly ? h('p', { class: 'dim', style: 'font-size:13px;margin-top:14px' }, 'A house bounty: entries are make.fun’s own.') : null,
  );
}

function sidePanel(bounty) {
  const skills = Array.isArray(bounty.skills) ? bounty.skills : [];
  return h(
    'aside',
    { class: 'panel', 'aria-label': 'Rewards' },
    h('h2', null, 'Rewards'),
    rewardRows(bounty),
    skills.length > 0 ? h('div', { style: 'margin-top:16px' }, h('p', { class: 'eyebrow quiet' }, 'Skills'), h('div', { class: 'chips' }, skills.map((s) => h('span', { class: 'chip' }, s)))) : null,
  );
}

function linkPanel(bounty) {
  return h(
    'div',
    { class: 'panel' },
    h('p', { class: 'eyebrow quiet' }, 'Elsewhere'),
    h('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;margin-top:6px' },
      h('a', { class: 'btn', href: `#/bounty/${encodeURIComponent(bounty.slug)}/leaderboard` }, 'Leaderboard'),
      h('a', { class: 'btn', href: 'https://make.fun/bounty/' + encodeURIComponent(bounty.slug) }, 'On make.fun')),
  );
}

/** The bounty's page: summary in the head, the money and the dates in a column, the prose below. */
export async function bountyView(slug, { onRetry } = {}) {
  mount(h(
    'div',
    null,
    h('div', { class: 'head' },
      h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Board'), '/ bounty'),
      h('p', { class: 'eyebrow' }, 'Bounty'),
      h('h1', null, h('span', { class: 'skel serif', style: 'width:70%;display:block' })),
      h('p', { class: 'lede' }, h('span', { class: 'skel line', style: 'width:60%;display:block' }))),
    h('div', { class: 'grid2' },
      h('div', null,
        h('div', { class: 'panel' }, h('h2', null, 'About'), h('div', { class: 'skel line' }), h('div', { class: 'skel line', style: 'width:92%' }), h('div', { class: 'skel line', style: 'width:74%' }))),
      h('div', null, h('div', { class: 'panel' }, h('span', { class: 'skel serif', style: 'width:60%;display:block' }), h('div', { class: 'skel line', style: 'margin-top:16px' }), h('div', { class: 'skel line' })))),
  ));
  beginLoad();

  let bounty;
  try {
    bounty = await fetchBounty(slug);
  } catch (err) {
    window.__error = err.message;
    endLoad();
    mount(errorPanel(err.message, () => onRetry()));
    return;
  }

  const state = liveStatus(bounty);
  const badge = state === 'live' ? h('span', { class: 'badge live', 'data-f': 'status' }, 'live') : h('span', { class: 'badge done', 'data-f': 'status' }, state);
  const description = bounty.description || bounty.summary || '';
  const body = h('div', { class: 'prose', 'data-f': 'description' }, h('div', { html: prose(description) }));

  const rulesHost = h('div', { class: 'panel' },
    h('h2', null, 'Rules'),
    h('p', { class: 'dim', style: 'margin:0 0 12px;font-size:13px' }, 'The bounty’s own rules, as make.fun states them.'),
    h('button', { class: 'btn', type: 'button', 'data-action': 'rules', onclick: loadRules }, 'Read the rules'));

  async function loadRules(event) {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Reading the rules…';
    let full;
    try {
      full = await fetchRules(slug);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Read the rules';
      const problem = h('p', { class: 'dim', role: 'alert' }, err.message);
      rulesHost.appendChild(problem);
      return;
    }
    const text = full.rules || full.rulesNote?.text || '';
    button.remove();
    rulesHost.appendChild(h('div', { class: 'prose', 'data-f': 'rules', html: prose(text) }));
  }

  mount(h(
    'div',
    null,
    h('div', { class: 'head' },
      h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Board'), '/ ', h('span', null, bounty.category || 'bounty')),
      h('p', { class: 'eyebrow' }, bounty.category || 'Bounty'),
      h('h1', { 'data-f': 'title' }, bounty.title),
      h('p', { class: 'lede' }, bounty.summary || gist(description, 220)),
      h('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap' }, badge,
        h('span', { class: 'badge' }, `${count(bounty.submissionCount)} entries`),
        h('a', { class: 'btn', href: `#/bounty/${encodeURIComponent(slug)}/leaderboard` }, 'Leaderboard'))),
    h('div', { class: 'grid2' },
      h('div', null,
        h('div', { class: 'panel' }, h('h2', null, 'The bounty'), body),
        rulesHost),
      h('div', null, moneyPanel(bounty), sidePanel(bounty), linkPanel(bounty))),
  ));
  document.title = `${bounty.title} · FarmOS`;
  endLoad();
}

/* ---------------------------------------------------------------- leaderboard */

/** A leaderboard figure in its own unit. The API says how a column is kept: a rate in millionths, a
 *  size in bytes, a plain count. The unit is read from the column's `source`, never guessed from the value. */
function displayCell(row, column) {
  const shown = row.display && row.display[column.key] !== undefined ? row.display[column.key] : row.values ? row.values[column.key] : null;
  // An entry with a metric withheld sends null but spells it "n/a": that is the API saying there is no value,
  // so the page prints its own dash rather than treating the words as a number.
  if (shown === null || shown === undefined || String(shown).trim().toLowerCase() === 'n/a') return '—';
  const source = String(column.source || '');
  const asNumber = Number(shown);
  if (source.includes('bytes') || /\bbytes\b/i.test(column.title)) return bytes(asNumber);
  if (source.endsWith('_micro') || column.precision === 0 && source.includes('rate')) return rate(asNumber);
  return String(shown);
}

/** The unit a column is kept in, said in words: what the header cannot show, the caption does. */
function unitOf(column) {
  const source = String(column.source || '');
  if (source.includes('bytes') || /\bbytes\b/i.test(column.title)) return 'bytes';
  if (source.endsWith('_micro')) return 'millionths, shown as a percentage';
  return 'count';
}

function avatar(url, name) {
  if (!url) return h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const img = h('img', { class: 'avatar', alt: '', width: '26', height: '26', loading: 'lazy', decoding: 'async' });
  img.crossOrigin = 'anonymous';
  img.src = apiUrl(url);
  img.addEventListener('error', () => { img.replaceWith(h('span', { class: 'avatar', 'aria-hidden': 'true' })); }, { once: true });
  img.title = name;
  return img;
}

function leaderboardRow(row, columns) {
  const held = row.rank === null || row.rank === undefined;
  return h(
    'tr',
    { 'data-f': 'lb-row', 'data-o': String(row.submission_id || row.handle), class: held ? 'held' : null },
    h('td', { class: `rank${row.rank && row.rank <= 3 ? ' top' : ''}`, 'data-f': 'lb-rank' }, held ? '—' : String(row.rank)),
    h('td', { class: 'l' },
      h('div', { class: 'who' },
        avatar(row.image, row.handle),
        h('div', { style: 'min-width:0' },
          h('a', { href: `#/u/${encodeURIComponent(row.handle)}`, 'data-f': 'lb-handle' }, row.handle),
          h('span', { class: 't', 'data-f': 'lb-title' }, row.title || '')))),
    columns.map((column) => h('td', { 'data-f': 'lb-metric', 'data-col': column.key, 'data-o': String(row.submission_id || row.handle) }, displayCell(row, column))),
  );
}

export async function leaderboardView(slug, { onRetry } = {}) {
  mount(h(
    'div',
    null,
    h('div', { class: 'head' },
      h('p', { class: 'eyebrow' }, 'Leaderboard'),
      h('h1', null, h('span', { class: 'skel serif', style: 'width:56%;display:block' })),
      h('p', { class: 'lede' }, h('span', { class: 'skel line', style: 'width:44%;display:block' }))),
    h('div', { class: 'tablewrap' }, h('div', { style: 'padding:16px' }, h('div', { class: 'skel line' }), h('div', { class: 'skel line', style: 'width:88%' }), h('div', { class: 'skel line', style: 'width:70%' }))),
  ));
  beginLoad();

  let board;
  try {
    board = await fetchLeaderboard(slug);
  } catch (err) {
    window.__error = err.message;
    endLoad();
    mount(errorPanel(err.message, () => onRetry()));
    return;
  }

  const columns = (Array.isArray(board.columns) ? board.columns : []).filter((c) => !c.hidden);
  const rows = Array.isArray(board.entries) ? board.entries : [];
  const title = board.competition && board.competition.title ? board.competition.title : slug;
  const phase = board.phase && board.phase.title ? board.phase.title : 'Final';
  const head1 = h('div', { class: 'head' },
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Board'), ' / ', h('a', { href: `#/bounty/${encodeURIComponent(slug)}` }, title), ' / leaderboard'),
    h('p', { class: 'eyebrow' }, `${phase} results`),
    h('h1', { 'data-f': 'lb-title' }, title),
    h('p', { class: 'lede' }, `${count(rows.length)} ranked ${rows.length === 1 ? 'entry' : 'entries'}, by ${board.title || 'results'}${board.metrics_withheld ? '. Metric figures are withheld until the phase closes.' : '.'}`));

  const table = h('table', { class: 'lb', 'data-f': 'lb' },
    h('caption', null,
      h('span', null, `${count(rows.length)} rows. Rank key ${board.rank_key || 'rank'}${board.tie_break ? `, ties by ${board.tie_break.title} (${board.tie_break.better})` : ''}.`),
      h('span', { class: 'dim', style: 'display:block;margin-top:2px' }, columns.map((c) => `${c.title}: ${unitOf(c)}`).join(' · '))),
    h('thead', null, h('tr', null,
      h('th', { class: 'l' }, 'Place'),
      h('th', { class: 'l' }, 'Entrant'),
      columns.map((c) => h('th', { 'data-col-head': c.key, title: c.source || '' }, c.title)))),
    h('tbody', null, rows.length === 0
      ? [h('tr', null, h('td', { class: 'l', colspan: String(columns.length + 2) }, h('span', { class: 'dim' }, 'No ranked entries yet.')))]
      : rows.map((row) => leaderboardRow(row, columns))));

  mount(h('div', null, head1,
    h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px' },
      h('a', { class: 'btn', href: `#/bounty/${encodeURIComponent(slug)}` }, 'The bounty')),
    h('div', { class: 'tablewrap', 'data-f': 'lb-wrap' }, table)));
  document.title = `${title} leaderboard · FarmOS`;
  endLoad();
}

/* ---------------------------------------------------------------- profile */

export async function profileView(handle, { onRetry } = {}) {
  const shell = mount(h(
    'div',
    null,
    h('div', { class: 'profile-head' },
      h('span', { class: 'avatar big', 'aria-hidden': 'true' }),
      h('div', { style: 'min-width:0' },
        h('p', { class: 'eyebrow' }, 'Profile'),
        h('h1', null, h('span', { class: 'skel serif', style: 'width:220px;display:block' })))),
    h('div', { class: 'summary' }, [0, 1, 2, 3].map(() => h('div', null, h('div', { class: 'skel bar', style: 'width:52px' }), h('div', { class: 'skel serif', style: 'width:70px' })))),
    h('div', { class: 'tablewrap' }, h('div', { style: 'padding:16px' }, h('div', { class: 'skel line' }), h('div', { class: 'skel line', style: 'width:76%' }))),
  ));
  beginLoad();
  let profile;
  try {
    profile = await fetchProfile(handle);
  } catch (err) {
    window.__error = err.message;
    endLoad();
    mount(errorPanel(err.message, () => onRetry()));
    return;
  }

  const record = profile.record || {};
  const solutions = Array.isArray(profile.solutions) ? profile.solutions : [];
  const avatarNode = avatar(profile.avatar && profile.avatar.url ? profile.avatar.url : profile.image, profile.handle);
  avatarNode.classList.add('big');

  const stats = h('div', { class: 'summary', 'data-f': 'profile-stats' },
    h('div', null, h('div', { class: 'k' }, 'Bounties entered'), h('div', { class: 'v', 'data-f': 'entered' }, count(record.competitions_entered))),
    h('div', null, h('div', { class: 'k' }, 'Placed'), h('div', { class: 'v', 'data-f': 'placed' }, count(record.competitions_placed))),
    h('div', null, h('div', { class: 'k' }, 'Won'), h('div', { class: 'v', 'data-f': 'won' }, count(record.competitions_won))),
    h('div', null, h('div', { class: 'k' }, 'Prize money'), h('div', { class: 'v', 'data-f': 'prize' }, usd(record.prize_usd))));

  const list = h('ul', { class: 'entries', 'data-f': 'entries' }, solutions.map((s) =>
    h('li', { 'data-f': 'entry-row', 'data-o': s.submission_id },
      h('span', { class: 'es', 'data-f': 'entry-place' }, s.placement === null || s.placement === undefined ? '—' : `#${s.placement}`),
      h('span', { class: 'et' },
        h('a', { href: `#/bounty/${encodeURIComponent(s.competition && s.competition.slug ? s.competition.slug : '')}` }, s.title || 'Untitled entry'),
        h('span', { class: 'ec', style: 'display:block' }, `${s.competition ? s.competition.title : 'bounty'} · entered ${day(s.entered_at)}`)),
      h('span', { class: 'es dim', 'data-f': 'entry-score' }, s.score && s.score.display !== null && s.score.display !== undefined ? `${s.score.display} ${s.score.column ? s.score.column.title : ''}`.trim() : 'unscored'))));

  // shell is the skeleton's root div, which mount() put in the page region: clearing it keeps its place.
  clear(shell);
  for (const node of [
    h('div', { class: 'profile-head' },
      avatarNode,
      h('div', { style: 'min-width:0' },
        h('p', { class: 'eyebrow' }, profile.house ? 'House account' : 'Profile'),
        h('h1', { 'data-f': 'handle' }, `@${profile.handle}`),
        h('p', { class: 'who-sub' }, [
          profile.display_name ? `${profile.display_name} · ` : '',
          `joined ${day(profile.joined_at)}`,
          record.best_placement ? ` · best place #${record.best_placement}` : '',
        ].join('')))),
    stats,
    h('div', { class: 'panel' },
      h('p', { class: 'eyebrow quiet' }, `Entries (${count(solutions.length)})`),
      solutions.length === 0 ? h('p', { class: 'dim', style: 'margin:8px 0 0' }, 'No entries yet.') : list),
  ]) shell.appendChild(node);
  document.title = `@${profile.handle} · FarmOS`;
  endLoad();
}

export { esc };
