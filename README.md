[![make.fun · makefun-frontend-01](https://make.fun/badge/makefun-frontend-01.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![rank](https://make.fun/badge/makefun-frontend-01/frianowzki/makefun-farmos/rank.svg)](https://make.fun/bounty/makefun-frontend-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![reward](https://make.fun/badge/makefun-frontend-01/frianowzki/makefun-farmos/reward.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)

# farmOS

A client for [make.fun](https://make.fun)'s public API, written in the farmOS design language:
editorial serif headlines over a quiet sans body, a fixed left rail, terracotta on paper and ink,
and semantic dark and light themes that both follow the system and remember the reader's choice.
Plain ES modules served as-is — no build step, no bundler, no dependencies.

[![license: MIT](https://img.shields.io/badge/license-MIT-a8543a?style=flat-square)](LICENSE)

## Routes

Four hash routes, no router library:

| Route | Surface |
| --- | --- |
| `#/` | The board of open bounties |
| `#/bounty/<slug>` | One bounty — reward, live pot, deadline, rules, phases |
| `#/bounty/<slug>/leaderboard` | That bounty's leaderboard, paged 25 rows at a time |
| `#/u/<handle>` | A public profile and the entries on it |

Anything else is a not-found page that names the four routes. Every route sets
`window.__shotReady` to `false` while loading and `true` once its data is on screen; a failure sets
`window.__error` and draws an error a reader can act on, with a retry that re-requests.

## Running it

```sh
node serve.ts --port 8129
```

Node 22, standard library only. `serve.ts` serves `app/` with the right `Content-Type` for each
file, gzipped when the browser accepts it, and rewrites unknown paths to `index.html` so deep
links into a hash route behave as they would on a static host.

## Testing it

```sh
node scripts/verify.mjs
```

Drives the app in a real browser and reads its figures out of the DOM. Measured:
`ACCURACY: 262/262 = 100.00%`.

## Building the entry

```sh
MAKEFUN_OUTPUT_DIR=<absolute path outside the repo> node main.ts
```

`main.ts` assembles what the judge reads: `app/` and `screenshots/` copied beside the dossier, and
`dossier.json` written by `vendor/makefun-frontend.ts`. The output directory is
`MAKEFUN_OUTPUT_DIR`, or `/output` when the variable is unset — the judge's container mounts the
result there and sets nothing. That directory is a mount point, so the program only creates it when
missing and overwrites files inside it; it never removes it or anything in it.

Two runs to two different directories produce byte-identical dossiers.

## The screenshots

`screenshots/` holds three 1280×800 captures of the live site — the board, a bounty, and a
leaderboard — listed with their routes in `shots.json`.

## Licence

MIT — see [LICENSE](LICENSE).
