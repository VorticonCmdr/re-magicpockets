# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Evidence discipline** (adopted from the sibling `../gods-web` project). Every claim about the original game is tagged with how it was established; do not add unverified claims — label unknowns `UNKNOWN_<identifier>` and register them in `docs/open-questions-history.md`.
> `[PROVEN]` = verified by executing something (decompressed the bytes, ran the code, or traced it live under DOSBox).
> `[STATIC]` = read out of the binary (disassembly/decompile) but **not** confirmed at runtime.
> `[WF]` = produced by a subagent workflow and not yet re-read by the maintainer — a lead, not a fact.
> `[UNKNOWN]` = not established.
> Untagged claims in older `docs/*.md` are `[STATIC]` at best; tag them as you touch them. In `symbols/*.json`, `verified` means statically verified (`[STATIC]`) and `guess` means a lead — neither is `[PROVEN]` without a live trace. (There is no `confirmed` tag in the JSON, despite older prose.)
> A corrected claim keeps the old text with a ⚠️ note rather than being silently rewritten.

## What this is

A reverse-engineering + browser-port project for the 1994 DOS game "Magic Pockets" (`GAMEU.EXE`).
Two things live side by side here:

1. **Reverse-engineering documentation** (`docs/`, `symbols/`) — the decoded file formats, the
   Ghidra-analyzed engine internals, and the entity/behavior systems, all derived from the
   original binaries/data under `game/` and `data/`.
2. **A browser port** (`web/`) that reimplements the decoded engine in vanilla JS/Canvas, plus an
   **asset explorer/viewer** (`viewer.html`, `level.html`) for inspecting decoded assets.

Original game files (`game/`, `data/`) are **not committed** — gitignored by design, kept locally
only. Never assume they're present; code must tolerate their absence (folder-picker fallback).

## Commands

```sh
npm install
npm run dev          # Vite dev server at 127.0.0.1, default page is viewer.html
npm run build        # builds dist/ (index.html, viewer.html, level.html, web/index.html, tools/midi-player.html)
npm run preview      # preview the built dist/ with local game assets
npm run extract      # node tools/build-all.js -- regenerates build/ from data/ (legacy pipeline, see below)
```

```sh
npm run verify       # tautology linter, then the headless invariant suite (needs data/ and game/GAMEU.EXE)
npm run lint         # just tools/lint-checks.mjs
```

`npm run verify` runs `web/verify/checks.js` through `tools/verify-node.mjs`. Quote the totals it prints; never copy a count out of a doc. Every `check()` must compare against a literal or a value read from the shipped bytes — `tools/lint-checks.mjs` rejects checks where both sides are project constants. `tools/scope-check.mjs` (`checkScope`, `checkCallOrder`, needs `acorn`) is for asserting statement order in the main tick once it is refactored; it is not wired into `verify` yet.

Legacy/debug-only tools (not part of the port's runtime data path):
```sh
node tools/build-all.js   # regenerate build/raw + build/png from data/ (needed once, or after any decoder change)
node tools/serve.js       # zero-dependency static server for build/-based viewers (file:// blocks fetch())
```

## Architecture

### Two separate data paths — don't conflate them

- **`web/core/*.js`** — isomorphic decoders (RNC depack, `.pak`/`.pap`/`.pip`/`.pin` parsing,
  palettes). Pure functions over `Uint8Array`/`DataView`, **zero `fs`/`Buffer` code**, because
  they run both in the browser (port + viewer, fed by `fetch`/File API) and conceptually mirror
  the Node CLI tools. `tools/*.js` are a parallel/legacy Node (`Buffer`/`fs`) implementation kept
  for the CLI extractors (`build-all.js` → `build/`) — a deliberate fork, not meant to drift
  silently from `web/core/*.js`'s decoding logic. If you fix a decoding bug, check whether the
  same bug exists in both.
- **`web/engine/*.js`** — the actual game engine (camera, collision, entity pool, bytecode VMs,
  player, AI, audio, level registry). This is the playable port at `web/index.html`, driven by
  `web/main.js`.
- **`build/`** is derived output from `tools/build-all.js`, consumed only by `level.html` and
  `tools/midi-player.html` as a fast, no-simulation visual-regression reference. It is **not**
  upstream of the playable port — the port depacks/decodes original files live in the browser via
  `web/loader/asset-cache.js` + `web/loader/asset-source.js`.

### The port's data flow

`asset-source.js` (File API or `fetch` against `data/`) → `asset-cache.js` (lazy, memoized
depack+decode per filename) → `web/core/*.js` decoders → `web/render/canvas.js` draws onto a
single `<canvas>` at native resolution, scaled via CSS (`image-rendering: pixelated`).
`web/engine/loop.js` drives the per-frame update using `requestAnimationFrame`, structured after
the original's 14-call main loop (see `docs/engine.md`).

### Where the ground truth lives

The RE findings are the spec for the port — when engine behavior is ambiguous, check these before
guessing:
- `docs/engine.md` — main loop, entity struct, bootstrap paths, palette/transition system.
- `docs/enemies.md` — `Entity_UpdateBehavior` per-(world,kind) dispatch, AI, collision response.
- `docs/entity-script-vm.md` — the 78-opcode entity bytecode VM (`Entity_RunScript`).
- `docs/formats/*.md` — one doc per on-disk format (`pak`, `pap`, `pip`, `pin`, `pin-level-script`,
  `rnc`), each with a "Verification" section describing how it was checked (CRC16, visual diff
  against DOSBox, etc.).
- `docs/memory-map.md` — fixed addresses/globals referenced by the engine docs.
- `symbols/*.json` — Ghidra-derived symbol tables; functions are tagged `confirmed`/`guess`/
  `verified` for confidence level. Treat `guess` as unverified even if the structure looks solid.
- `docs/port-plan.md` — the phased roadmap **and** the running changelog of what's actually been
  ported vs. intentionally left as a labeled placeholder vs. a genuine open gap. **Read this
  before claiming a system is "done" or "real"** — it documents several past instances where a
  placeholder was mistaken for real data (e.g. collision geometry, spawn positions) and had to be
  walked back after user-reported mismatches with the real DOSBox behavior. When you port a new
  system or find a scope change while implementing one, add an entry here in the same style
  (what's real, what's a labeled stand-in, what's still open) rather than only fixing silently.
- `docs/dosbox-debugging.md` — how to use the `dosbox-mcp` MCP server (live DOSBox-X inspection:
  memory reads, breakpoints, registers) to verify something static analysis can't settle. Prefer
  this over re-reading decompiled output cold when a behavior looks wrong once it's playable.

### Key invariant: placeholders must stay visually/structurally labeled

Several port systems intentionally stand in for not-yet-decoded original mechanics (e.g. bonus
item selection using approximated difficulty inputs, representative-but-not-frame-accurate sprite
poses). `docs/port-plan.md`'s phase write-ups call these out explicitly. When extending one of
these systems, preserve the "this is a known stand-in" signal (comments, doc notes) rather than
letting it silently masquerade as a verified decode — this project has repeatedly been burned by
assuming a placeholder was the real thing.

### Format docs reference the same binaries as the Ghidra project

`ghidra/` holds the Ghidra project analyzing the game executables under `game/` (gitignored,
binary, machine-specific project files). `docs/*.md` narrate what was found there; `symbols/*.json`
are the exported symbol data. Don't expect to open `ghidra/` directly — go through the docs.
