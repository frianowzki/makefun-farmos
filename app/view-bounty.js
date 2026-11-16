// #/bounty/<slug> — one bounty: its summary and description, how it is judged, the rewards
// table with the live pot, and when it closes.

import {
  bountyHref,
  count,
  esc,
  eyebrow,
  icon,
  leaderboardHref,
  money,
  plural,
  shortDate,
  stateOf,
  statePill,
  timeLeft,
} from './ui.js';

/** The markdown the descriptions use, rendered small: headings, lists, paragraphs, bold, links. */
export function markdown(text) {
  const blocks = String(text ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      if (/^#{1,6}\s/.test(lines[0])) {
        const level = Math.min(lines[0].match(/^#+/)[0].length, 3);
        return `<h${level + 1} class="md-h">${inline(lines[0].replace(/^#+\s*/, ''))}</h${level + 1}>`;
      }
      if (lines.every((l) => /^[-*]\s/.test(l))) {
        return `<ul class="md-list">${lines.map((l) => `<li>${inline(l.replace(/^[-*]\s*/, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

/** The rewards table: each place's base, the fee share that has joined it, and the total. */
function rewardsTable(rewards) {
  const rows = [...rewards]
    .sort((a, b) => a.place - b.place)
    .map(
      (r) => `
      <tr><td class="num num--rank">${esc(r.place)}</td><td class="num">${money(r.baseUsd)}</td><td class="num muted">${money(r.feeShareUsd)}</td><td class="num">${money(r.amountUsd)}</td></tr>`,
    )
    .join('');
  return `
    <table class="table table--rewards">
      <caption class="sr-only">Rewards by place, with the entry fees paid into each</caption>
      <thead><tr><th scope="col">Place</th><th scope="col">Reward</th><th scope="col">Fees</th><th scope="col">Now</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** A labelled fact in the side column. */
const fact = (k, v) => `<div class="fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;

/** One bounty's page. */
export function bountyView(b, { now = Date.now() } = {}) {
  const state = stateOf(b, now);
  const fee = Number(b.entryFeeUsd) > 0 ? money(b.entryFeeUsd) : null;
  const rewards = Array.isArray(b.rewardsNow) && b.rewardsNow.length > 0
    ? b.rewardsNow
    : Object.entries(b.rewards ?? {}).map(([place, baseUsd]) => ({ place: Number(place), baseUsd, feeShareUsd: '0.00', amountUsd: baseUsd }));
  const placed = rewards.length;
  const pot = money(b.potUsd ?? b.rewardAmount);
  const feesIn = Number(b.entryFeesUsd) > 0 ? money(b.entryFeesUsd) : null;
  const resolution = b.resolution ?? {};
  const rules = Array.isArray(resolution.criteria) ? resolution.criteria : [];

  return `
    <article class="page bounty">
      <a class="crumb" href="#/">${icon('<path d="M19 12H5M11 18l-6-6 6-6"/>', { size: 16 })} The board</a>
      ${eyebrow(`${b.category ?? 'Bounty'}${b.sponsor?.name ? ` · sponsored by ${esc(b.sponsor.name)}` : ''}`)}
      <h1 class="title title--bounty">${esc(b.title)}</h1>
      <p class="lede">${esc(b.summary ?? '')}</p>

      <div class="hero-figures" role="list">
        <div class="figure" role="listitem">
          <span class="figure__k">Live pot</span>
          <span class="figure__v num">${pot}</span>
          <span class="figure__s">${fee ? `${esc(fee)} entry fee · ${feesIn} paid in` : 'No entry fee'}</span>
        </div>
        <div class="figure" role="listitem">
          <span class="figure__k">${esc(plural(b.submissionCount ?? 0, 'Entry', 'Entries'))}</span>
          <span class="figure__v num">${count(b.submissionCount)}</span>
          <span class="figure__s"><a href="${esc(leaderboardHref(b.slug))}">See the leaderboard</a></span>
        </div>
        <div class="figure" role="listitem">
          <span class="figure__k">Places paid</span>
          <span class="figure__v num">${count(placed)}</span>
          <span class="figure__s">${esc(plural(placed, 'place share', 'place shares', true))} the pot</span>
        </div>
      </div>

      <div class="two-col">
        <div class="prose">
          <section class="card card--pad">
            ${eyebrow('The brief')}
            <div class="md">${markdown(b.description ?? b.summary ?? '')}</div>
          </section>
          ${rules.length > 0
            ? `<section class="card card--pad">
                ${eyebrow('How it is judged')}
                ${resolution.summary ? `<p class="md">${esc(resolution.summary)}</p>` : ''}
                <ol class="rules">${rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
              </section>`
            : ''}
        </div>

        <aside class="side" aria-label="Bounty facts">
          <section class="card card--pad">
            <div class="card__head">
              <h2 class="h2">The details</h2>
              ${statePill(state)}
            </div>
            <dl class="facts">
              ${fact('Live pot', `<span class="num">${pot}</span>`)}
              ${fact('Entry fee', fee ?? 'None')}
              ${fact('Fees paid in', feesIn ?? '—')}
              ${fact('Entries', `<span class="num">${count(b.submissionCount)}</span>`)}
              ${fact('Opened', shortDate(b.publishedAt))}
              ${fact('Closes', `${shortDate(b.deadline)}<span class="muted"> · ${esc(timeLeft(b.deadline, now))} left</span>`)}
              ${fact('Harness', esc(b.harnessKind ?? '—'))}
              ${b.race?.endsAt ? fact('Runs until', shortDate(b.race.endsAt)) : ''}
            </dl>
            <a class="btn btn--primary btn--block" href="${esc(leaderboardHref(b.slug))}">Open the leaderboard</a>
          </section>
          ${b.skills?.length
            ? `<section class="card card--pad"><h2 class="h2">Skills</h2><ul class="tags">${b.skills.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></section>`
            : ''}
          ${b.demand ? `<section class="card card--pad">${eyebrow('Who it is for')}<p class="md">${esc(b.demand)}</p></section>` : ''}
        </aside>
      </div>

      <section class="card card--pad" id="rewards">
        <div class="card__head">
          <h2 class="h2">Rewards</h2>
          <span class="pill pill--quiet">${pot} across ${esc(plural(placed, 'place', 'places', true))}</span>
        </div>
        <p class="md muted">Each place's reward plus its share of the entry fees paid so far. ${fee ? 'Fees join the pot as entrants pay them.' : ''}</p>
        <div class="table-wrap">${rewardsTable(rewards)}</div>
      </section>
    </article>`;
}
