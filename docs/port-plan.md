# Plan: a playable HTML/JS port of Magic Pockets, loading original files at runtime

Goal: a browser-playable reimplementation of `GAMEU.EXE`'s gameplay that reads the **original,
unmodified game data files** (`data/*.pak`/`.pap`/`.pip`/`.pin`, still RNC-ProPack-compressed,
exactly as shipped) directly at load time — no offline extraction step, no baked PNG/JSON
artifacts committed to the repo or generated as a prerequisite to play. The existing
`build/`-based pipeline (`tools/build-all.js` → `build/raw`/`build/png`) stays exactly as it is
today, as a **debugging/verification aid** (the CLI extractors + `tools/viewer.html` are how we
validate a decoder before trusting it in the live engine) — it is not the runtime data path for
the port itself.

This matters architecturally: every format decoder gets used in two contexts (a Node CLI tool
that reads from `fs`, and a browser engine that reads from `fetch`/`File`/`ArrayBuffer`), so the
decoders must be written as **pure functions over bytes** (`Uint8Array` in, structured JS objects
or typed pixel buffers out) with zero `fs`/`Buffer`-specific code inside them. That refactor is
Phase 0 below and unlocks everything after it.

## Why this is realistic

Unusually for a from-scratch reverse-engineering port, almost every system this game needs has
already been decoded to the instruction level and cross-referenced against `docs/*.md`:

| System | Status | Reference |
|---|---|---|
| RNC ProPack depack | **Bit-exact, verified 60/60 files against embedded CRC16** | `docs/formats/rnc.md`, `tools/rnc.js` |
| `.pak` sprite/tile banks (5 on-disk layouts) | Fully decoded, visually verified | `docs/formats/pak.md` |
| `.pap` level tile maps | Fully decoded (row-major, 32×16 tiles, 1-based index into `blocksN.pak`) | `docs/formats/pap.md` |
| `.pip` full-screen pictures | Fully decoded, palette-matched against a real screenshot | `docs/formats/pip.md` |
| Level-script `.pin` files (entity placement) | Fully decoded record format, visually verified against rendered levels | `docs/formats/pin-level-script.md` |
| Sound-effect/music `.pin` files | 161 real MIDI files recoverable with zero driver decoding; container format for the rest understood | `docs/formats/pin.md` |
| Per-world VGA palettes | Extracted directly from the binary, code-derived (not guessed) | `docs/memory-map.md` |
| Main game loop (14 calls/frame) | Fully enumerated and characterized | `docs/engine.md` |
| Entity struct layout (66 bytes) | Field-by-field, spawn-time provenance traced | `docs/engine.md` |
| Entity behavior dispatch (`Entity_UpdateBehavior`) | Decoded branch-by-branch for every class 0–7 | `docs/enemies.md` |
| Ground collision & breakable-tile mechanic | Decoded to concrete per-world/per-type detail | `docs/engine.md`, `docs/enemies.md` |
| Entity-script bytecode VM (`Entity_RunScript`, 78 opcodes) | Every opcode characterized, 2 example scripts decoded byte-exact | `docs/entity-script-vm.md` |
| Movement-AI bytecode VM (`Entity_RunMovementAiScript`, 6 opcodes) | Every opcode characterized, all 3 tables dumped byte-exact | `docs/enemies.md` |
| Bonus-item selection heuristic | Decoded branch-by-branch, all difficulty-input globals traced to producers | `docs/engine.md` |
| Input subsystem | Fully found (ISR, key-binding table, joystick fallback) | `docs/memory-map.md` |
| Sprite rendering pipeline (masked blit, edge-clip family) | Fully decoded, plane order and mask semantics confirmed | `docs/memory-map.md`, `docs/formats/pak.md` |

In short: the **decoding** phase of this project is essentially done for everything a first
playable build needs. What remains is largely **transliteration** (the same technique already
used successfully for the RNC depacker: port disassembly/decompile straight to JS, function by
function) plus building a browser engine shell around it. The main open items (below) are narrow
and mostly non-blocking.

### Known gaps / open items (tracked so nothing gets silently assumed away)

- **RESOLVED: frame/tick rate.** `Sys_InstallCustomTimerHandler` (`1000:2035`) reprograms PIT
  channel 0 with reload value `0x5cec` (23788: `OUT 0x43,0x36` mode-3 select, then `OUT 0x40,0xec`
  / `OUT 0x40,0x5c` low/high reload bytes) — `1193182 / 23788 ≈ 50.15 Hz`. But this installs a
  reentrant background ISR (`1000:2087`, its own private stack, a `CS:[0x2197]` reentrancy guard)
  running independently of the visible game loop, **not** the main loop's pacing source. The main
  loop's actual frame pacing is call #14, `Video_WaitVsyncAndCountFrame` — a busy-wait for the
  real display's vsync (EGA/VGA hardware rate, ~60-70Hz depending on mode), each of the 14 calls
  per that wait. Conclusion: `requestAnimationFrame` (the browser's own vsync-paced callback) is
  the correct analog for the main loop in Phase 2, not a `0x5cec`-derived interval timer. The
  ~50.15Hz ISR most plausibly drives the sound driver's own tick (a common DOS-game pattern,
  keeping music/SFX timing independent of variable display refresh rates) — revisit its exact role
  only if Phase 7 (audio) needs frame-accurate MIDI timing; non-blocking for Phase 2 onward.
- **`frameSourceMode === 0` indirect sprite addressing** (~30% of bank 7 entities, most of bank
  2's, some of bank 3's): tile index comes from an undecoded near-pointer table walk. Non-blocking
  for a first playable build — falls back to a colored placeholder like `tools/viewer.html`
  already does; revisit once the core loop is playable.
- **Sound**: only MIDI-cue playback (`roland.pin`/`adlib.pin`/`roland2.pin`) is asset-ready; the
  native OPL2/OPL3 register-stream format (`adlib2/adlib3/sblaster.pin`) is undecoded. Per the
  existing project plan, sound is explicitly the **last** priority — first playable ships with
  either no audio or MIDI-only audio via Web Audio/Web MIDI, real OPL2 synthesis is a stretch goal.
- **CGA/Tandy alt-build path** (`1ffb` segment): fully out of scope — the port targets the VGA/
  `'C'`-driver rendering path only, which is what `pockets.ini` actually ships with.
  `pockets.com`/`pockets.exe` (copy-protection TSR + launcher) are also out of scope entirely —
  the port talks to `GAMEU.EXE`'s *data files* and reimplements its *logic*, it does not need to
  reimplement the DOS launch chain at all.
- **`blocks*.pak` render path** is resolved (see `docs/formats/pak.md`) — direct 4-plane 32×16
  tile copy, no masking, indexed 1:1 by `.pap` cell value. No open risk here.
- **Demo/attract mode, level-select cheat console**: real subsystems, fully documented, but not
  needed for a first playable build. Nice-to-have dev tools later (the cheat console in particular
  is genuinely useful as an in-port level-select/debug overlay).

## Data-loading architecture (the constraint the user asked for)

**No pre-extraction step is part of the play path.** Concretely:

1. The port ships as static HTML/JS/CSS with **no game assets embedded or committed** (`data/` is
   already gitignored — "original game content, kept locally only" — and stays that way; nothing
   changes here, we just also stop relying on `build/` at runtime).
2. On load, the page lets the user point it at their own legally-owned copy of the game data — a
   local folder/zip picked via `<input type=file webkitdirectory>` or drag-and-drop, or (for local
   dev) `fetch()` against a `data/` folder served by `tools/serve.js`. Either path ends up as a
   `Map<filename, ArrayBuffer>` handed to the engine — the loading UI is a thin, swappable shim,
   not something the engine core depends on.
3. Every `.pak`/`.pap`/`.pip`/`.pin` file is **RNC-depacked in-browser** (the existing
   `tools/rnc.js` logic, ported off `Buffer` onto `Uint8Array`/`DataView` — see Phase 0) the first
   time it's needed, then decoded straight into the in-memory structures the engine wants
   (pixel buffers for sprite/tile atlases, typed arrays for tile-index grids, parsed
   record lists for entity-placement scripts) — held in memory only, never written back to disk.
   A simple `Map`-based cache avoids re-depacking a file that's referenced by multiple levels
   (e.g. `extras.pak` is shared across all four worlds).
4. This is strictly *more* faithful to "loaded from original files" than the current
   `build/`-pipeline demo tooling, and it's also simpler to distribute (no `node tools/build-all.js`
   prerequisite for a player) — the only cost is depack/decode happens once at level-load time
   instead of at a separate build step, which is cheap (RNC depack of a full 60-file asset set
   already runs well under a second in Node; per-level lazy loading in-browser will be faster
   still since only the current world's files load).
5. `tools/build-all.js`/`build/`/`tools/viewer.html` are **kept as-is** — they remain the fast
   offline way to sanity-check a decoder change (diff a PNG, inspect JSON) without booting the
   full engine. They just stop being upstream of the playable build.

## Proposed module layout

```
web/
  core/                    # isomorphic decoders — pure functions, Uint8Array/DataView only
    rnc.js                 # ported from tools/rnc.js (drop Buffer.alloc -> new Uint8Array)
    pak.js                 # ported from tools/ega.js + extract-pak.js's format-detection logic
    pap.js                 # level tile-map parsing (tools/extract-pap.js's core, minus the CLI/PNG bits)
    pip.js                 # full-screen picture decode
    pin-level-script.js    # entity-placement record parser (ported from tools/extract-level-script.js)
    pin-sound.js           # MIDI-cue resource-table parser (ported from tools/extract-pin.js)
    palette.js             # re-exports tools/palette.js's WORLD_PALETTES verbatim (already isomorphic)
    shapes.js              # loads symbols/entity-shapes.json (Ghidra-derived, not regenerable — shipped as static JSON, same as today)
  loader/
    asset-source.js        # abstracts "where do file bytes come from" (File API / fetch) behind one interface
    asset-cache.js         # filename -> depacked-and-decoded resource, lazy + memoized
  engine/
    entity.js              # entity struct (typed-array-backed or plain objects; see Phase 2 note), free-list allocator (140-slot array, matches Entity_FreeSlot/Entity_SpawnFromQueuedEvent)
    entity-script-vm.js     # Entity_RunScript's 78-opcode interpreter
    movement-ai-vm.js       # Entity_RunMovementAiScript's 6-opcode interpreter
    behavior.js             # Entity_UpdateBehavior per-(world,kind) dispatch tables
    ground-collision.js     # Entity_ResolveGroundCollision + breakable-tile pipeline
    bonus-items.js          # Entity_ChooseAndSpawnBonusItem heuristic
    camera.js               # Camera_UpdateScroll
    input.js                # Input_ReadState equivalent, keyboard-event-driven instead of ISR-driven
    rng.js                  # the 16-bit LFSR, Rng_NextValue
    hud.js                  # score/glyph rendering
    loop.js                 # the 14-call frame driver, requestAnimationFrame-paced
  render/
    canvas.js               # blit atlases onto a Canvas2D backbuffer at the game's native 320x192 (or 352-virtual-width w/ pixel-panning) resolution, scaled up via CSS (image-rendering: pixelated) -- same technique tools/viewer.html already validated
  audio/
    midi-player.js          # adapted from tools/midi-player.html's Web-Audio oscillator synth
  main.js                   # boot: asset picker -> world/level select -> loop.start()
index.html
```

`tools/*.js` keep working unmodified as CLI utilities during this refactor — Phase 0 factors their
shared decode logic out into `web/core/*.js` and has the CLI tools import from there (or, if that
churn isn't worth it mid-port, `web/core/*.js` starts as a deliberate fork of the CLI logic with a
`Buffer`→`Uint8Array` mechanical find/replace; either is fine, but **do not silently duplicate and
let them drift** — pick one and note the decision in the file headers).

## Phased roadmap

Each phase ends in something visibly checkable (a screenshot, a playable slice) before moving on
— this mirrors how the reverse-engineering itself progressed (decode → visually verify → move on),
and catches transliteration mistakes early rather than at the end.

### Phase 0 — Isomorphic decoder core (foundation, no gameplay yet)
- Port `tools/rnc.js`, `tools/ega.js`, `tools/palette.js`, `tools/extract-pap.js`'s grid parser,
  and `tools/extract-level-script.js`'s record parser off `Buffer`/`fs` onto `Uint8Array`/`DataView`.
- Build `web/loader/asset-source.js` + `asset-cache.js`.
- **Checkpoint**: a bare HTML page that lets you pick a `data/` folder, depacks `blocks1.pak` and
  `level1a.pap` in-browser, and draws the level to a `<canvas>` — i.e. `tools/viewer.html`'s
  functionality, but with real-file-picker input and in-browser RNC depack instead of reading
  pre-extracted `build/png/*.json`. This *is* the proof that the runtime-loading constraint works
  end to end before any gameplay code is written.

### Phase 1 — Static world rendering
- Port the sprite-shape-descriptor resolution (`Entity_LookupShapeDescriptor`,
  `symbols/entity-shapes.json`) and the level-script entity-placement decoder.
- Render a full level: background tiles (`blocksN.pak` via `.pap`) + every placed entity's sprite
  (reusing `tools/viewer.html`'s already-proven `frameSourceMode`-based resolution logic) as a
  static scene, no simulation yet.
- **Checkpoint**: every world's level(s) render correctly, side-by-side comparable to
  `tools/viewer.html`'s existing output (which is itself already checked against DOSBox
  screenshots for palette correctness).

### Phase 2 — Core loop skeleton + camera + input
- Port the 14-call main loop's *structure* (`docs/engine.md`'s table) as an explicit
  `loop.js` driver, initially with most calls as no-ops except:
  `Camera_UpdateScroll`, `Video_FlipAndScroll`'s scroll/pixel-panning math (as a canvas
  transform, no real hardware pixel-panning register to emulate), `Input_ReadState`
  (keyboard-event-driven), `Rng_NextValue`, `Video_WaitVsyncAndCountFrame` (→
  `requestAnimationFrame` frame pacing; resolve the open tick-rate question here).
- Decide and lock the entity struct representation (a plain JS object per entity is almost
  certainly fine at this game's scale — ~146 max entities, not a perf-critical count; a typed-array
  SoA layout is over-engineering unless profiling says otherwise).
- **Checkpoint**: the camera scrolls smoothly over a static level in response to keyboard input,
  matching the original's 32px-tile/16px-tile split-scroll math and sub-tile pixel-panning
  remainder.

### Phase 3 — Entity simulation: behavior + collision
- Port `Entity_UpdateAll`'s dispatch (`Entity_UpdateBehavior` always, `Entity_RunScript`
  conditionally), the entity free-list allocator (`Entity_FreeSlot`/`Entity_FindFreeSlot`,
  ~146-slot array), and `Entity_SpawnFromQueuedEvent`'s factory (including the `[8bb5]` event
  queue `Entity_PushSpawnEvent`/`Level_UpdateEventQueue` round-trip).
- Port ground collision (`Entity_ResolveGroundCollision` and its per-(world,kind) transition
  tables) and the breakable-tile mechanic.
- **Checkpoint**: the player entity can walk, be blocked by/land on level geometry, and break
  blocks; other entities exist and are visible in the world but don't act yet (idle sprites).

### Phase 4 — The two bytecode VMs
- Port `Entity_RunScript` (78 opcodes: movement, spawn, sound, palette-fade, the CALL/RETURN
  subroutine mechanism, the `[0x8ba1]` AI-freeze flag, scroll-width control) and
  `Entity_RunMovementAiScript` (6 opcodes over the 3 dumped 20-byte tables) as straightforward
  interpreter loops — both are already fully characterized, this is transliteration, not
  discovery.
- Wire `Entity_SetStateAndScript`'s two tables (`0xcd88` positive, `0xd996` negative) so entities
  pick up their default scripts correctly.
- **Checkpoint**: patrol/chase/gate/sleeper enemies behave correctly — the actual "the game plays
  itself for NPCs" milestone.

### Phase 5 — Player-specific systems, HUD, bonus economy
- Port `Entity_ApplyComplexGroundResponse` (the class-3/player-specific ground-response branch),
  player input→movement mapping, the interaction-phase table
  (`Entity_HandleSpecialInteraction`/`Entity_InteractionPhaseJumpTable`), pickups/hazards.
- Port `Entity_ChooseAndSpawnBonusItem`'s full heuristic and its six difficulty-input globals,
  score popups, and `Hud_UpdateScoreDisplay`'s custom glyph rendering (needs the glyph bitmap
  source — likely inside `extras.pak`'s HUD/digit tiles, already extracted; confirm the exact
  glyph→tile mapping from the `-0x44`/`+0xBC` ASCII-offset scheme noted in `docs/engine.md`).
- **Checkpoint**: a fully playable single level — move, jump, collect, break blocks, take damage,
  see score/HUD update, die/respawn or reach an exit.

### Phase 6 — World/level flow
- Port world selection, `World1-4_LoadBanks`, level transitions (`Fx_UpdateTransition` palette
  fade), and enough of `Level_RunScriptedEventStream`'s static event stream (the `0xAAAA/BBBB/
  CCCC/DDDD` control markers) to get from one level to the next.
- Level-select (skip the DOS cheat-code UI; expose it as a normal dev/debug menu instead — no
  reason to make players enter a hidden 4-digit code once this is a real port).
- **Checkpoint**: multiple levels/worlds are reachable and playable in sequence.

### Phase 7 — Audio (explicitly last, per the existing project priority)
- MIDI-cue playback for sound effects/music using the already-recoverable `roland.pin`/
  `adlib.pin`/`roland2.pin` cues (`docs/formats/pin.md`), triggered from the ported
  `Snd_TriggerEffect` call sites already present in the ported entity/behavior code from earlier
  phases (they just no-op until this phase lands). Reuse/extend `tools/midi-player.html`'s Web
  Audio oscillator synth, or swap in a proper soundfont-based player for better timbre.
- Stretch goal, not required for "playable": real OPL2 register-stream synthesis for
  `adlib2/adlib3/sblaster.pin` and the non-MIDI `adlib.pin`/`roland.pin` table entries — would
  need decoding the driver interpretation loop first (open item, see `docs/formats/pin.md`).

### Phase 8 — Polish / parity pass
- Diff against DOSBox for the specific behaviors that were "confirmed structure, guessed
  semantics" during reverse-engineering (anything tagged `guess` rather than `verified` in
  `symbols/gameu.json`) — this is the natural point to spend `dosbox-mcp` tracing time
  (`docs/dosbox-debugging.md`) on any behavior that looks visibly wrong once it's actually playable,
  since live A/B comparison is far more efficient than re-reading decompiles cold.
- Resolve `frameSourceMode === 0` indirect sprite addressing if any commonly-visible enemy still
  falls back to a placeholder dot.

## Testing/verification strategy

- **Decoder correctness**: keep using the existing CRC16/visual-render verification loop
  (`docs/formats/*.md`'s "Verification" sections) — Phase 0's ported decoders should produce
  byte-identical output to the current Node CLI tools on the same input; a small parity test
  script (`node --experimental-vm-modules` or just running both code paths in Node against a
  `Uint8Array` view of the same buffer) is worth writing once, not maintaining forever.
- **Behavioral correctness**: for anything not already nailed down to "verified" in
  `symbols/gameu.json`, prefer a live DOSBox A/B comparison over guessing — the workflow and
  gotchas are already written up in `docs/dosbox-debugging.md` from this project's prior sessions.
- **Regression baseline**: `tools/viewer.html` + `build/` stay as a cheap, fast, no-simulation
  reference for "does this level/sprite/palette look right" — much faster to iterate on than
  booting the full engine, so keep using it for that narrow purpose throughout.

## Explicit non-goals (v1)

- CGA/Tandy/PCjr alt-build rendering path (`1ffb` segment).
- `pockets.com`/`pockets.exe` copy-protection and DOS launch chain — irrelevant to a browser port.
- Demo/attract-mode playback and recording (the RLE input-buffer system) — not needed to play.
- Real OPL2/MT-32 synthesis — MIDI-cue playback is the audio target for a first playable build.
- Multiplayer/anything not in the original single-player game — out of scope by definition.

## Suggested immediate next step

Start Phase 0: port `tools/rnc.js` to operate on `Uint8Array`/`DataView` instead of `Buffer`
(the smallest, highest-leverage piece — nothing else works without it), and stand up the
minimal file-picker → in-browser-depack → canvas-render checkpoint page described above. That's
a self-contained, demoable slice that proves the "no pre-extraction" constraint holds before any
gameplay logic gets written.
