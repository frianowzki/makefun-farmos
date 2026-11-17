[![make.fun · makefun-frontend-01](https://make.fun/badge/makefun-frontend-01.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![rank](https://make.fun/badge/makefun-frontend-01/frianowzki/makefun-farmos/rank.svg)](https://make.fun/bounty/makefun-frontend-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![reward](https://make.fun/badge/makefun-frontend-01/frianowzki/makefun-farmos/reward.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)

# FarmOS

A client for [make.fun](https://make.fun)'s public API, drawn in the farmOS design language: an editorial serif for
display, a quiet left rail for navigation, terracotta on paper and ink. Every figure on the page is the figure the
API sent — nothing is rounded into agreement, and nothing is invented when the API withholds a value.

The theme is semantic: one set of tokens in `app/style.css` carries meaning (paper, ink, rule, accent), and
`[data-theme="dark"]` restates those tokens rather than restyling components. The reader's choice is kept in
`localStorage` and applied before first paint, so a dark reader never sees a flash of paper.

It is plain ES modules served as-is: no framework, no bundler, no build step, no dependencies at runtime.

[![license: MIT](https://img.shields.io/badge/license-MIT-8a3324.svg)](LICENSE)

## Routes

The router reads the hash (`app/main.js`):

| Route                          | Page                                                       |
| ------------------------------ | ---------------------------------------------------------- |
| `#/` and `#/live`              | the live board: bounties still taking entries              |
| `#/closed`                     | the archive: bounties whose deadline has passed            |
| `#/bounty/<slug>`              | one bounty: pot, fee, deadline, rewards, rules, description |
| `#/bounty/<slug>/leaderboard`  | that bounty's leaderboard, one row per entry               |
| `#/u/<handle>`                 | one profile: record, prize money, and its entries          |

Any other hash is a "not found" page. A route that cannot load says what the API said, and its retry asks make.fun
again rather than re-rendering the failure.

## Run

```
node serve.ts --port 8129
```

Then open <http://localhost:8129>. Node 22, standard library only. (Without `--port` it listens on 8080.)

## Test

```
node scripts/verify.mjs
```

It serves `app/` over a real HTTP server, drives real Chromium at 1280×800, and holds every figure on screen to the
answer `https://make.fun/api` gave for it — the board, a bounty, its leaderboard, a profile, the layout at 360, 768
and 1280px, and the error route's retry. It fails on any console error, page error, failed request or horizontal
overflow. Measured:

```
ACCURACY: 2463/2463 = 100.00%
```

The same run with `--shots` also writes the three screenshots of `screenshots/` and refreshes `shots.json`.

## Build

```
MAKEFUN_OUTPUT_DIR=<absolute path outside the repo> node main.ts
```

Stages `app/` and `screenshots/` into the output directory and writes `dossier.json` beside them. It creates the
directory when it is missing and overwrites what is there, but never removes it. `--out <dir>` works too.

## Screenshots

| File                       | Route                              |
| -------------------------- | ---------------------------------- |
| `screenshots/board.png`    | `#/`                               |
| `screenshots/bounty.png`   | `#/bounty/makefun-frontend-01`     |
| `screenshots/leaderboard.png` | `#/bounty/makefun-frontend-01/leaderboard` |

Each is 1280×800, dark theme, rendered from the live API.

## Licence

MIT. See [LICENSE](LICENSE).
