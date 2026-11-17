[![make.fun · makefun-frontend-01](https://make.fun/badge/makefun-frontend-01.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![rank](https://make.fun/badge/makefun-frontend-01/frianowzki/makefun-farmos/rank.svg)](https://make.fun/bounty/makefun-frontend-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![reward](https://make.fun/badge/makefun-frontend-01/frianowzki/makefun-farmos/reward.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)

# farmOS

A client for [make.fun](https://make.fun)'s public API, in the farmOS design language: editorial serif
on a left rail, terracotta against paper and ink, semantic dark and light themes, and plain ES modules
with no build step.

**MIT licensed** — see [LICENSE](LICENSE).

Bounties, leaderboards and maker profiles read live from `https://make.fun/api` over GET, with no
credentials and nothing written back.

## Routes

| Route | What it shows |
| --- | --- |
| `#/` | The bounty board: every open bounty, newest first, with live pot, entry fee, entries and time left, plus totals for the board. |
| `#/bounties` | The ledger: the same bounties sorted by pot, largest first. |
| `#/bounty/<slug>` | One bounty: description, rules, phases, the rewards by place, skills, and an at-a-glance card (pot, fee, deadline, measured metric, sponsor). |
| `#/bounty/<slug>/leaderboard` | That bounty's leaderboard: the API's own columns in its own order, bar-scaled on the ranking column, with units spelled out and every handle linking to a profile. |
| `#/u/<handle>` | A maker's profile: record (entered, placed, wins, podiums, prizes) and every public entry with its score. |

Unknown paths get a not-found page; a failed request gets an error page with the reason and a retry that
re-runs the route. The theme follows the system by default and is remembered once you switch it.

## Run

```sh
node serve.ts --port 8129
```

Then open <http://localhost:8129>. It is a static server over `app/` only — a development convenience,
not a web server for the internet.

## Test

```sh
node scripts/verify.mjs
```

It drives the app in a real browser against the live API and compares every field the pages show with
what the API publishes.

```
ACCURACY: 231/232 = 99.5%
```

## Build

```sh
MAKEFUN_OUTPUT_DIR=<absolute path outside the repo> node main.ts
```

`main.ts` copies `app/` and `screenshots/` into the output directory and writes `dossier.json` there —
the summary the judge reads, built by the vendored library in `vendor/`. With `MAKEFUN_OUTPUT_DIR`
unset it falls back to `/output`. The output is deterministic: two runs to different directories write
byte-identical `dossier.json` files.

```
Totals: first load 7 files, 17674 bytes gzip-9 (53177 raw); later by import() 0 files, 0 bytes gzip-9; whole app 7 files, 53177 bytes
```

`vendor/makefun-frontend.ts` is left exactly as the kit ships it, because the scorer requires
`dossier.json` to be byte for byte what its own copy writes.

## Screenshots

`screenshots/` holds three 1280×800 captures of the app on live data; `shots.json` records the route
each one was taken of.

| File | Route |
| --- | --- |
| `screenshots/1-board.jpg` | `#/` |
| `screenshots/2-bounty.jpg` | `#/bounty/threejs-fps-02` |
| `screenshots/3-bounty.jpg` | `#/bounty/bring-the-humans-01` |

## Layout

```
main.ts                 the entrypoint: copies app/ and screenshots/, writes dossier.json
serve.ts                a static server for app/ during development
app/index.html          the shell: rail, view container, theme boot script
app/main.js             hash router, theme, loading and error states
app/api.js              GET-only client for make.fun's public API
app/views.js            the four surfaces, each API data to HTML
app/format.js           money, counts, dates, countdowns and markdown, in one place
app/icons.js            the inline SVG icons
app/style.css           the design language: type, colour, layout, both themes
scripts/verify.mjs      the accuracy harness
scripts/serve.mjs       a harness-local static server
vendor/                 make.fun's dossier library, unmodified
screenshots/            three captures on live data
shots.json              which route each capture was taken of
```
