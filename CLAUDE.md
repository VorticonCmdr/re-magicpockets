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

## Sprite rendering

`web/render/sprites.js` (`collectDraws`, `drawEntities`, `buildSpriteAtlas`) transliterates the render pass (call 3, `73A5`/`7419`; draw modes `0xa/0xd/0xe/0xf` at `759D/7D77/79B2/7B6D`): descriptor + frame table -> tile stream -> bank tile, mirrored bank for facing, vertical flip for mode `0xd`. `web/demo/main.js` uses it (`?boxes` keeps the old boxes). `[PROVEN]` live (DOSBox paused, two frames): 2681/2764 sprite pixels identical; bank layout and mirrored banks equal the depacked pak bytes. Screen x is the record's x (the `[8B69]&15` added in the buffer is cancelled by the hardware pan). Unported/unknown: `[8C38]` overlay (`772C`), video-memory grab (fsm 0xffff), mode 0xb. `npm run verify` group `checkSprites` pins the decode.

## Parity workflow (how the port is checked against DOSBox)

The method is gods-web's: port one original function at a time, and check each against ground truth captured from the real game. State as of 2026-10-10 `[PROVEN]` by `npm run verify`: the whole attract demo (2342 iterations) is reproduced, one-step 2339/2339 usable transitions entity-exact, and a **free run** (the engine's own state, fed only the first captured row) stays exact for 2340 consecutive rows.

- **Ground truth.** `tools/attract-capture/capture-full.lua` (loaded through the dosbox-mcp `script_load`, `debug:true`) logs, per main-loop iteration of the attract demo, the globals `DS:0x8B50..0x8CAF`, the pointer array `P`, visible list `L`, spawn queue `Q` and the first 120 entity records `B`. `import-entities.mjs` writes `entities-full.capture.json.gz` (committed, 2342 rows, per-row changes only). Limits (1M Lua instructions: one block read per poll; 64 KB output cap) and how to reach the demo: `docs/dosbox-debugging.md`. The demo is deterministic across runs.
- **One-step conformance.** `node tools/attract-capture/conformance.mjs --ignore-scratch [--only N] [--show DONE] [--top K]` (accepts the `.gz`; `--ents` defaults to 999) loads each captured row into a `DsMemory`, runs one `stepIteration` and diffs the next row. The mismatch histogram and the "unported branches hit" list are the work queue.
- **Free run.** `runFreeRun(env, rows, {skip})` in `web/verify/conformance-lib.js` loads only the first row, then steps the engine alone and reports the first mismatching row, its byte diffs and the unported tags hit. Divergence here means a missing port, not a bad sample; use it to rank work.
- **Sampling model.** A row is the last poll before the demo tape key changes. Step model per transition = calls `[5, 6, 7, 8, 12, 13, 1, 2, 3]` (capture point = after call 3). The tape stalls while `[8BA1]==0x45`. Rows 197/198 are mid-call-6 samples (`midConsumeParticles` signature check, `MID_CALL_SAMPLES`), exempted by signature, not by masking.
- **Entity list shape.** Records 0x42 bytes at `DS:0x9398..0xB918`; pointer array `0x9090`; spawn groups 1/2 live in a front list at `0x91AE..0x91BA` (terminator `0xFFFF` at `0x91BC`), groups 3/4/6 are inserted, group 5 goes to the front list as class 7. The spawn queue grows down from `[8BB5]` (floor `0x926A`).
- **Level data and boot.** The attract demo's level script is `data/level0.pin` (unpacked at DS:0; big-endian list-pointer table, `[1]=0x40`), its map is `data/pcmap.pap`. `bootFromFiles` (`web/verify/conformance-lib.js`, via `web/engine/boot.js`) starts the demo from those files plus `GAMEU.EXE` alone and is checked against row 0 (byte exact) and a free run of all 2341 rows (entities). `world 1` uses `new1.pin`.
- **Live play (not the demo).** `tools/attract-capture/capture-live.lua` / `capture-live-drive.lua` log one row per main-loop iteration of real play (GAMEU starts at a world map: Enter picks world 1, then "THE CAVE / READY!") ⚠️ `[PROVEN]` 2026-10-10 (DOSBox video of a fresh start and four warps): there is no interactive world map and no key is read at start; "world map" was the world intro screen (below), which is followed by the level on its own.. An iteration is detected by the RNG word `[8B71]` changing, so rows are sampled just after call #13; the `-drive` variant injects a seeded random keyboard (`dosbox.key('KBD_right', true)`; the bridge's `input_key` also needs `KBD_*` names). `import-entities.mjs` handles both formats (the live P block is the whole 302-byte pointer array, holes included). `node tools/attract-capture/conformance-live.mjs [capture.json.gz] [--ent-fails]` (or `runLiveConformance`) feeds each next row's input words to call #7 and diffs entities and globals; rows sampled between call #8 and #13 are detected from the RNG carry sequence and skipped. `live1/live2/live3.capture.json.gz` are the committed captures (live3 is invulnerable: `--god`, `[8B96]` pinned, and covers the whole of level 1); `runLiveFree` + `bootFromFiles(env, new1.pin, {world:1, sub:1, demo:false})` replays one from the files alone. `npm run verify` ratchets all of it. **Never `git add web`** — the working tree holds the user's own `web/` edits.
- **Porting rule.** Transliterate the disassembly (`build/analysis/dis.sh <CS offset> <lines>`, which adds `0x340` itself; code `1000:xxxx` = file `0x340 + xxxx`; **DS offset 0 = file offset `0x5E170`**, live DS `0x5FD8`, CS `0x1F5`), keep the `1000:` address in a comment, and send every branch you have not read to `ctx.unported` rather than guessing. Docs written from the Ghidra decompile have been wrong about operand semantics; the disassembly wins.
- **Ratchets.** `web/verify/checks.js` asserts the exact counts above; raise them when you port more, never lower them.
- **Still unported** (`ctx.unported` tags): the title and Bitmap Brothers pictures (they live in INTROU.EXE/KLOGOPOU.EXE, not GAMEU); opcode 38 (level-code entry) is `[PROVEN]` for its cursor/glyph/confirm rules against 49 live transitions (`checkCodeEntry`), `[STATIC]` only for its wait structure and key-repeat timing; `EE60` (target 0x43 touching a kind-6 entity), `4A40`. Everything the engine-only fuzz (`ITERS=10000`, several seeds) reached in worlds 1–4 is ported from the disassembly, but **only the branches the live captures exercise are `[PROVEN]`**: the rest (power-up frames, 5DBA, 59B5 doorway, pair classes 2/3/10–12/14, carry/skate/cart/burden handlers, opcode 13 types 0x21/0x30/0x4d/0x28/0x5f/0xe/0x1b/weapon 0x27, opcode 68 boss branches, opcode 70/73, 4269 modes 0x1b/0x27/0x40) is `[STATIC]` until a capture reaches it.
- **Any level, from a clean start.** The shipped game warps to every level with a code: press **F2**, then four digits within about 20 iterations (`docs/dosbox-debugging.md`, "Automating the level-code warp"; the 30 codes are listed there). The file each level loads is in `web/engine/level-registry.js` (`LEVEL_FILES`, asserted against DOSBox memory dumps by verify). A captured segment is compared by booting the level's `.pin` and `.pap` with `bootFromFiles` (+ one `stepIterationAfterRng`), seeding `[8B71]`/`[8B6B]` from the warp row (a warp does not reseed the generator), and `runLiveFree({ checkRng: true })`; end each segment where the next code starts being typed (the prompt entity is not modelled). Call #13's carry depends on the level (`call13Carry`). When a mismatch needs real internals, replay the capture's input schedule, `debug_pause`, add an execute breakpoint with a memory `condition` (it works), resume and read memory.
- **Front end** (`web/engine/frontend.js`, `demo.html?game` via `web/demo/game.js`; `npm run verify` group `checkFrontend`). GAMEU's only screens outside the loop are the **world intro** inside each `World*_LoadBanks` (`B56B/B6F0/B8B7/BA3C`; `new.pip` composed from rectangles by `BD0A`, 8 fade banks 0x16-0x1D in at 2 vsyncs each, 5 x (box 11 + empty 11 vsyncs), 8 fade out; no key read) and the **level dispatch** `03FF`/`07EB`/`06E3`. `[PROVEN]` pixel for pixel, fade palettes and frame timing against DOSBox videos of all four worlds (`tools/front-capture/`, importer documented there); the dispatch is `[STATIC]` but its file names equal the `[PROVEN]` level table. The hold between fade-in and blink is disk time (stand-in, `?hold=N`). ⚠️ superseded 2026-10-10: the screens before GAMEU are ported, see **Pre-game screens** below. Ending (`06E3`, world 4 sub 10) shows `endscrn.pip` only. Opcode 37 operand > 0 (`3216` -> `00CA`) and `startWorld` are `[STATIC]`.
- **AdLib sound** (`docs/formats/pin-sound.md`; `web/audio/{x86-lite,pin-driver,trace-replay,opl-player,opl2-chip}.js`, `web/demo/sound.js`; `demo.html?game&sound`; `npm run verify` group `checkAdlibDriver`). `data/player.pin` is the driver's code and `data/adlib.pin` its 82-cue bank (SMFs with an OPL2 timbre meta event; ids 11/52/59/69 digram-compressed). The original driver bytes run in a tiny 8086 interpreter; its OPL2 register stream equals a DOSBox capture of the real game token for token (`tools/adlib-capture/chain.trace.gz`: INIT, all 82 cues, the demo's own commands; method and the three traps in the doc and `make-patch.mjs`). Tick = command 2 at 50.159 Hz (PIT `0x5CEC`); `1CCF` has no priority (`BL` is the OPL channel base). The engine's sound requests go through `ctx.sound(id, kind)` (copied to `m.sound` by `stepIteration`; sites call `m.sound?.(id)`) and equal the real game's over the captured demo window. No background music on AdLib; `adlib2/3.pin` owner and the intro-phase sounds are open. To redo a capture set `pockets.ini` line 1 to `Adlib` (restore `Beeper` after: the frame-exact checks used it), start a FRESH GAMEU, patch within a few seconds.
- **Staging.** Commit with explicit file names. `git add web` / `web/engine` can sweep in unrelated uncommitted work.

- **Browser check** `[PROVEN]` 2026-10-10: `npm run dev`, `/demo.html?play` loads the game files from `/game` and `/data`, boots world 1 level 1 through the ported engine, draws the sprite renderer's output (hero, "THE CAVE / READY!" banner, tiles) with no console errors and `unported: none`; arrow keys reach the engine. This is a smoke test, not a parity check.
- **Sprite structural scan** `[PROVEN]` (2026-10-10): `node tools/sprite-scan.mjs` runs every 25th row of the 25 live captures (worlds 1-4) through `collectDraws`: no draw command names a tile outside its bank. The only unresolved cells are types 23/28/64/82 in draw mode 0xe (frameSourceMode other than 0/1: the original reads video memory there), 85 cells in all. This does not check pixels; worlds 2-4 pixel parity still needs a live DOSBox frame per world.
- **Sprites in worlds 2-4** `[PROVEN]` (2026-10-10, live): for each of worlds 2, 3, 4 a ZMBV video of the running game plus a per-frame Lua dump of the entity block (`tools/sprite-video-compare.mjs <world> <dump.log> <video.rgb>`; recipe in its header) was matched against the port's rasteriser (`web/render/sprite-raster.js`): every sprite pixel inside the 192-line view equals the DOSBox pixel (100% on all 14 frames per world; the earlier ~97% in world 1/2 was sprites reaching below line 192, the HUD strip). One reference frame per world is committed in `tools/sprite-video/` and asserted by `checkSpriteWorlds`. Still open: the `[8C38]` overlay (`772C`) and draw mode 0xb were not on screen in these frames.
- **`[8C38]` overlay (`772C`) probe** `[PROVEN]` negative (2026-10-10): writing the hero's own frame (64) into `[8C38]` from a Lua script on every frame of world 1 level 1 changed nothing on screen (16 consecutive frames still 100% equal to the port's render without an overlay), so the overlay is not drawn from that value alone; it stays `[UNKNOWN]` (it is gated on `[8C77]`, the last entity drawn, and on game states a plain write does not create).
- **Pre-game screens** (`web/engine/klogo.js`, `web/engine/intro.js`, `web/core/lzhuf.js`; `demo.html?game&intro`; `npm run verify` group `checkPrelude`; details docs/launcher.md "What the two programs show"). pockets.exe runs KLOGOPOU.EXE (the **Konami/Renegade** screen, not Bitmap Brothers: LZHUF picture in an EJWLIB archive after the MZ image, 32-step +-2 DAC fade, 5 s hold on the 50.02 Hz PIT tick, so its video frames are torn) then INTROU.EXE (captions, four close-ups, MAGIC POCKETS title with twinkling stars, LOADING: a script of blits and palette-bank switches whose every wait comes from a per-sound-driver word table, the AX operands in the code are dead) then GAMEU. `[PROVEN]`: all 440 KLOGO frames and the 431 INTROU screens equal the DOSBox video by 64-bit frame hash (`tools/front-capture/prelude.capture.json.gz`, procedure in `import-prelude.mjs`; durations within 0.3%, the capture runs slightly long). `[STATIC]`: key abort paths, other sound drivers/video modes, the ending screen's palette (`06E3` sets none; the page uses world 4's). Disk-load time before the first caption is a stand-in (`?load=N`). Open items: docs/open-questions-history.md 26-27. `game/KLOGOPOU.EXE` / `game/INTROU.EXE` are local-only like the rest of `game/`; verify prints a note and skips when they are absent.
- **`[8C38]` overlay, natural trigger** (2026-10-10, live): an execute breakpoint at `CS:772C` with the condition `[8C38] != 0` fired during real play (hero frame 101, facing 8, world 1; `[8C38]` = 75, `[8C77]` = 0 at entry). At the draw tail `759D` BX pointed at the `E4FA[75]` stream, whose first bytes are `76 77 34 35 36 37 ...` (bank 2 half tiles: tile 38 top and bottom, then more), DI = 3582 (one scanline below the hero's own start). Fitting bank-2 tile 38 behind the hero tile 37 (which matches the DOSBox screenshot 427/427 at (144, 82)) reaches only ~95% of the composited pixels, so the overlay's exact placement and bank are still `[UNKNOWN]`; the other object on screen was an ordinary bank-6 entity, not the overlay. A clean answer needs the pixel diff of a paused frame against the port with the entity block dumped to disk at the same moment (the bridge cannot save `mem_read` output to a file).
- **Full-flow browser run** `[PROVEN]` 2026-10-10: `demo.html?game&intro` in Chrome: the Konami/Renegade logo renders correctly; fast-forwarding with `window.__mpGame.tick()` (the tab is `document.hidden` under automation, so `requestAnimationFrame` is throttled to ~1 Hz there, which is an environment artefact, not a page bug) took 4981 ticks from the logo through loading, the INTROU sequence and the world 1 intro to play, then 300 engine iterations: world 1 sub-level 1, `unported: none`, no console errors. Real-time pacing in a visible tab was not measured.
- **Targeted setups by memory pokes** `[PROVEN]` method (2026-10-10): a Lua capture script writes chosen bytes (e.g. `[8C04]` weapon/pickup modes 0x27/0x1B/0x40/0x45/0x2A, hero mode `[8B98]` = 0x1A/0x43/1/0x15/0x41, the hurt timer) right after logging a row and logs `POKE row addr`; the replay passes `pokes: [{row: loggedRow + 1, addr, bytes}]` to `runLiveFree` (the 6th element of a ratchet entry in `web/verify/checks.js`). It forces states random play almost never reaches and found two real bugs at once (opcode 70's facing test was inverted; `F675`, the burden landing, was unported). Caveat: some pokes hang the original too (`[8C04] = 0x1D` with no class-0x1A item loops forever in `4539`/`C192`), so a capture that stops logging means the game hung, not the script.
