// The four surfaces, each a function from API data to HTML. Everything user- or API-supplied is escaped.

import { icons } from './icons.js';
import { ago, columnValue, count, date, dateTime, esc, markdown, money, share, till, unitNote } from './format.js';
import { avatarUrl } from './api.js';

const lab = (text) => `<span class="lbl">${esc(text)}</span>`;

/** Bounty routes use the slug the API gives; the path segment is encoded exactly once. */
export const bountyHref = (slug) => `#/bounty/${encodeURIComponent(slug)}`;
export const leaderboardHref = (slug) => `#/bounty/${encodeURIComponent(slug)}/leaderboard`;
export const profileHref = (handle) => `#/u/${encodeURIComponent(handle)}`;

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** A time-left phrase, honest about a passed deadline. */
function timeLeft(deadline, now) {
  const left = till(deadline, now);
  return left === null ? 'Closed' : `${left} left`;
}

/** The entry fee: an amount when the bounty charges one, otherwise 'None'. */
const feeText = (b) => (b.entryFeeUsd === null || b.entryFeeUsd === undefined ? 'None' : money(b.entryFeeUsd));

/** One line of published text with inline code, bold and links, escaped; no surrounding <p>. */
const inline = (text) => markdown(text).replace(/^<p>|<\/p>$/g, '');

// ---------------------------------------------------------------- the board

export function boardView(items, now = Date.now()) {
  const ordered = [...items].sort((a, b) => new Date(b.publishedAt ?? 0) - new Date(a.publishedAt ?? 0));
  const received = ordered.reduce((n, b) => n + (Number(b.submissionCount) || 0), 0);
  const pot = ordered.reduce((n, b) => n + (Number(b.potUsd) || 0), 0);
  const withFee = ordered.filter((b) => b.entryFeeUsd !== null && b.entryFeeUsd !== undefined).length;
  const taking = ordered.filter((b) => till(b.deadline, now) !== null).length;

  const rows = ordered
    .map((b) => {
      const open = b.status === 'open' && till(b.deadline, now) !== null;
      const sub = [b.category ?? 'Bounty', b.sponsor?.name, b.resolution?.metric?.name].filter(Boolean).map(esc).join(' · ');
      return `
      <li>
        <a class="row" href="${bountyHref(b.slug)}">
          <span class="rowtitle">${esc(b.title)}</span>
          <span class="rowsub">${sub}</span>
          <span class="cell"><b class="num live">${money(b.potUsd ?? b.rewardAmount)}</b>${lab('Live pot')}</span>
          <span class="cell"><b class="num">${money(b.entryFeeUsd)}</b>${lab('Entry fee')}</span>
          <span class="cell"><b class="num">${count(b.submissionCount)}</b>${lab('Entries')}</span>
          <span class="cell"><b class="num">${esc(open ? timeLeft(b.deadline, now) : 'Closed')}</b>${lab(open ? `by ${date(b.deadline)}` : `on ${date(b.deadline)}`)}</span>
        </a>
      </li>`;
    })
    .join('');

  return `
  <div class="page">
    <header class="head">
      <p class="eyebrow">Bounty board</p>
      <h1>Work worth doing, paid in the open.</h1>
      <p class="lede">Every live make.fun bounty, newest first by the API's own clock, with the pot as it stands now: the reward plus the entry fees paid into it so far.</p>
      <ul class="stats">
        <li><span class="num">${count(ordered.length)}</span>${lab('Open bounties')}</li>
        <li><span class="num">${money(pot)}</span>${lab('Total live pot')}</li>
        <li><span class="num">${count(received)}</span>${lab('Entries received')}</li>
        <li><span class="num">${count(taking)}</span>${lab('Still taking entries')}</li>
        <li><span class="num">${count(withFee)}</span>${lab('With an entry fee')}</li>
      </ul>
    </header>
    ${ordered.length === 0 ? '<p class="note">No bounties are open right now.</p>' : `<ul class="board">${rows}</ul>`}
    <p class="note">Read from make.fun's public API, never written. Times are UTC.</p>
  </div>`;
}

// ---------------------------------------------------------------- one bounty

function rewardsList(b) {
  const rows = Array.isArray(b.rewardsNow) && b.rewardsNow.length > 0
    ? b.rewardsNow.map((r) => ({
        place: Number(r.place),
        amount: money(r.amountUsd),
        fee: Number(r.feeShareUsd) || 0,
      }))
    : Object.entries(b.rewards ?? {}).map(([place, amount]) => ({ place: Number(place), amount: money(amount), fee: 0 }));
  if (rows.length === 0) return '<p class="note">No places are listed for this bounty.</p>';
  // Places paying the same amount share one line: '$10 each for 4th–10th'.
  const lines = [];
  for (const r of rows) {
    const prev = lines[lines.length - 1];
    if (prev && prev.amount === r.amount && prev.fee === r.fee && r.place === prev.to + 1) prev.to = r.place;
    else lines.push({ amount: r.amount, fee: r.fee, from: r.place, to: r.place });
  }
  return `<ul class="rewards">${lines
    .map((l) => {
      const places = l.from === l.to ? `${ordinal(l.from)} place` : `${ordinal(l.from)}–${ordinal(l.to)}`;
      const amount = l.from === l.to ? l.amount : `${l.amount} each`;
      const fee = l.fee > 0 ? ` <small>+ ${esc(money(l.fee))} of fees</small>` : '';
      return `<li><span class="place">${esc(places)}</span><span class="amt">${esc(amount)}${fee}</span></li>`;
    })
    .join('')}</ul>`;
}

export function bountyView(b, now = Date.now()) {
  const closed = till(b.deadline, now) === null;
  const open = b.status === 'open' && !closed && b.acceptingSubmissions !== false;
  const metric = b.resolution?.metric ?? null;
  const fee = b.entryFeeUsd === null || b.entryFeeUsd === undefined ? null : Number(b.entryFeeUsd);
  const payers = Number(b.entryFeePayers) || 0;
  const feesIn = Number(b.entryFeesUsd) || 0;
  const skills = Array.isArray(b.skills) ? b.skills.slice(0, 10) : [];
  const phases = Array.isArray(b.phases) ? b.phases : [];
  const criteria = Array.isArray(b.resolution?.criteria) ? b.resolution.criteria : [];
  const baseline = b.baseline ?? null;
  const feeLine = fee === null || payers === 0
    ? 'No entry fees paid in yet.'
    : `${esc(money(feesIn))} of it from ${esc(count(payers))} ${payers === 1 ? 'entrant' : 'entrants'}.`;

  return `
  <div class="page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Board</a><span class="sep" aria-hidden="true">/</span><span>${esc(b.title)}</span></nav>
    <p class="eyebrow">${esc(b.category ?? 'Bounty')} · ${esc(open ? 'Open' : String(b.status ?? 'closed'))}</p>
    <h1>${esc(b.title)}</h1>
    <p class="lede">${esc(b.summary ?? '')}</p>
    <div class="split">
      <div>
        <p class="crumbs" style="margin:0 0 4px"><a href="${leaderboardHref(b.slug)}">See the leaderboard</a></p>
        <h2>Description</h2>
        <div class="prose">${markdown(b.description ?? '') || '<p>No description is published for this bounty.</p>'}</div>
        ${criteria.length ? `<h2>Rules</h2><ol class="rulelist">${criteria.map((c) => `<li>${inline(c)}</li>`).join('')}</ol>` : ''}
        ${b.resolution?.summary ? `<h2>How the result is decided</h2><div class="prose"><p>${esc(b.resolution.summary)}</p></div>` : ''}
        ${b.resolution?.tieBreak ? `<p class="note"><strong>Tie-break.</strong> ${esc(b.resolution.tieBreak)}</p>` : ''}
        ${
          phases.length
            ? `<h2>Phases</h2><div class="prose"><ul>${phases
                .map((p) => `<li><strong>${esc(p.title ?? p.key)}</strong>: ${esc(dateTime(p.startsAt))} to ${esc(dateTime(p.endsAt))}${p.scoresVisible === false ? ', scores published once it ends' : ''}</li>`)
                .join('')}</ul></div>`
            : ''
        }
        <h2>Rewards</h2>
        ${rewardsList(b)}
        ${skills.length ? `<h2>Skills</h2><ul class="tags">${skills.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      </div>
      <aside class="card potcard" aria-label="At a glance">
        <p class="eyebrow">Live pot</p>
        <span class="pot num">${money(b.potUsd ?? b.rewardAmount)}</span>
        <p class="sub">${feeLine}</p>
        <dl class="facts">
          <div><dt>Reward</dt><dd>${money(b.rewardAmount)}</dd></div>
          <div><dt>Entry fee</dt><dd>${esc(feeText(b))}</dd></div>
          <div><dt>Entries</dt><dd>${count(b.submissionCount)}</dd></div>
          <div><dt>Status</dt><dd>${esc(open ? 'Open' : String(b.status ?? 'closed'))}</dd></div>
          <div><dt>Deadline</dt><dd>${esc(dateTime(b.deadline))}</dd></div>
          <div><dt>Time left</dt><dd>${esc(open ? timeLeft(b.deadline, now) : 'Closed')}</dd></div>
          <div><dt>Published</dt><dd>${esc(date(b.publishedAt))}</dd></div>
          ${metric ? `<div><dt>Measured by</dt><dd>${esc(metric.name)}${metric.unit ? ` · ${esc(metric.unit)}` : ''}</dd></div>` : ''}
          ${baseline ? `<div><dt>${esc(baseline.label ?? 'Baseline')}</dt><dd>${esc(String(baseline.display ?? '—'))}${baseline.unit ? ` ${esc(baseline.unit)}` : ''}</dd></div>` : ''}
          ${b.sponsor?.name ? `<div><dt>Sponsor</dt><dd>${esc(b.sponsor.name)}</dd></div>` : ''}
        </dl>
        <a class="btn" href="${leaderboardHref(b.slug)}">${icons.trophy}Open leaderboard</a>
      </aside>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- leaderboard

export function leaderboardView(b, lb, now = Date.now()) {
  const columns = Array.isArray(lb.columns) ? lb.columns : [];
  const shown = columns.filter((c) => !c.hidden);
  const entries = Array.isArray(lb.entries) ? lb.entries : [];
  const rest = Array.isArray(lb.rest) ? lb.rest : [];
  const rankKey = lb.rank_key ?? columns[0]?.key ?? null;
  const rankColumn = shown.find((c) => c.key === rankKey) ?? null;
  const note = unitNote(rankKey);
  const top = entries.reduce((m, e) => Math.max(m, Number(e.values?.[rankKey]) || 0), 0);
  const phase = lb.phase ?? null;
  const resolution = b?.resolution ?? null;
  const showing = entries.length + rest.length;

  const headCells = shown
    .map((c) => (c.key === rankKey
      ? `<th scope="col">${esc(c.title)}<span class="sr"> (the ranking column)</span></th>`
      : `<th scope="col" class="n">${esc(c.title)}</th>`))
    .join('');

  const entryRows = entries
    .map((e) => {
      const v = Number(e.values?.[rankKey]);
      const bar = Number.isFinite(v) && top > 0 ? `<span class="bar" style="width:${Math.max(2, Math.round(share(v, top) * 120))}px"></span>` : '';
      const flags = [e.house ? 'house' : '', e.baseline ? 'baseline' : '', e.status && e.status !== 'finished' ? e.status : ''].filter(Boolean);
      const rankMoved = e.prize_rank && e.rank && e.prize_rank !== e.rank;
      return `
      <tr class="${Number(e.rank) <= 3 ? 'top' : ''}">
        <td class="rank">${esc(String(e.prize_rank ?? e.rank ?? '—'))}${rankMoved ? `<span class="meta">rank ${esc(String(e.rank))}</span>` : ''}</td>
        <td class="entrytitle-cell">
          ${e.handle ? `<a class="entrytitle" href="${profileHref(e.handle)}">${esc(e.handle)}</a>` : '<span class="entrytitle">—</span>'}
          <span class="meta">${esc([e.title, ...flags, e.received_at ? ago(e.received_at, now) : ''].filter(Boolean).join(' · '))}</span>
        </td>
        ${shown.map((c) => `<td${c.key === rankKey ? '' : ' class="n"'}>${esc(columnValue(c, e))}${c.key === rankKey ? bar : ''}</td>`).join('')}
      </tr>`;
    })
    .join('');

  const restRows = rest
    .slice(0, 100)
    .map((e) => {
      const value = e.display ?? (e.value === null || e.value === undefined ? '—' : String(e.value));
      return `<tr>
        <td class="rank">${esc(String(e.prize_rank ?? e.rank ?? '—'))}</td>
        <td class="entrytitle-cell">${e.handle ? `<a class="entrytitle" href="${profileHref(e.handle)}">${esc(e.handle)}</a>` : '<span class="entrytitle">—</span>'}<span class="meta">${esc(e.title ?? '')}</span></td>
        <td class="n" colspan="${Math.max(1, shown.length)}">${esc(String(value))}</td>
      </tr>`;
    })
    .join('');

  return `
  <div class="page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Board</a><span class="sep" aria-hidden="true">/</span><a href="${bountyHref(b?.slug ?? '')}">${esc(b?.title ?? 'Bounty')}</a><span class="sep" aria-hidden="true">/</span><span>Leaderboard</span></nav>
    <header class="head">
      <p class="eyebrow">Leaderboard</p>
      <h1>${esc(lb.title ?? `${b?.title ?? 'Bounty'}: results`)}</h1>
      <p class="lede">${
        rankColumn
          ? `Ranked by <strong>${esc(rankColumn.title)}</strong>${resolution?.metric?.unit ? `, measured in ${esc(resolution.metric.unit)}` : ''}${resolution?.metric?.better ? `; ${esc(resolution.metric.better)} is better` : ''}.`
          : 'The columns exactly as make.fun publishes them.'
      }</p>
      <ul class="stats">
        <li><span class="num">${count(showing)}</span>${lab('Entries shown')}</li>
        ${phase ? `<li><span class="num">${esc(String(phase.title ?? phase.key))}</span>${lab('Phase')}</li>` : ''}
        ${rankColumn && entries[0] ? `<li><span class="num">${esc(columnValue(rankColumn, entries[0]))}</span>${lab(`Best ${rankColumn.title}`)}</li>` : ''}
        ${entries[0]?.handle ? `<li><span class="num">${esc(entries[0].handle)}</span>${lab('Leading')}</li>` : ''}
      </ul>
    </header>
    ${note ? `<p class="note" style="margin:0 0 14px"><strong>Units.</strong> Each column is shown as make.fun publishes it${rankColumn ? `, so “${esc(rankColumn.title)}” counts ${esc(note)}` : ''}.</p>` : ''}
    ${
      showing === 0
        ? `<div class="card"><p style="margin:0">This board has no entries yet.${phase?.scoresVisible === false ? ' Its scores are published once the phase ends.' : ''}</p></div>`
        : `<div class="tablewrap"><div class="tscroll"><table>
            <caption>${esc(lb.competition?.title ?? b?.title ?? '')}</caption>
            <thead><tr><th scope="col" class="rank">#</th><th scope="col">Entry</th>${headCells}</tr></thead>
            <tbody>${entryRows}${restRows}</tbody>
          </table></div></div>
          ${rest.length > 100 ? `<p class="note">${esc(count(rest.length - 100))} further entries are ranked on make.fun's own board.</p>` : ''}`
    }
    ${phase?.scoresVisible === false ? '<p class="note">This phase publishes its scores only once it ends.</p>' : ''}
    <p class="note">Live from make.fun's public API. Ties break on ${esc(b?.leaderboard?.tieBreak?.title ?? resolution?.tieBreak ?? 'the published tie-break')}.</p>
  </div>`;
}

// ---------------------------------------------------------------- profile

export function profileView(p, now = Date.now()) {
  const handle = p.handle ?? '';
  const name = p.display_name && p.display_name !== handle ? p.display_name : null;
  const record = p.record ?? {};
  const solutions = Array.isArray(p.solutions) ? p.solutions : [];
  const avatar = avatarUrl(p);
  const initial = (handle.replace(/[^A-Za-z0-9]/g, '')[0] ?? '?').toUpperCase();
  const entries = [...solutions].sort((a, b) => new Date(b.entered_at ?? 0) - new Date(a.entered_at ?? 0));

  const rows = entries
    .map((s) => {
      const c = s.competition ?? {};
      const score = s.score ?? null;
      const meta = [c.title ?? c.slug, s.placement ? `placed ${s.placement}` : '', s.prize_usd ? `${money(s.prize_usd)} won` : '', s.entered_at ? `entered ${ago(s.entered_at, now)}` : '', s.artifact?.noun ?? ''];
      return `
        <li class="entry">
          <a href="${bountyHref(c.slug)}">${esc(s.title ?? 'Untitled entry')}</a>
          <span class="score">${score?.display ? `<b>${esc(String(score.display))}</b>${lab(score.column?.title ?? 'Score')}` : `<b>—</b>${lab('No score yet')}`}</span>
          <span class="meta">${esc(meta.filter(Boolean).join(' · '))}</span>
        </li>`;
    })
    .join('');

  return `
  <div class="page">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Board</a><span class="sep" aria-hidden="true">/</span><span>@${esc(handle)}</span></nav>
    <header class="head">
      <div class="phead">
        ${
          avatar
            ? `<img class="avatar" src="${esc(avatar)}" alt="" width="72" height="72" loading="lazy" decoding="async" crossorigin="anonymous" referrerpolicy="no-referrer">`
            : `<span class="avatar letter" aria-hidden="true">${esc(initial)}</span>`
        }
        <div>
          <p class="eyebrow">Maker${p.house ? ' · house' : ''}</p>
          <h1>@${esc(handle)}</h1>
          ${name ? `<p class="lede" style="margin:0">${esc(name)}</p>` : ''}
        </div>
      </div>
      ${p.bio ? `<p class="lede" style="margin-top:14px">${esc(p.bio)}</p>` : ''}
      <ul class="stats">
        <li><span class="num">${count(record.competitions_entered)}</span>${lab('Bounties entered')}</li>
        <li><span class="num">${count(record.competitions_placed)}</span>${lab('Times placed')}</li>
        <li><span class="num">${count(record.competitions_won)}</span>${lab('Wins')}</li>
        <li><span class="num">${count(record.podium_finishes)}</span>${lab('Podiums')}</li>
        <li><span class="num">${money(record.prize_usd ?? 0)}</span>${lab('Prizes won')}</li>
      </ul>
    </header>
    <h2 style="margin-top:0">Entries</h2>
    ${entries.length ? `<ul class="entries">${rows}</ul>` : '<p class="note">No public entries yet.</p>'}
    <p class="note">Joined ${esc(date(p.joined_at))}${record.best_placement ? ` · best placement ${esc(String(record.best_placement))}` : ''}${p.wallet?.address ? ` · wallet ${esc(p.wallet.address.slice(0, 4))}…${esc(p.wallet.address.slice(-4))}` : ''}.</p>
  </div>`;
}
