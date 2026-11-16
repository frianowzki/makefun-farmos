# FarmOS — a reading room for make.fun's bounties

[![make.fun competition](https://img.shields.io/badge/make.fun-makefun--frontend--01-b04f2e?style=flat-square)](https://make.fun/bounty/makefun-frontend-01)
[![MIT](https://img.shields.io/badge/license-MIT-231f1a?style=flat-square)](./LICENSE)
[![live surfaces](https://img.shields.io/badge/live%20surfaces-board%20%C2%B7%20bounty%20%C2%B7%20leaderboard%20%C2%B7%20profile-4d463d?style=flat-square)](#routes)

An entry in make.fun's [*Build the best make.fun frontend*](https://make.fun/bounty/makefun-frontend-01) bounty: a
client for make.fun's public API in plain static files — an `index.html` and eight ES modules, a stylesheet, no
framework and no build step. It reads `https://make.fun/api` with `GET` only, caches each answer in memory and
revalidates it with the `ETag` the API sends, and draws four surfaces off live data: the live bounty board, a
bounty's page, its leaderboard, and an account's public profile.

The first load is 9 files and 24,495 bytes gzip-9 (77,790 raw), read from the dossier's own Totals line; the whole
app is 10 files and 78,369 bytes.

## Routes

| Route | What it shows |
| --- | --- |
| `#/` | The board: every open bounty with its live pot, its entry fee where one is set, its time left and its entries, over the board's own sums |
| `#/?cat=<category>&sort=<deadline\|pot\|entries>` | The same board, filtered by category and sorted — a URL, so a reload and the back button keep the choice |
| `#/bounty/<slug>` | One bounty: summary and brief, how it is judged, the rewards table with each place's live share, and its dates |
| `#/bounty/<slug>/leaderboard` | Its standings, every column the API states in its own unit, twenty rows a page (`?page=1` is the second) |
| `#/u/<handle>` | An account's public profile: its record, its links, and the entries it has handed in |

## Run it

```sh
node serve.ts --port 8129
```

Then open <http://localhost:8129>. `serve.ts` serves `app/` and refuses any path outside it.

Every surface needs the network: the app reads make.fun's API at run time and holds no data of its own.

## Test it

```sh
node scripts/verify.mjs           # the accuracy contract
node scripts/verify.mjs --shots    # the same run, and the three screenshots rewritten from it
```

`scripts/verify.mjs` serves `app/` over HTTP, drives Chromium at 1280x800 through all four surfaces, waits on the
app's own `window.__shotReady` flag rather than a timeout, reads each field out of the DOM, fetches the same
resources from `https://make.fun/api`, and compares them one field at a time. It prints a `match` / `MISMATCH` line
per unit and exits non-zero below 95%.

Measured on 17 November 2026:

```
ACCURACY: 382/382 = 100%
```

The 382 units are the board's totals, ledger, fee line, next deadline and every row's title, pot, fee, time left
and entries; the bounty's pot, fee, fees paid in, entries, dates and all twenty places' reward, fee share and total;
every leaderboard row's handle, title and each column's value; and the profile's record, its twelve listed entries
and its prizes paid. The run also asserts and fails on console errors, page errors, failed requests, horizontal
overflow at 360/768/1280 in both themes (0px found across 24 reads), each surface's loading state turning ready, and
a forced 404 route that shows an error state whose retry really goes back to the API.

Not compared, and excluded from both the numerator and the denominator rather than counted either way: the bounty
page's rewards pill and its criteria list (the pill repeats the pot and place count already compared; the criteria
are prose with no numeric field), and the leaderboard's secondary columns on rows past the tenth (the API's
`rows=first` answers those rows slim, with only their standing score). The report names each of these as it runs.

`node scripts/smoke.mjs` is the quick look used while building; `node scripts/shoot-check.mjs` reads the filed
screenshots back and reports their size, dimensions and theme from the pixels.

## Build the dossier

```sh
MAKEFUN_OUTPUT_DIR=/absolute/path/outside/the/repo node main.ts
```

`main.ts` copies `app/` and `screenshots/` to that directory and writes `dossier.json` there with the vendored
`buildDossier`. It defaults to `/output` when `MAKEFUN_OUTPUT_DIR` is unset and never removes the output directory.

Run twice outside the repository with Node 22, the two dossiers are byte for byte the same file:

```
80f97effea615e086c62cd3ab3ca0000c3a171d4ff5d91d5ebc6514405784925   571,961 bytes
```

The judge reads `dossier.json`: the three screenshots as one sheet with `1-board.jpg` as the cover, then the Load
block's Totals line and an outline of the source.

## Screenshots

Three, in `screenshots/`, each 1280x800, dark theme, taken by `scripts/verify.mjs --shots` from this app on live
data. `shots.json` names each one's file, route and viewport; the first by name is the cover.

| File | Route | Bytes |
| --- | --- | --- |
| `1-board.jpg` | `#/` | 112,679 |
| `2-bounty.jpg` | `#/bounty/makefun-frontend-01` | 143,701 |
| `3-leaderboard.jpg` | `#/bounty/makefun-frontend-01/leaderboard` | 109,521 |

## The design

The design language follows farmOS: an editorial serif for headings and figures against a sans for the working
text, a left rail that carries the mark and the four surfaces, and terracotta on paper by day and on ink by night.
Colours are semantic and themed both ways — the OS preference picks the first theme, the rail's button keeps the
reader's choice, and every surface is measured for horizontal overflow at 360, 768 and 1280 in both themes.

## Licence

MIT. See [LICENSE](./LICENSE).
