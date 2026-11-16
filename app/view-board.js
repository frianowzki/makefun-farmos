// #/ — the bounty board: every live bounty with its live pot, its entry fee where one is
// set, its time left and its entries, under a summary of what the board adds up to.

import { bountyHref, count, esc, eyebrow, money, plural, shortDate, timeLeft } from './ui.js';

/** The reward line's money, to the cent: the pot the API states, else the reward. */
const potOf = (b) => money(b.potUsd ?? b.rewardAmount);

/** The board's own sums, each over the rows it is drawn from. */
export function totalsOf(items) {
  const sum = (pick) => items.reduce((n, b) => n + (Number(pick(b)) || 0), 0);
  const soonest = items
    .filter((b) => b.deadline)
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))[0];
  return {
    live: items.length,
    pot: sum((b) => b.potUsd ?? b.rewardAmount),
    feesPaid: sum((b) => b.entryFeesUsd),
    entries: sum((b) => b.submissionCount),
    feeCharged: items.filter((b) => Number(b.entryFeeUsd) > 0).length,
    next: soonest ?? null,
  };
}

/** One row: the bounty's name and tags, then pot, fee, time left and entries. */
function row(b, now) {
  const tags = [b.category, ...(b.skills ?? []).slice(0, 2)].filter(Boolean);
  const fee = Number(b.entryFeeUsd) > 0 ? money(b.entryFeeUsd) : null;
  return `
    <li class="row">
      <a class="row__main" href="${esc(bountyHref(b.slug))}">
        <span class="row__title">${esc(b.title)}</span>
        <span class="row__meta">${tags.map((t) => `<span>${esc(t)}</span>`).join('<span class="sep" aria-hidden="true">·</span>')}${fee ? `<span class="sep" aria-hidden="true">·</span><span class="fee">${fee} to enter</span>` : ''}</span>
      </a>
      <span class="row__cell row__pot"><span class="row__k">Pot</span><span class="num">${potOf(b)}</span></span>
      <span class="row__cell row__fee"><span class="row__k">Entry fee</span><span>${fee ?? '<span class="muted">None</span>'}</span></span>
      <span class="row__cell row__left"><span class="row__k">Closes</span><span>${shortDate(b.deadline)}<span class="muted"> · ${esc(timeLeft(b.deadline, now))}</span></span></span>
      <span class="row__cell row__entries"><span class="row__k">${plural(b.submissionCount ?? 0, 'entry', 'entries')}</span><span class="num num--sm">${count(b.submissionCount)}</span></span>
    </li>`;
}

/** The whole board. `filter` narrows to bounties whose category matches, or all. */
export function boardView(data, { category = 'all', sort = 'deadline', now = Date.now() } = {}) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const totals = totalsOf(items);
  const categories = [...new Set(items.map((b) => b.category).filter(Boolean))].sort();
  const shown = sortRows(items.filter((b) => category === 'all' || b.category === category), sort);
  const next = totals.next
    ? `<a href="${esc(bountyHref(totals.next.slug))}">${esc(totals.next.title)}</a> closes in ${esc(timeLeft(totals.next.deadline, now))}`
    : 'No deadline ahead';

  return `
    <section class="page">
      ${eyebrow(`Open bounties · ${longStamp(now)}`)}
      <h1 class="title">The bounty board</h1>
      <p class="lede">${esc(plural(totals.live, 'live bounty', 'live bounties', true))}, ${money(totals.pot)} to share. Fees paid by entrants join each pot as they land.</p>

      <div class="stats" role="list">
        <div class="stat" role="listitem"><span class="stat__k">Live pot</span><span class="stat__v num">${money(totals.pot)}</span><span class="stat__s">${esc(plural(totals.feeCharged, 'bounty', 'bounties', true))} ${totals.feeCharged === 1 ? 'charges' : 'charge'} a fee · ${money(totals.feesPaid)} in fees so far</span></div>
        <div class="stat" role="listitem"><span class="stat__k">Entries</span><span class="stat__v num">${count(totals.entries)}</span><span class="stat__s">across ${esc(plural(totals.live, 'bounty', 'bounties', true))}</span></div>
        <div class="stat" role="listitem"><span class="stat__k">Next deadline</span><span class="stat__v">${totals.next ? esc(timeLeft(totals.next.deadline, now)) : '—'}</span><span class="stat__s">${next}</span></div>
      </div>

      <div class="toolbar" role="group" aria-label="Filter and sort the board">
        <span class="toolbar__label">Category</span>
        ${chip('all', 'All', category)}
        ${categories.map((c) => chip(c, c, category)).join('')}
        <span class="toolbar__spacer"></span>
        <label class="select"><span class="select__label">Sort</span><select data-sort>
          <option value="deadline"${sort === 'deadline' ? ' selected' : ''}>Closing soonest</option>
          <option value="pot"${sort === 'pot' ? ' selected' : ''}>Biggest pot</option>
          <option value="entries"${sort === 'entries' ? ' selected' : ''}>Most entries</option>
        </select></label>
      </div>

      ${shown.length === 0
        ? `<p class="empty">No open bounty in ${esc(category === 'all' ? 'this view' : category)} right now.</p>`
        : `<ul class="rows rows--board" aria-label="Open bounties">${shown.map((b) => row(b, now)).join('')}</ul>`}
      <p class="fine">Times are UTC. A bounty past its deadline can still read open until its results are published; the time left is what counts.</p>
    </section>`;
}

/** A filter chip: a link, so the choice survives a reload and a back button works. */
const chip = (value, label, current) =>
  `<a class="chip" href="#/?cat=${encodeURIComponent(value)}"${value === current ? ' aria-current="true"' : ''}>${esc(label)}</a>`;

/** The rows in the chosen order, never dropping one that has no value for it. */
export function sortRows(items, sort) {
  const by = {
    deadline: (a, b) => new Date(a.deadline ?? 0) - new Date(b.deadline ?? 0),
    pot: (a, b) => (Number(b.potUsd ?? b.rewardAmount) || 0) - (Number(a.potUsd ?? a.rewardAmount) || 0),
    entries: (a, b) => (b.submissionCount ?? 0) - (a.submissionCount ?? 0),
  }[sort] ?? (() => 0);
  return [...items].sort(by);
}

/** `17 Nov 2026 · 05:40 UTC`, the moment the board was drawn. */
function longStamp(now) {
  const d = new Date(now);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${day} · ${time} UTC`;
}
