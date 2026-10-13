# re-magicpockets

An evidence-grounded HTML5/JS port of **Magic Pockets** (The Bitmap Brothers, DOS 1994), and
the reverse-engineering record it is built from. Vanilla JS and Canvas, no framework. Vite + npm.

## Playing it

**Play it in the browser** (once the repo is public) at <https://vorticoncmdr.github.io/re-magicpockets/>.
The site ships no game data: click **Load folder…** and pick your own copy of the DOS release
(the directory with `GAMEU.EXE`, `INTROU.EXE`, `KLOGOPOU.EXE` and the `data/` files). The files
are read straight from disk and never uploaded.

To run it locally instead, put your copy in `game/` and `data/` (below), start the dev server
and open `http://127.0.0.1:5173/`. The Konami/Renegade logo and the intro play first, then the
world 1 intro and the game.

| Key | Action |
|---|---|
| ←/→ or A/D | walk |
| ↑ or W | jump |
| ↓ or S | down |
| Space, Ctrl or Z | fire |
| digits, arrows, Enter | the level-code screen after a level |

The level-code screen is the original's copy protection (the original asks for a code from the
manual's code wheel). The port pre-enters the expected code, so Enter passes; a wrong code picks
a new prompt, as in the original.

URL options: `?nointro` skips the logo and intro, `?mute` turns the AdLib sound off,
`?level=W.S` starts at world W, sub-level S, `?pick` forces the folder picker, `?debug` shows a
side panel and the status line (tick count, score, unported branches).

This repository ships no game data. For local play:

```bash
npm install
npm run dev          # serves on :5173; game files come straight from game/ and data/
npm run verify       # headless invariant run (needs data/ and game/GAMEU.EXE; no browser)
npm run build:pages  # dist/ holds the playable page and no game data
```

A built page has no `game/` to serve, so it shows **Load folder…** and reads your copy from
disk. Nothing is uploaded, and nothing is ever written back.

## Asset explorer

`viewer.html` (sprites, tiles, maps, pictures, level scripts and MIDI, all decoded in the browser),
`level.html` (the level viewer: map, tile sheet and entity placements) and
`tools/midi-player.html` (the preserved MIDI player; it still needs `npm run extract` output in `build/`) are the explorer pages. The first two read `data/` in the dev server or a picked
folder, so they work on the hosted site too; see `docs/viewer.md` for the controls and `docs/formats/` for the asset formats.

## Project layout

```
game/        your own copy of the game executables (git-ignored, never bundled)
data/        your own copy of the game data files (git-ignored, never bundled)
docs/        subsystem-by-subsystem reverse-engineering findings, with evidence tags
symbols/     Ghidra-derived symbol tables for GAMEU/INTROU/KLOGOPOU
web/core/    isomorphic decoders: RNC, .pak/.pap/.pip/.pin, palettes, LZHUF
web/engine/  the ported game engine, transliterated from the disassembly
web/render/  sprite and tile rendering
web/audio/   the AdLib driver (the original driver bytes run in a tiny 8086 interpreter) and an OPL2 core
web/verify/  the invariant suite behind `npm run verify`
web/play/    the playable page (index.html)
tools/       verify, mutation test, DOSBox capture scripts (attract-capture/, front-capture/, adlib-capture/)
```

`CLAUDE.md` holds the evidence conventions (`[PROVEN]`, `[STATIC]`, `[WF]`, `[UNKNOWN]`) and the
architecture notes. The DOSBox screenshots the sprite and intro checks compare against are not
published; those comparisons are skipped with a note when the files are absent.

## The rule this project runs on

Every claim about the original game says how it was established, and every constant traces to
the disassembly or a captured observation of the real game.

- `[PROVEN]` was executed: decompressed from the shipped bytes, run, or traced live in DOSBox.
- `[STATIC]` was read out of the binary but not confirmed at runtime.
- `[WF]` came from a subagent workflow and is a lead, not a fact.
- `[UNKNOWN]` is not established. Unknowns are registered in `docs/open-questions-history.md`.

Where the port stands in for something not yet decoded, it is labelled in the code and in
`docs/port-plan.md` rather than passed off as the real thing. A check that cannot fail is not
evidence: `tools/lint-checks.mjs` rejects checks where both sides come from project constants.

## Parity with the real game

The method is to port one original function at a time and check each against ground truth
captured from the real game under DOSBox (a Lua script logs the globals and entity records once
per main-loop iteration; the port replays them).

- The whole attract demo (2342 iterations) is reproduced. One-step conformance is entity-exact
  on 2339 of 2339 usable transitions, and a free run, with the engine fed only the first
  captured row, stays exact for 2340 consecutive rows.
- Dozens of live play captures across worlds 1-4, including targeted setups made by poking
  memory (weapons, hurt states, power-ups), replay row for row.
- Sprites match DOSBox video frames pixel for pixel in all four worlds, including the second
  layer over the hero while fire is held (`1000:772C`).
- The AdLib register stream equals a DOSBox capture of the real game, token for token, for all
  82 cues.
- The pre-game screens (Konami/Renegade logo, the intro sequence, the four world intros) equal
  DOSBox video frames by frame hash.

`npm run verify` runs the lint, then the suite, and prints its own totals (currently 401
assertions and 14 notes). `node tools/mutate-engine.mjs` applies plausible mis-ports one at a
time and checks that the suite goes red. A statement counts as `[PROVEN]` only if a mutant of
it is killed, so the survivors it lists are the work queue.

## What is not done

Everything the engine-only fuzz reaches in worlds 1-4 is ported from the disassembly, but only
the branches the live captures exercise are `[PROVEN]`. Still open, among others: the carry-pose
branch of the hero overlay, draw mode 0xb, a few boss and carry/cart handlers, intro sounds, and
sound drivers other than AdLib. See `docs/port-plan.md` and `docs/open-questions-history.md`.
