// The four surfaces, each a function from API data to the HTML of one region.
//
// The verifier reads figures out of [data-v="<what>"] elements and out of leaderboard cells
// (data-col + data-rank), so a number is drawn in exactly one place per surface and nothing is
// duplicated with a second spelling.

import { absolute } from './api.js';
import {
  cell,
  count,
  dateTime,
  day,
  esc,
  initials,
  markdown,
  progress,
  statusLabel,
  until,
  usd,
} from './format.js';

/** A numeric slot: `<span class="v" data-v="pot">$724.50</span>`. */
const v = (what, html, cls = '') =>
  `<span data-v="${what}"${cls ? ` class="${cls}"` : ''}>${html}</span>`;

/** The live figure: the base prize plus every entry fee paid into it. */
const livePot = (b) => usd(b.potUsd ?? b.rewardAmount);

/** An image the API named: absolute on make.fun, loaded without credentials. */
function avatar(src, handle, cls = '') {
  const url = absolute(src);
  if (!url) return `<span class="ph ${cls}" aria-hidden="true">${esc(initials(handle))}</span>`;
  return `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" decoding="async" crossorigin="anonymous" referrerpolicy="no-referrer">`;
}

const pip = (n) => String(n).toLowerCase();

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const k = n % 100;
  return `${n}${s[(k - 20) % 10] || s[k] || s[0]}`;
};

// ---------------------------------------------------------------- loading

/**
 * The loading state: boxes where the real content will land, so the swap does not move the page
 * and the layout never shifts under the reader.
 */
export function skeleton(kind) {
  const line = (w) => `<span class="sk line" style="width:${w}"></span>`;
  const head = (eyebrow) => `
    <p class="eyebrow">${eyebrow}</p><span class="sk title"></span>${line('58%')}`;
  const busy = (label) => `aria-busy="true" aria-label="${label}"`;

  if (kind === 'bounty') {
    return `<div ${busy('Loading this bounty')}>${head('Bounty')}
      <div class="bhead" style="margin-top:24px">
        <div class="card pad">${line('92%')}${line('86%')}${line('64%')}
          <span style="display:block;height:14px"></span>${line('78%')}${line('71%')}</div>
        <div class="card pad"><span class="sk v"></span>${line('68%')}${line('52%')}${line('60%')}${line('44%')}</div>
      </div>
      <div class="sk row" style="margin-top:26px;height:120px"></div></div>`;
  }
  if (kind === 'leaderboard') {
    return `<div ${busy('Loading the leaderboard')}>${head('Leaderboard')}
      <div class="sk block" style="margin-top:22px"></div></div>`;
  }
  if (kind === 'profile') {
    return `<div ${busy('Loading this profile')}>${head('Profile')}
      <div class="phead" style="margin-top:18px"><span class="sk" style="width:76px;height:76px;border-radius:50%"></span>
        <div style="min-width:0;flex:1"><span class="sk title" style="width:40%"></span>${line('30%')}</div></div>
      <div class="sk block" style="margin-top:22px;height:92px"></div>
      <div style="margin-top:22px">${'<div class="sk row"></div>'.repeat(3)}</div></div>`;
  }
  return `<div ${busy('Loading the board')}>${head('Bounties')}
    <div class="sk block" style="margin-top:22px;height:76px"></div>
    <div style="margin-top:24px">${'<div class="sk row"></div>'.repeat(5)}</div></div>`;
}

// ---------------------------------------------------------------- failure

/** An honest failure, with a retry that goes back to make.fun for the same data. */
export function errorView({ title, message, detail }) {
  return `<section class="notice" role="alert" data-v="error">
    <p class="eyebrow">Something went wrong</p>
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    ${detail ? `<p class="detail">${esc(detail)}</p>` : ''}
    <div class="row"><button class="btn" type="button" data-retry>Try again</button>
      <a class="btn ghost" href="#/">Back to the board</a></div>
  </section>`;
}

/** A route or a bounty that is simply not there: nothing to retry. */
export function notFound(title, message) {
  return `<section class="notice" data-v="missing">
    <p class="eyebrow">Not found</p>
    <h2>${esc(title)}</h2>
    <p>${esc(message)}</p>
    <div class="row"><a class="btn" href="#/">Back to the board</a></div>
  </section>`;
}

// ---------------------------------------------------------------- the board

export function board(data, now = Date.now()) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const live = items.filter((b) => new Date(b.deadline).getTime() > now);
  const pooled = items.reduce((n, b) => n + (Number(b.potUsd ?? b.rewardAmount) || 0), 0);
  const entries = items.reduce((n, b) => n + (Number(b.submissionCount) || 0), 0);
  const charging = items.filter((b) => Number(b.entryFeeUsd) > 0).length;
  const soon = live.slice().sort((a, b) => new Date(a.deadline) - new Date(b.deadline))[0];

  const head = `<header class="head-row">
      <div>
        <p class="eyebrow">Open field</p>
        <h1>Bounties worth entering</h1>
        <p class="lede">Every open bounty on make.fun: what is really in the pot, what it costs to enter, and how long is left.</p>
      </div>
      ${soon ? `<p class="small muted nowrap">Next deadline: ${esc(day(soon.deadline))}, ${v(`until:${soon.slug}`, esc(until(soon.deadline, now)))}</p>` : ''}
    </header>`;

  const stats = `<div class="card stats">
      <div class="stat"><span class="k">Open bounties</span>${v('count', count(items.length), 'v')}</div>
      <div class="stat"><span class="k">Live pots, pooled</span>${v('pot-total', esc(usd(pooled)), 'v')}</div>
      <div class="stat"><span class="k">Entries received</span>${v('entries-total', count(entries), 'v')}</div>
      <div class="stat"><span class="k">Charge an entry fee</span>${v('fee-count', count(charging), 'v')}</div>
    </div>`;

  const rows = items
    .map((b) => {
      const slug = esc(b.slug);
      const fee = Number(b.entryFeeUsd) > 0
        ? `<span>Entry ${v(`fee:${b.slug}`, esc(usd(b.entryFeeUsd)))} · ${esc(count(b.entryFeePayers))} paid so far</span>`
        : '<span>Free to enter</span>';
      return `<li class="bounty">
        <h3><a href="#/bounty/${slug}" data-slug="${slug}">${esc(b.title)}</a></h3>
        <div class="pot">${v(`pot:${b.slug}`, esc(livePot(b)), 'v')}<span class="k">Live pot</span></div>
        <p class="meta">${esc(b.category || 'Open')}${b.sponsor?.name ? ` · ${esc(b.sponsor.name)}` : ''} <span class="chip">${esc(statusLabel(b.status))}</span></p>
        ${b.summary ? `<p class="lead">${esc(b.summary)}</p>` : ''}
        <div class="facts">
          <span>${v(`deadline:${b.slug}`, esc(dateTime(b.deadline)))}</span>
          <span>${v(`until-cell:${b.slug}`, esc(until(b.deadline, now)))}</span>
          <span><b>${v(`entries:${b.slug}`, count(b.submissionCount))}</b> entries</span>
          <span>base ${v(`reward:${b.slug}`, esc(usd(b.rewardAmount)))}</span>
          ${fee}
        </div>
      </li>`;
    })
    .join('');

  return `${head}${stats}
    <section class="section" aria-labelledby="open">
      <div class="head-row"><h2 id="open">The board</h2>
        <p class="small muted">Live pots grow as entry fees land.</p></div>
      <ol class="bounties">${rows}</ol>
    </section>`;
}

// ---------------------------------------------------------------- one bounty

export function bounty(b, now = Date.now()) {
  const slug = esc(b.slug);
  const fee = Number(b.entryFeeUsd) || 0;
  const state = new Date(b.deadline).getTime() <= now ? 'Closed for entries' : until(b.deadline, now);
  const phases = Array.isArray(b.phases) ? b.phases : [];
  const phase = phases.find((p) => p.key === 'dev') ?? phases[0] ?? null;
  const percent = progress(phase?.startsAt, phase?.endsAt, now);

  const rewards = (Array.isArray(b.rewardsNow) ? b.rewardsNow : [])
    .map((r) => `<li><span class="p">${esc(ordinal(r.place))}</span>${v(`place:${r.place}`, esc(usd(r.amountUsd)), 'a')}</li>`)
    .join('');

  const metric = b.resolution?.metric;
  const ranked = metric
    ? `<p class="small muted">Ranked by ${esc(metric.name || 'score')}${metric.unit ? `, in ${esc(metric.unit)}` : ''}${metric.better ? `, ${metric.better === 'lower' ? 'lower' : 'higher'} is better` : ''}.</p>`
    : '';

  return `<nav class="small muted" aria-label="Breadcrumb" style="margin-bottom:14px"><a href="#/">Board</a> / <span aria-current="page">${esc(b.title)}</span></nav>
    <div class="bhead">
      <div>
        <p class="eyebrow">${esc(b.category || 'Bounty')}${b.sponsor?.name ? ` · ${esc(b.sponsor.name)}` : ''}</p>
        <h1 data-v="title">${esc(b.title)}</h1>
        <p class="summary">${esc(b.summary || '')}</p>
        <div class="facts" style="border-top:0;padding-top:16px;margin-top:16px">
          <span class="chip">${v('status', esc(statusLabel(b.status)))}</span>
          <span>${v('deadline', esc(dateTime(b.deadline)))}</span>
          <span>${v('until', esc(state))}</span>
          <span><b>${v('entries', count(b.submissionCount))}</b> entries</span>
        </div>
        ${phase ? `<p class="small muted" style="margin:16px 0 0">${esc(phase.title)} phase, ${percent.toFixed(0)}% elapsed
          <span aria-hidden="true" style="display:block;height:2px;margin-top:6px;max-width:320px;background:var(--line)">
            <span style="display:block;height:2px;width:${percent.toFixed(1)}%;background:var(--accent)"></span></span></p>` : ''}
      </div>
      <aside class="card hero" aria-label="The money">
        <span class="eyebrow">Live pot</span>
        ${v('pot', esc(livePot(b)), 'v')}
        <dl class="kv">
          <dt>Base prize</dt><dd>${v('reward', esc(usd(b.rewardAmount)))}</dd>
          <dt>Entry fees paid in</dt><dd>${v('fees', esc(usd(b.entryFeesUsd ?? 0)))}</dd>
          <dt>Entry fee</dt><dd>${v('fee', fee > 0 ? esc(usd(b.entryFeeUsd)) : 'None')}</dd>
          <dt>Fee payers</dt><dd>${v('fee-payers', count(b.entryFeePayers ?? 0))}</dd>
          <dt>Entries</dt><dd>${v('entry-count', count(b.submissionCount))}</dd>
          <dt>Opens</dt><dd>${v('opens', esc(dateTime(b.opensAt || b.publishedAt)))}</dd>
          <dt>Closes</dt><dd>${v('deadline-full', esc(dateTime(b.deadline)))}</dd>
        </dl>
        ${b.leaderboard ? `<p style="margin:16px 0 0"><a class="btn" href="#/bounty/${slug}/leaderboard">Leaderboard</a></p>` : ''}
      </aside>
    </div>
    <div class="split section">
      <section aria-labelledby="brief">
        <h2 id="brief">The brief</h2>
        ${b.description ? `<div class="prose" data-v="description">${markdown(b.description)}</div>` : '<p class="muted">No description given.</p>'}
        ${b.rules ? `<h2 id="rules" style="margin-top:28px">Rules</h2><div class="prose" data-v="rules">${markdown(b.rules)}</div>` : ''}
      </section>
      <aside aria-labelledby="pays">
        <h2 id="pays">What pays</h2>
        <div class="card pad">${rewards ? `<ol class="rewards">${rewards}</ol>${ranked}` : '<p class="muted small" style="margin:0">No reward table for this bounty.</p>'}</div>
        ${b.prerequisites ? `<h2 style="margin-top:24px">You will need</h2>
          <div class="card pad"><p class="small" style="margin:0 0 6px">${esc(b.prerequisites.label || '')}</p>
          <p class="small muted" style="margin:0">${esc(b.prerequisites.summary || '')}</p></div>` : ''}
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- the leaderboard

export function leaderboard(lb, { page = 1, perPage = 25, now = Date.now() } = {}) {
  const entries = Array.isArray(lb?.entries) ? lb.entries : [];
  const columns = Array.isArray(lb?.columns) ? lb.columns.filter((c) => !c.hidden) : [];
  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const at = Math.min(Math.max(1, page), pages);
  const slice = entries.slice((at - 1) * perPage, at * perPage);
  const comp = lb?.competition ?? {};
  const phase = lb?.phase ?? {};
  const tie = lb?.tie_break;
  const metricTitle = columns.find((c) => c.key === lb?.rank_key)?.title;

  const headCells = columns
    .map((c) => `<th scope="col" class="num-cell" title="${esc(c.source || c.title)}">${esc(c.title)}</th>`)
    .join('');

  const body = slice
    .map((e) => {
      const rank = e.rank;
      const cells = columns
        .map((c) => `<td class="num-cell" data-col="${esc(c.key)}" data-rank="${esc(rank)}">${esc(cell(e, c.key))}</td>`)
        .join('');
      return `<tr${rank <= 3 ? ' class="top"' : ''} data-rank="${esc(rank)}">
        <td class="rank">${esc(rank)}</td>
        <td class="who">${avatar(e.image, e.handle)}
          <span class="t"><b><a href="#/u/${esc(e.handle)}">${esc(e.handle)}</a></b><small>${esc(e.title || '')}</small></span></td>
        ${cells}
      </tr>`;
    })
    .join('');

  const from = total === 0 ? 0 : (at - 1) * perPage + 1;
  const to = Math.min(total, at * perPage);

  return `<nav class="small muted" aria-label="Breadcrumb" style="margin-bottom:14px"><a href="#/">Board</a> / <a href="#/bounty/${esc(comp.slug)}">${esc(comp.title || comp.slug || 'Bounty')}</a> / <span aria-current="page">Leaderboard</span></nav>
    <header class="head-row">
      <div>
        <p class="eyebrow">Leaderboard${phase.title ? ` · ${esc(phase.title)}` : ''}</p>
        <h1>${esc(comp.title || 'Leaderboard')}</h1>
        <p class="lede">Ranked by ${esc(metricTitle || 'the house metric')}${tie ? `; ties go to ${esc(tie.title || tie.key)}, ${tie.better === 'lower' ? 'lower' : 'higher'} first` : ''}.</p>
      </div>
      <p class="small muted nowrap">${v('rows', count(total))} rows</p>
    </header>
    <div class="table-wrap">
      <table>
        <caption>${esc(lb?.title || 'Results')}, exactly as make.fun gives it: ${v('columns', count(columns.length))} metric columns.${phase.endsAt ? ` This phase closed ${esc(day(phase.endsAt))}.` : ''}</caption>
        <thead><tr><th scope="col" class="rank">#</th><th scope="col">Entrant</th>${headCells}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="pager">
      <span>Showing ${count(from)}–${count(to)} of ${v('total', count(total))}</span>
      <span style="display:flex;align-items:center;gap:8px">
        <button class="btn ghost" type="button" data-page="${at - 1}"${at <= 1 ? ' disabled' : ''}>Previous</button>
        <span class="nowrap">Page ${at} of ${pages}</span>
        <button class="btn ghost" type="button" data-page="${at + 1}"${at >= pages ? ' disabled' : ''}>Next</button>
      </span>
    </div>
    <p class="small muted" style="margin-top:14px">${phase.startsAt ? `Entries ${esc(day(phase.startsAt))} to ${esc(day(phase.endsAt))}. ` : ''}Read ${esc(dateTime(new Date(now).toISOString()))}.</p>`;
}

// ---------------------------------------------------------------- one profile

export function profile(p) {
  const handle = String(p?.handle ?? '');
  const record = p?.record ?? {};
  const solutions = Array.isArray(p?.solutions) ? p.solutions : [];
  const name = p?.display_name && p.display_name !== handle ? p.display_name : '';

  const stats = [
    ['Bounties entered', 'entered', count(record.competitions_entered ?? solutions.length)],
    ['Placed', 'placed', count(record.competitions_placed ?? 0)],
    ['Podiums', 'podiums', count(record.podium_finishes ?? 0)],
    ['Wins', 'wins', count(record.competitions_won ?? 0)],
    ['Best rank', 'best', Number.isFinite(record.best_placement) ? `#${count(record.best_placement)}` : '—'],
    ['Prize money', 'prize', esc(usd(record.prize_usd ?? '0'))],
  ]
    .map(([label, key, value]) => `<div class="stat"><span class="k">${label}</span>${v(`stat:${key}`, value, 'v')}</div>`)
    .join('');

  const rows = solutions
    .map((s) => {
      const c = s.competition ?? {};
      const score = s.score
        ? `<b>${esc(String(s.score.display ?? s.score.value ?? '—'))}</b><small>${esc(s.score.column?.title || 'score')}</small>`
        : '<b>—</b><small>no score yet</small>';
      return `<li data-entry="${esc(c.slug || '')}">
        <div class="t">${esc(s.title || c.title || 'Entry')}
          <span class="c">${esc(c.title || c.slug || '')}${s.placement ? ` · placed #${esc(String(s.placement))}` : ''} · entered ${esc(day(s.entered_at))}</span></div>
        <div class="s">${score}</div>
      </li>`;
    })
    .join('');

  const wallet = p?.wallet?.address
    ? ` · wallet ${esc(String(p.wallet.address).slice(0, 4))}…${esc(String(p.wallet.address).slice(-4))}`
    : '';

  return `<nav class="small muted" aria-label="Breadcrumb" style="margin-bottom:14px"><a href="#/">Board</a> / <span aria-current="page">${esc(handle)}</span></nav>
    <header class="phead">
      ${avatar(p?.image || p?.avatar, handle, 'avatar')}
      <div class="id">
        <p class="eyebrow">Profile${p?.house ? ' · house account' : ''}</p>
        <h1 data-v="handle">${esc(handle)}</h1>
        <p class="lede">${name ? `${esc(name)} · ` : ''}joined ${esc(day(p?.joined_at))}${wallet}</p>
      </div>
    </header>
    <div class="card stats" style="margin-top:26px">${stats}</div>
    <section class="section" aria-labelledby="entries">
      <div class="head-row"><h2 id="entries">Entries</h2>
        <p class="small muted">${v('solutions', count(solutions.length))} on record</p></div>
      ${rows ? `<ol class="solutions">${rows}</ol>` : '<p class="muted">No entries on make.fun yet.</p>'}
    </section>`;
}
