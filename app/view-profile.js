// #/u/<handle> — an account's public profile: who it is, what it has done in the open, and
// the entries it has handed in.

import {
  avatar,
  bountyHref,
  count,
  esc,
  eyebrow,
  icon,
  money,
  plural,
  shortDate,
} from './ui.js';

/** The record line, with each count's own unit. */
function stats(record) {
  const r = record ?? {};
  const cards = [
    ['Entered', count(r.competitions_entered), plural(r.competitions_entered ?? 0, 'bounty', 'bounties', true)],
    ['Won', count(r.competitions_won), plural(r.competitions_won ?? 0, 'first place', 'first places', true)],
    ['Placed', count(r.competitions_placed), plural(r.competitions_placed ?? 0, 'paid place', 'paid places', true)],
    ['Prize money', money(r.prize_usd), r.best_placement ? `best place ${r.best_placement}` : 'none paid yet'],
  ];
  return `<div class="stats" role="list">${cards
    .map(
      ([k, v, s]) =>
        `<div class="stat" role="listitem"><span class="stat__k">${esc(k)}</span><span class="stat__v num">${v}</span><span class="stat__s">${esc(s)}</span></div>`,
    )
    .join('')}</div>`;
}

/** One entry the account has in: its competition, its title, its place and score. */
function entry(s) {
  const comp = s.competition ?? {};
  const place = typeof s.placement === 'number' ? `#${s.placement}` : null;
  const score = s.score?.display ?? null;
  const column = s.score?.column?.title ?? null;
  return `
    <li class="entry-row">
      <a class="entry-row__main" href="${esc(bountyHref(comp.slug ?? ''))}">
        <span class="entry-row__title">${esc(s.title ?? 'Untitled entry')}</span>
        <span class="entry-row__meta">${esc(comp.title ?? comp.slug ?? '')}${comp.category ? ` · ${esc(comp.category)}` : ''}</span>
      </a>
      <span class="entry-row__cell"><span class="row__k">Entered</span>${shortDate(s.entered_at)}</span>
      <span class="entry-row__cell"><span class="row__k">Place</span>${place ? `<span class="num">${esc(place)}</span>${s.prize_usd ? `<span class="muted"> · ${money(s.prize_usd)}</span>` : ''}` : '<span class="muted">—</span>'}</span>
      <span class="entry-row__cell"><span class="row__k">${esc(column ?? 'Score')}</span>${score ? `<span class="num">${esc(score)}</span>` : '<span class="muted">—</span>'}</span>
    </li>`;
}

/** The whole profile. */
export function profileView(p, { entries = 12 } = {}) {
  const name = p.display_name || p.handle;
  const solutions = Array.isArray(p.solutions) ? p.solutions : [];
  const shown = solutions.slice(0, entries);
  const links = [
    p.github_login ? `<a class="link" href="https://github.com/${esc(p.github_login)}" rel="noopener">${icon('<path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.3 5.4 2.6 5.4 2.6a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>', { size: 16 })} ${esc(p.github_login)}</a>` : '',
    p.discord ? `<span class="link">Discord ${esc(p.discord.username ?? p.discord.global_name ?? '')}</span>` : '',
    p.x ? `<a class="link" href="${esc(p.x.url ?? '#')}" rel="noopener">X @${esc(p.x.username ?? '')}</a>` : '',
    p.wallet?.explorer_url ? `<a class="link" href="${esc(p.wallet.explorer_url)}" rel="noopener">${icon('<path d="M4 12V7a2 2 0 0 1 2-2h9M12 20h6a2 2 0 0 0 2-2V6"/><circle cx="8" cy="12" r="3"/>', { size: 16 })} Wallet ${esc(String(p.wallet.address ?? '').slice(0, 4))}…${esc(String(p.wallet.address ?? '').slice(-4))}</a>` : '',
  ].filter(Boolean);

  return `
    <section class="page profile">
      <a class="crumb" href="#/">${icon('<path d="M19 12H5M11 18l-6-6 6-6"/>', { size: 16 })} The board</a>
      <header class="profile-head">
        ${avatar(p.avatar?.url ?? p.image, p.handle, { size: 72, cls: 'avatar--lg' })}
        <div class="profile-id">
          ${eyebrow(`Member${p.house ? ' · make.fun' : ''}${p.demo ? ' · demo account' : ''}`)}
          <h1 class="title title--profile">${esc(name)}</h1>
          <p class="profile-handle">@${esc(p.handle)}${p.joined_at ? `<span class="muted"> · joined ${shortDate(p.joined_at, false)}</span>` : ''}</p>
        </div>
      </header>
      ${p.bio ? `<p class="lede">${esc(p.bio)}</p>` : '<p class="lede muted">No bio yet.</p>'}
      ${links.length ? `<div class="links">${links.join('')}</div>` : ''}

      ${stats(p.record)}

      <section class="card card--pad">
        <div class="card__head">
          <h2 class="h2">Entries</h2>
          <span class="pill pill--quiet">${count(solutions.length)} ${plural(solutions.length, 'entry', 'entries')}</span>
        </div>
        ${shown.length === 0
          ? `<p class="empty muted">No public entries yet.</p>`
          : `<ul class="entry-list">${shown.map(entry).join('')}</ul>
             ${solutions.length > shown.length ? `<div class="more"><button class="btn btn--sm" type="button" data-more-entries="${shown.length}">Show ${Math.min(24, solutions.length - shown.length)} more</button><span class="muted">Showing ${shown.length} of ${count(solutions.length)}</span></div>` : ''}`}
      </section>

      ${Array.isArray(p.payouts) && p.payouts.length > 0
        ? `<section class="card card--pad">
            <div class="card__head"><h2 class="h2">Prizes paid</h2><span class="pill pill--quiet num">${money(p.record?.prize_usd)}</span></div>
            <ul class="payouts">${p.payouts
              .map(
                (pay) =>
                  `<li><span class="num">${money(pay.amount_usd)}</span> for place ${esc(pay.place)} in <a href="${esc(bountyHref(pay.competition?.slug ?? ''))}">${esc(pay.competition?.title ?? '')}</a><span class="muted"> · ${shortDate(pay.paid_at, false)}</span></li>`,
              )
              .join('')}</ul>
          </section>`
        : ''}
    </section>`;
}

/** The entries list redrawn with `n` of them, for the profile's "show more" button. */
export function moreEntries(p, n) {
  const solutions = Array.isArray(p.solutions) ? p.solutions : [];
  return solutions.slice(0, n).map(entry).join('');
}
