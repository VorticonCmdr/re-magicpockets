# Plan: a playable HTML/JS port of Magic Pockets, loading original files at runtime

Goal: a browser-playable reimplementation of `GAMEU.EXE`'s gameplay that reads the **original,
unmodified game data files** (`data/*.pak`/`.pap`/`.pip`/`.pin`, still RNC-ProPack-compressed,
exactly as shipped) directly at load time — no offline extraction step, no baked PNG/JSON
artifacts committed to the repo or generated as a prerequisite to play. The existing
`build/`-based pipeline (`tools/build-all.js` → `build/raw`/`build/png`) stays exactly as it is
today, as a **debugging/verification aid** (the CLI extractors + `level.html` are how we
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
  for a first playable build — falls back to a colored placeholder like `level.html`
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
5. `tools/build-all.js`/`build/`/`level.html` are **kept as-is** — they remain the fast
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
    canvas.js               # blit atlases onto a Canvas2D backbuffer at the game's native 320x192 (or 352-virtual-width w/ pixel-panning) resolution, scaled up via CSS (image-rendering: pixelated) -- same technique level.html already validated
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
  `level1a.pap` in-browser, and draws the level to a `<canvas>` — i.e. `level.html`'s
  functionality, but with real-file-picker input and in-browser RNC depack instead of reading
  pre-extracted `build/png/*.json`. This *is* the proof that the runtime-loading constraint works
  end to end before any gameplay code is written.

### Phase 1 — Static world rendering
- Port the sprite-shape-descriptor resolution (`Entity_LookupShapeDescriptor`,
  `symbols/entity-shapes.json`) and the level-script entity-placement decoder.
- Render a full level: background tiles (`blocksN.pak` via `.pap`) + every placed entity's sprite
  (reusing `level.html`'s already-proven `frameSourceMode`-based resolution logic) as a
  static scene, no simulation yet.
- **Checkpoint**: every world's level(s) render correctly, side-by-side comparable to
  `level.html`'s existing output (which is itself already checked against DOSBox
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

### Phase 3 — Entity simulation: behavior + collision (DONE, with one scope change)
- Ported the entity free-list allocator (`EntityPool`, `web/engine/entity-pool.js`, matching
  `Entity_FreeSlot`/`Entity_FindFreeSlot`'s ~146-slot capacity) and a `Entity_SpawnFromQueuedEvent`
  stand-in that spawns every on-map level-script entity's generic (type, X, Y) fields. Not yet
  ported: `Entity_UpdateAll`'s conditional `Entity_RunScript` call, and the `[8bb5]` dynamic
  spawn-event queue round-trip (`Entity_PushSpawnEvent`/`Level_UpdateEventQueue`) -- both need the
  bytecode VM from Phase 4 to be meaningful, so they're deferred there.
- **SCOPE CHANGE, found while implementing this phase**: `Entity_ResolveGroundCollision` and the
  breakable-tile mechanic are NOT ported -- they're still genuinely undecoded (dense per-(world,
  kind) dispatch, ~600 decompiled lines, always flagged as future work in docs/engine.md). Worse,
  the natural placeholder assumption ("`.pap` cell value 0 = passable") turned out to be actively
  wrong: every real `.pap` file has zero `0`-valued cells (confirmed by scanning `level1a.pap`),
  so there's no tile-value-based passable/solid distinction to lean on without decoding the real
  mechanism -- a per-tile collision-flag table at `[0xef23]`, confirmed to exist (`Entity_
  ScanGroundRow` indexes it directly by the raw tile byte) but not yet dumped. See docs/engine.md's
  updated `[0xef23]` note. Rather than fake a wrong solidity rule against the real cave art, `web/
  engine/collision.js` (generic tile-grid AABB collider) is pointed at a small hand-authored test
  surface (`web/engine/placeholder-terrain.js`), rendered as a translucent pink overlay so it's
  visually obvious it's not the real level geometry. Swap the grid source once `[0xef23]` is
  decoded -- collision.js itself doesn't need to change.
- **Checkpoint (met, on the placeholder surface)**: the player entity walks, is blocked by/lands
  on collision geometry, and can break a block ahead of it; every other level-script entity is
  spawned into the 146-slot pool and rendered on the real level art, but doesn't act yet (idle
  sprites) -- verified in a real (headless Chromium) browser run.

### Phase 4 — The two bytecode VMs (DONE, with one scope change)
- **`Entity_RunMovementAiScript`** (`web/engine/movement-ai-vm.js` + `entity-ai.js`): the 6-opcode
  interpreter, using the three per-animation-set tables transcribed byte-exact from
  `docs/enemies.md`'s live-memory dump. Wired to REAL level-script entities via
  `docs/enemies.md`'s CONFIRMED EXACT world-1 `Entity_DispatchUpdateByKind` table (types
  `0x12`=gate, `0x13/0x14/0x20/0x23/0x2c`=patrol/charging-hazard/idle-fidget) — not a guess at
  which entities get AI, the literal documented table. Opcode *semantics* (turn-around,
  scan-then-react, chase/flee decision, approach-and-strike) are a faithful structural port, not a
  byte-exact one — that doc itself only characterizes them (~150 dense decompiled lines left
  undecoded by design). What's a labeled placeholder, not a port: the real per-type animation-set
  assignment (not dumped, so every AI entity uses animSet 0 — a real table row, not fabricated),
  the gate's exact target-X coordinate semantics, and ground-extent detection (the tile-lookahead
  needed a `nearPatrolEdge` fallback since the Phase-3 placeholder collision grid is too sparse to
  answer "is there floor ahead" for entities scattered across the real level — see
  `movement-ai-vm.js`'s `sampleLookahead` header for the full story, including a real bug this
  surfaced and fixed: animSet 0's table row is `'n'` for both Clear AND Blocked, which made
  entities flip direction almost every frame in open (uncollision-mapped) space before the
  patrol-window-edge fallback was added).
- **`Entity_RunScript`** (`web/engine/entity-script-vm.js`): the VM LOOP itself (opcode dispatch,
  CALL/RETURN via the repurposed `+0x2a` field, the precise yield-vs-wait semantics
  `docs/entity-script-vm.md`'s "VM loop internals" section nails down byte-exact) is a faithful
  structural port, with real handlers for ~11 of the 78 opcodes (anim frame, wait, jump, kill,
  call/return, goto, add-to-position, AI-freeze wait, reset) plus the 15 documented no-op slots.
  **NOT wired to real game content**: the default-script tables (`0xcd88`/`0xd996`) and the actual
  per-entity script bytecode they point at live in the data segment and haven't been dumped, so
  there's no real script to run yet — every other opcode is a documented, logged stub. Verified
  correct against a synthetic test script (Node sanity check, not committed) exercising
  yield-across-calls, multi-frame wait-then-resume, and a same-frame call/return/jump/stop chain.
  Revisit once `0xcd88`/`0xd996` are dumped.
- **Checkpoint (met)**: gate/patrol/charging-hazard entities from the real `new1.pin` level script
  tile-scan, turn around at patrol-window edges, and chase the player when close — verified in a
  real (headless Chromium) browser run (entities visibly relocated across screenshots taken
  seconds apart; walking the player toward a cluster raised the "currently chasing" count from 0
  to several, with a chasing entity's dot visibly overlapping the player's box). Only the world-1
  subset of `Entity_DispatchUpdateByKind` is wired (this port's test level is world 1 only) --
  sleepers, the vertical pathfinder, and the other worlds' gate/patrol types (`docs/enemies.md`
  documents all of them) aren't attached to an `.ai` record yet, though `movement-ai-vm.js`'s
  interpreter itself doesn't care which world a type came from and would run their scripts the
  same way once entity-ai.js's dispatch table is extended.

### Phase 5 — Player-specific systems, HUD, bonus economy (DONE, with scope changes)
- **NOT ported**: `Entity_ApplyComplexGroundResponse` (docs/enemies.md decoded it, but it's a
  state machine keyed on scratch globals -- `[0x8b98]`, boss/checkpoint states -- produced by
  subsystems this port hasn't built) and the interaction-phase table
  (`Entity_HandleSpecialInteraction`/`Entity_InteractionPhaseJumpTable`, similarly dependent on
  unported machinery). Player physics stay Phase 3's generic tile-AABB collider; damage/pickup/
  exit detection are plain AABB overlap checks (`web/main.js`), not ports of the real collision-
  flag-driven dispatch.
- **`web/engine/bonus-economy.js`**: `Entity_ChooseAndSpawnBonusItem`'s REAL world-1 decision tree
  (docs/engine.md, branch order preserved), fed approximated inputs -- this port tracks
  `blocksBroken`/`pickupsCollected`/`score` only, standing in for the six real difficulty-input
  globals (which are each produced by subsystems -- the four-part breakable-block split, the AI
  despawn/capture counter -- not ported). Spawned bonus items use REAL resolved sprites (bank 3
  `specialN.pak`/bank 6 `extras` via the existing shape-descriptor pipeline), triggered every time
  the player breaks a block.
- **NOT ported**: `Hud_UpdateScoreDisplay`'s custom glyph-tile rendering -- the glyph→tile mapping
  within `extras.pak` still isn't resolved (open item, unchanged from before this phase). The HUD
  (score, hearts, "LEVEL COMPLETE") is real tracked game state, drawn with plain canvas text
  instead of the real glyph sprites -- a labeled placeholder, not a claim of decoding the font.
- **New, not in the original plan**: health/damage/invulnerability/respawn
  (`web/engine/player.js`) and pickups/exit-zone (`web/engine/placeholder-terrain.js`, extended
  with the same "synthetic, hand-authored, not derived from real data" caveat as its collision
  geometry) -- needed to give the checkpoint's "take damage, collect, reach an exit" goals
  something concrete to act on, since the real pickup-identification field
  (`Entity_InteractionPhaseType1bHandler`'s runtime `+0x10` pairing) isn't available from
  static level-script data.
- **Checkpoint (met)**: verified in a real (headless Chromium) browser run — breaking a block
  raised score and spawned a real-sprited bonus item; touching a chasing enemy cost a heart and
  (at 0 health) respawned the player at the start with a death counter incrementing; walking onto
  the placeholder pickups collected them and raised score; the wall/exit-zone geometry rendered
  and was reachable. Not exercised end-to-end in one run (pickup collection and reaching the exit
  were verified in separate passes, not the same playthrough) but every mechanic independently
  confirmed working.

### Phase 6 — World/level flow (DONE, with scope changes)
- **`web/engine/level-registry.js`**: all 8 real levels (2 sub-levels x 4 worlds, straight from
  the shipped filenames -- `docs/formats/pin-level-script.md`'s world-1-script-is-named-`new1.pin`
  oddity and world 3's `a`/`b`-suffixed script-variant pairing, matching `level.html`'s
  existing heuristic). `World1-4_LoadBanks` itself isn't ported as a distinct function -- this
  port's `AssetCache` already lazily loads+depacks whatever a level needs on demand, a strict
  superset of that function's job, so there's nothing left for a dedicated port to do.
- **`web/engine/transition.js`**: a fade-out/fade-in level transition, NOT a port of
  `Fx_UpdateTransition`'s real 24-bank VGA palette walk (this port's tiles are already decoded
  RGBA, there's no palette hardware to animate) -- a plain canvas black-alpha overlay instead,
  same narrative effect via a completely different mechanism. `Level_RunScriptedEventStream`'s
  static event stream (the `0xAAAA/BBBB/CCCC/DDDD` markers) is NOT ported -- this port's fixed
  level sequence (`nextLevel()` in level-registry.js) does the same practical job (get from one
  level to the next) without needing the original's scripted-event-stream indirection.
- **Level-select** (`web/main.js`'s `#level-select` button row): the dev/debug replacement for the
  hidden F2 cheat-code console, exactly as planned -- jumps directly to any of the 8 levels.
- **Extended, not in the original phase description**: `web/engine/entity-ai.js`'s AI wiring now
  covers all 4 worlds' CONFIRMED EXACT `Entity_DispatchUpdateByKind` entries (docs/enemies.md),
  not just world 1's -- natural given the data was already fully documented and other worlds are
  now actually reachable. Score/health persist across level loads within a session (the same
  `Player` instance is reused, only repositioned).
- **Found and fixed a real placeholder-terrain bug while testing this phase**: the Phase 3/5 test
  wall was tall enough to seal off the Phase 5 exit zone entirely (needed 112px of jump clearance,
  the player's max jump height is ~56px) -- verified by an automated run that couldn't reach the
  exit no matter how long it tried. Fixed by shortening the wall to leave a floor-level gap; still
  ported, unmodified, to every level per this phase's scope (see below).
- **Still Phase 3/5 placeholders, unchanged**: every level plays on the SAME hand-authored
  collision/pickup/exit-zone geometry regardless of its real layout -- this phase is about level
  SEQUENCING working correctly, not deriving real per-level playable geometry (still blocked on
  the `[0xef23]` tile-solidity table, per Phase 3's note).
- **Checkpoint (met)**: verified in a real (headless Chromium) browser run — all 8 level-select
  buttons load their real level correctly (background art, AI entity counts differing sensibly per
  world, e.g. world 3a's 10 gates vs. world 1a's 1); reaching the exit zone triggered the fade
  transition and advanced to the next level in sequence with score/health carried over (confirmed
  by an automated playthrough that had to survive several enemy-caused deaths/respawns along the
  way before finally reaching the exit — the chase mechanic from Phase 4 makes this a genuine,
  non-trivial gameplay loop, not just a scripted camera pan).

### Phase 7 — Audio (DONE, with scope changes)
- **`web/core/pin-sound.js`**: isomorphic port of `tools/extract-pin.js`'s resource-offset-table
  decoder (`adlib.pin`/`roland.pin`'s 2-byte-count + 4-byte-offset-per-entry sound-effect-bank
  shape, and `roland2.pin`/`soundbnk.pin`'s degenerate 1-entry song shape), verified byte-for-byte
  against the Node tool on the real files (counts match exactly: 82/78 MIDI for `adlib.pin`,
  82/81 for `roland.pin`, 1/1 for both song files; every extracted cue parses cleanly).
- **`web/core/midi.js`** / **`web/audio/synth.js`**: the Standard MIDI File parser and Web Audio
  oscillator-per-note synth, relocated/adapted from `tools/midi-player.html` (already isomorphic
  code, just given real integration into the engine instead of a standalone demo page) — NOT a
  real OPL2/MT-32 emulation, so playback timbre won't match the original AdLib/Roland sound
  (`docs/formats/pin.md` already flagged this: the cues embed OPL2 SysEx timbre data a standard
  MIDI player ignores).
- **`web/audio/sound-manager.js`**: loads `adlib.pin`'s 78-cue bank for sound effects and loops
  `roland2.pin`'s embedded song as level music, wired to real gameplay events in `web/main.js`
  (block break, pickup, damage, death, bonus spawn, reaching the exit). **The event→sound-ID
  mapping is NOT decoded** — docs/formats/pin.md confirms table entry N *is* sound_id N, but never
  resolved which IDs correspond to which real gameplay event (the one ID whose meaning *is*
  confirmed, `adlib.pin`'s 11, is the rare World-4 ending fanfare and isn't used here). The IDs
  this port uses are arbitrary picks from the 78 real cues, labeled as such in code — each event
  gets its own distinct real sound, not a verified one. `roland.pin` (the Roland-driver
  equivalent bank) isn't wired up — this port always uses the AdLib bank regardless of any driver
  concept, since there's no `pockets.ini`-equivalent driver selection in this port.
- **Not ported**: the real `Snd_TriggerEffect` driver dispatch (far-calls into whichever hardware
  driver was configured) — this port's `SoundManager.trigger()` is a simplified direct stand-in.
  Browsers also block audio until a user gesture, so an "enable audio" button was added (not in
  the original plan, but required for any of this to actually play).
- **Stretch goal, not attempted**: real OPL2 register-stream synthesis for
  `adlib2/adlib3/sblaster.pin` and the non-MIDI `adlib.pin`/`roland.pin` table entries — still
  blocked on decoding the driver interpretation loop (open item, unchanged).
- **Checkpoint (met)**: verified in a real (headless Chromium) browser run — enabling audio
  successfully resumed a real `AudioContext` ("audio on"), loading a level started
  `roland2.pin`'s music (2325 oscillators scheduled, confirming substantial real note playback,
  not a silent no-op), and breaking a block triggered both its break-sound and bonus-spawn cues
  (23 more oscillators scheduled) with zero JS errors throughout.

### Post-Phase-7 fix — real ground collision, real player sprite

Prompted directly by user feedback after Phase 7 ("doesn't really look like the original game...
pink placeholder collision overlay doesn't align with the world... starting position isn't level
1's"). All three complaints traced to the same root cause: Phase 3's placeholder collision was
never swapped out for real data, exactly as its own comments flagged it would need to be.

- **The `[0xef23]` ground-collision table is dumped.** `read_memory` at `6de3:f189` (256 bytes)
  returns a clean, real per-tile solid/passable classification, confirmed indexed directly by the
  `.pap` tile byte value (entries 1-120 line up exactly with the valid on-disk range) — see the
  updated `docs/engine.md` note. This was a genuinely available fact the whole time (the address
  was known since Phase 3), just never fetched.
- **`web/core/tile-collision.js`** (the transcribed table) and **`web/engine/real-terrain.js`**
  (builds real per-level collision from real `.pap` data + this table, plus a generic standable-
  spot scanner for spawn/pickups/exit — still placeholder positions, but now always inside real,
  walkable geometry) replace `web/engine/placeholder-terrain.js` (deleted) and
  `render/canvas.js`'s pink collision-overlay draw (removed — no longer needed once collision
  actually matches the art).
- **The player now renders as a real sprite** from its confirmed character bank instead of an
  orange box. First attempt used `resolveShapeTileForcedDirect` (treat `animStart` as a direct
  tile index despite the real descriptor being frameSourceMode 0 — indirect, undecoded
  addressing). **This shipped broken and was caught by the user, not by this session's own
  testing** — see the follow-up entry below for the real bug and fix
  (`resolveShapeTileByBank`, a verified-by-eye hardcoded frame).
- **Two real bugs found and fixed while wiring this up**, both caught by systematic testing rather
  than eyeballing: (1) the spawn-finder's standable-spot check only verified 1 row of headroom
  above the floor cell, letting the player spawn with its ~30px-tall (~2-tile) box embedded in
  solid rock — an automated browser test that held a direction key for 2+ seconds and saw zero
  net movement caught this; fixed by requiring 2 rows of headroom. (2) `buildLevelPlayfield`
  returned its collision grid nested under a `grid` key that itself held `{size, grid}`, so
  `collisionGrid.grid[idx]` in collision.js/movement-ai-vm.js indexed into an object instead of
  the Uint8Array (`undefined !== 0` reads as "always solid") — reproduced deterministically with a
  Node simulation of `moveAndCollide` against the real grid before finding the root cause, fixed
  by flattening the returned shape.
- **Not fixed / still open**: the exact `1` vs `16` distinction in the table isn't confirmed
  (treated as equally solid); breaking a block clears real collision at that cell but doesn't yet
  update the visible background tile art (a visual/collision desync after digging, not present
  before since the old placeholder terrain had its own separate overlay); enemy sprites whose
  descriptors are frameSourceMode 0 still fall back to a dot (unchanged since Phase 1 — a separate,
  harder RE problem, the indirect near-pointer tile-stream tables, not attempted here).
- **Verified**: a Node-level deterministic simulation of `moveAndCollide` against real
  `level1a.pap` data (confirming the exact bug reproductions above), and a real (headless
  Chromium) browser run across multiple worlds — the player visibly moves, falls to real footing,
  stops against real walls, breaks blocks; zero JS errors. **This verification pass missed that
  the player sprite itself was still invisible** — every automated check looked at *state*
  (position, collision flags, entity counts) and none of them looked at *what the canvas actually
  drew*, so a real rendering bug shipped in the same commit as the fix above. Caught by the user
  re-testing against a live DOSBox reference, not by this project's own process.

### Follow-up fix — the player sprite was actually still invisible

The user reported the port still didn't look like DOSBox and the player still wasn't a sprite,
after the previous entry claimed both were fixed. Investigated by connecting live to the user's
running DOSBox instance (`dosbox-mcp`, `docs/dosbox-debugging.md`'s workflow) for a ground-truth
screenshot and world/sublevel read (confirmed world 1 sublevel 1, matching this port's default
level — the state comparison was valid), then working the actual bug on the JS side.

- **Root cause**: `resolveShapeTileForcedDirect`'s "treat `animStart` as a direct index anyway"
  approach didn't just risk being frame-inaccurate — for the player specifically it landed on
  `kidx1.pak` local tile index 5, a genuinely **empty/unused placeholder slot** (verified by
  rendering all 20 of `kidx1.pak`'s tiles side by side: indices 0-4/6/10-17 are the real character
  —cap, sunglasses, walk/punch poses — 5/7/8/9/18/19 are blank). The sprite pipeline itself
  (decode, cache, `drawImage`) was working correctly end to end; it was just drawing a transparent
  tile every single frame, invisible by construction. No exception, no wrong-looking output to
  eyeball — a screenshot of "nothing extra drawn" looks identical to "background art with no
  sprite on top," which is exactly why this survived the previous entry's browser-run
  verification.
- **How it was found**: not memory archaeology (a live entity-table read was attempted via
  `dosbox-mcp`'s `mem_read`/`cpu_read_registers` to cross-check the real player's position/frame,
  but hand-parsing the raw entity array from live memory proved too fragile to trust — abandoned
  in favor of a much more direct approach). The actual method: render `kidx1.pak`'s full tile
  sheet to a PNG and visually inspect it, which immediately showed which indices are real frames
  vs. empty padding — then confirmed live-browser pixel sampling (`canvas.toDataURL()`, decoded
  and cropped in Python) showed the exact same mostly-transparent tile at the computed draw
  position, closing the loop.
- **Fix**: `web/core/shapes.js`'s `resolveShapeTileForcedDirect` replaced with
  `resolveShapeTileByBank(entityType, entityShapes, world, localTileIndex)`, which resolves a
  bank/world's file name the same way but takes an **explicit, verified** tile index instead of
  trusting `animStart`. `web/main.js` hardcodes `PLAYER_SPRITE_GLOBAL_INDEX = 60` (bitkid.pak's 60
  tiles + kidxN.pak local index 0 — a clean standing pose), with the reasoning documented inline
  since this is a hand-picked value, not derived data.
- **Still not fixed**: this is a representative pose, not frame-accurate animation — the real
  per-frame selection still needs the undecoded indirect near-pointer table
  (`docs/formats/pin-level-script.md`). Enemy sprites with the same frameSourceMode-0 addressing
  still fall back to a dot, unchanged.
- **Verified**: rendered `kidx1.pak`'s full tile sheet and cross-referenced by eye; live-browser
  canvas pixel sampling via `toDataURL()` (not screenshot-and-crop, which had already produced two
  rounds of wrong conclusions in this same investigation due to coordinate-math mistakes) confirmed
  the fix; full regression pass (movement, block-breaking, jumping, multi-world loads) re-run with
  zero JS errors.
- **Process note worth keeping**: two different screenshot-crop-and-eyeball attempts during this
  investigation reached wrong conclusions from coordinate arithmetic mistakes (camera clamping at
  the level edge means it doesn't always center on the player, which broke a naive "viewport
  center" assumption). Reading `canvas.toDataURL()` directly inside the same `page.evaluate()` call
  that captures the values used to compute a draw position — fully atomic, no cross-call drift, no
  external scaling math — is the reliable way to inspect canvas output; prefer it over
  screenshot-and-crop for this kind of pixel-level verification going forward.

### Follow-up — authored-accurate starting position (level 1a)

User asked directly for an authored-accurate starting position, having already flagged (in the
report that led to the previous two entries) that the spawn point looked wrong. Rather than guess
harder with the same standable-spot heuristic, this connected live to the user's running DOSBox
instance again and read the REAL spawn position out of guest memory.

- **Method**: paused (`dosbox-mcp`'s `debug_pause`), confirmed world 1/sublevel 1 (matching this
  port's default level) by reading `[0x8b89]`/`[0x8b8b]` directly, then located the entity pointer
  array (`6de3:9090`-ish, confirmed via a clean 66-byte stride between consecutive live pointer
  values) and read every entity it pointed to. Filtering for class 3 (the player, confirmed sprite
  cross-reference) found exactly one match: type 3, **X=144, Y=80**. Re-read the same memory a
  second time — byte-identical, confirming the game was genuinely paused (not a mid-fall snapshot
  that would read differently a moment later).
- **A real complication, not a bug this time**: this game's terrain is far denser than a typical
  platformer's — mostly solid rock with thin carved/dug passages, not open floors (confirmed by
  dumping an ASCII-art solid/passable map of the area around the authored spawn: almost entirely
  `#`). The exact authored pixel can sit inside what this port's simplified single-tile AABB
  collider calls "solid" purely because a full-tile model is too coarse for 1-cell-wide gaps —
  not because the real game was wrong. Confirmed by checking `isStandableSpot`'s stricter
  floor+headroom definition against the real position: no match within a 17x17-cell search
  radius, because there simply isn't a flat platform there, just a narrow dug gap.
- **Fix**: `web/engine/real-terrain.js` gets `AUTHORED_SPAWN_PX` (currently just `'1a': {x:144,
  y:80}`) and a plain BFS flood-fill (`nearestPassableCell`, no floor/headroom requirement) that
  snaps the authored point to the nearest non-solid cell, then lets gravity settle from there.
  Empirically this converges almost exactly onto the real value: the player's feet land at y=80 on
  the very next frame (matches the authored Y precisely, since the nearest gap's floor is the same
  floor the real entity was standing on) at x=160 (16px from the authored 144, well within one
  tile). The other 7 levels are unaffected — no live read was done for them, they still use the
  Phase-3/5-era generic standable-spot search.
- **Verified**: browser run confirmed the settled position (feet at y=80, matching the authored
  value) and a full regression pass (movement, block-breaking, jumping, multi-world loads, the
  earlier `[0xef23]`/sprite fixes) with zero JS errors. Visually, the player now starts in a real,
  tight carved gap near the top of the level with several real enemies nearby — a materially
  better match to what a level's actual opening should look like than the old arbitrary
  first-standable-spot pick.

### Follow-up — spawn positions turned out to be static level data after all

User asked the obvious next question the previous entry's "not done for the other 7 levels"
caveat invited: "Shouldn't the starting positions be part of the level data (files)?" — i.e., why
was a live DOSBox memory read needed at all, when this port already has a level-data pipeline.

- **First avenue (dead end)**: traced `Level_InitStateForSublevel`/`Level_InitStateForWorld1Sublevel1`
  (`1000:0d7b`/`1000:0cf6`) in Ghidra — both read a per-sublevel "camera position" record through a
  small offset table at the very start of the resident data segment (`6de3:0000`). That table reads
  as all-zero in the static EXE image and has **zero xrefs** to that fixed address — it's genuinely
  populated at runtime through a computed pointer, not literal file bytes at a fixed offset. A
  byte-pattern search for the expected value (144/80 as adjacent big-endian words) also found no
  match anywhere in the EXE. Dead end for this specific table.
- **Second avenue (the actual answer)**: `web/core/pin-level-script.js` already fully decodes each
  world's `.pin` level-script file (see `docs/formats/pin-level-script.md`) into per-sub-level
  entity-spawn records, each with its own `type`/`x`/`y` — and `main.js` was **already loading and
  decoding this file** for every level (`scene.levelScript`), just not using its player-position
  record for anything; the player's own spawn was still coming from the Phase-3-era standable-spot
  search (or the level-1a-only `AUTHORED_SPAWN_PX` hardcode from the previous entry).
- **Verification**: unpacked `data/new1.pin` (world 1) and decoded it standalone. Sublevel 0's
  type-3 (player) entity record sits at file offset 74 with payload `[144, 80, 8]` — **X=144, Y=80,
  byte-identical to the live DOSBox read**. This is conclusive: the authored spawn position is
  genuine static level data, sitting in a file this port was already parsing, no emulator required
  for any of the 8 levels.
- **Fix**: removed the single-level `AUTHORED_SPAWN_PX` hardcode from `web/engine/real-terrain.js`.
  `main.js`'s entity-spawn loop (which walks `scene.levelScript.entities`, already filtered to this
  level's own pixel bounds) now picks out the first type-3 record as `authoredSpawnPx` and passes it
  to `buildLevelPlayfield` for every level, generically — and, since that same type-3 record was
  previously *also* being spawned into the live entity pool unfiltered, skips it there instead, which
  fixes a latent duplicate-player bug (an inert, uncontrolled "ghost" player-shaped pool entity
  sitting on top of the real one at the same spawn point).
- **Verified**: headless-browser run across levels 1a, 1b, 2a, and 4a — all load with zero JS
  errors, each settling at a distinct, world-appropriate spawn position (no more silent fallback to
  level 1a's hardcoded value or the generic standable-spot search for the other 7 levels).

### Follow-up — fully reverse-engineering the .pin level-script format

User asked to fully reverse-engineer the `.pin` level-data files (`docs/formats/pin-level-script.md`
had three explicit open questions left over from the format's initial discovery). Pure
Ghidra/analysis pass, no port code changes. Full writeup lives in
`docs/formats/pin-level-script.md` — summary:

- **The nine special-opcode entity types are now fully decoded field-by-field** from
  `Entity_SpawnFromQueuedEvent`'s raw disassembly (not the decompiled pseudo-C, which hid the exact
  `BX` pointer arithmetic). Bonus finding: **seven of the nine never appear in real level data at
  all** — confirmed empirically across all 3811 entity records in the six shipped `.pin` files.
  Four of those seven (`0x11/0x1d/0x25/0x2f`) are provably runtime-only: their payload word is read
  directly as a live entity pointer, which a static file can't encode. This also proves the
  existing decoder (which infers record length purely from the file's own `BX` layout-selector
  word, ignoring `type`) was already byte-exact for every type that can legally appear in a file —
  closes that open question with proof instead of "it hasn't broken yet."
- **The "negative/out-of-frame X/Y noise band" turned out not to be noise.** It's tile-row-aligned,
  plausible-X content for *other rooms* sharing the same per-world byte stream — found a
  room/checkpoint-warp dispatcher (`FUN_1000_59a9`) that matches the "camera position" globals
  against a small table of trigger anchors in the same coordinate range and re-enters the level
  script from a different pointer per match. Validates that `main.js`'s existing pixel-bounds
  filter on spawned entities (added pragmatically, not as a proven-correct model) is structurally
  the right approach, not a workaround. Full per-room coordinate mapping remains open — would need
  either a live DOSBox read per room or locating the runtime source of `[0x8bbb]`/`[0x8bbd]`'s
  backing table (already known to be populated at runtime, not static file bytes, from the previous
  entry).
- **Attempted, inconclusive**: mapping non-AI entity types (items/pickups/decoration) to their
  gameplay role by cross-referencing a full 52-type census against known pickup-collection tags.
  No direct match found in the static payload; most likely the "is this a pickup" tag is set at
  runtime by the entity's own AI script, not authored in the file. Left as an open item for
  `docs/enemies.md`, not this format doc.
- No `web/` code changes this pass — this was purely closing out the format's own documentation.

### Follow-up — closing out the remaining .pin open questions

Continued the previous entry's work per a direct request to keep going until the format is fully
understood. Two more of the three remaining soft/open items got real progress; again, pure
Ghidra/data analysis, no `web/` code changes.

- **RESOLVED (in the negative), definitively — pickups/bonus items are never level-authored.**
  `docs/engine.md` already had the real answer sitting in it: `Entity_ChooseAndSpawnBonusItem`'s
  decompile names the exact ten collectible/reward-item type values (`0x35–0x3d, 0x3f`), all
  spawned via the *runtime* dynamic queue (`Entity_PushSpawnEvent`, fired from a periodic timer +
  difficulty counters) — never from the level-script interpreter. Checked all six `.pin` files'
  full entity census against that exact set: **zero matches, anywhere.** This closes the previous
  entry's "inconclusive" pickup-mapping attempt outright — it wasn't inconclusive because the data
  was ambiguous, it was inconclusive because it was looking in the wrong layer (a spawned entity's
  `+10` field, which turns out to be initialized from the shape-descriptor table and mutate further
  at runtime, not an authored static tag). Real items simply don't exist as level-script records —
  confirms `web/engine/bonus-economy.js`'s existing runtime-driven approach to bonus spawns is the
  structurally correct model, not a placeholder standing in for undecoded level data.
- **Follow-up on the 13-sub-level-entry question**: built a live-DOSBox-free geometry fit test — for
  each sub-level's entity list, what fraction land on a non-solid real-collision cell in each
  candidate `.pap` map (reusing `real-terrain.js`'s own collision grid). World 1 gives a weak but
  directionally correct signal that independently supports the ordinal `1a→sub-level 0, 1b→
  sub-level 1` mapping `level-registry.js` already assumes (sub-level 0 best-fits `level1a.pap`,
  matching the earlier live-read-confirmed spawn; sub-level 1 best-fits `level1b.pap`). Sub-levels
  2–12 don't cleanly resolve to either map — read as further support for the checkpoint-reuse
  hypothesis (same one or two rooms, revisited via scripted re-entry points) rather than 11 more
  distinct undiscovered rooms. World 2 shows a cleaner alternating split between its two maps.
  Not strong enough to assert a definitive per-entry mapping; documented as a soft lead, not a
  closed answer.
- Everything else from the previous entry's "PARTIALLY RESOLVED"/open items (the exact per-room
  coordinate origins behind the negative-XY room-warp mechanism, and full semantic labeling of the
  ~40 remaining non-AI, non-bonus entity types as decoration vs. hazard vs. set-dressing) would need
  either further live-DOSBox ground-truth per room or substantially more per-function Ghidra tracing
  than is warranted by this port's actual needs — the format's *structure* (every byte's meaning,
  every record's exact length for every type that can appear) is now fully closed; what's left is
  gameplay-semantic labeling, which is `docs/enemies.md`'s territory, not this format's.

### Follow-up fix — walking back "every level's spawn is real authored data"

User reported the player still spawns "in the wall" for world 1a, and that every other world looked
wrong too, with a sharp hypothesis: "if the player position within the level is correct, the
level's position within the world isn't." That hypothesis pointed straight at the bug.

- **Root cause, found by testing the hypothesis directly**: re-ran the `.pin` type-3 (player)
  record extraction across *every* sub-level of all six shipped `.pin` files (not just level 1a's,
  which is all the previous pass checked). Every single one reads the exact same payload: **X=144,
  Y=80, with zero exceptions, in every level of every world.** A real per-level spawn position
  cannot be a hardcoded constant — this is level-authoring-tool boilerplate (almost certainly a
  template/placeholder value the tool always emits for the player marker), not real per-room data.
  The earlier pass's "proof" — that level 1a's `.pin` value byte-matched a live DOSBox read — was
  real and correct, but the generalization to "so the `.pin` file is the real source for every
  level" was wrong: it was independently confirmed for 1a specifically (world 1's zero-offset home
  screen), and that coincided with the boilerplate constant by chance, not because the constant is
  meaningful anywhere else.
- **Traced the real mechanism, but couldn't fully close it**: the actual per-room position comes
  from `Level_InitStateForSublevel`'s "camera position" globals (`[0x8bbb]`/`[0x8bbd]`), populated
  at runtime from a two-level indirection through a table at the very start of the resident data
  segment (`6de3:0000`) that reads as all-zero in the static EXE image. Traced its consumer
  (disassembled `Level_InitStateForSublevel` in full) and confirmed there's no addition/offset
  logic anywhere in the entity-spawn path itself (`Entity_SpawnFromQueuedEvent` writes the raw
  payload X/Y directly, no combination with the camera-position globals) — so the real fix would
  need either a live DOSBox read per level, or locating whatever copies data into that zero-image
  table at boot (searched for a direct write/xref to it; none found — it's written through a
  computed pointer, not a fixed address Ghidra's static xref index can see). Neither done this
  pass; a real DOSBox bridge wasn't connected to test further.
- **Fix applied given that**: `web/main.js` now only trusts the `.pin` type-3 record's position for
  level `'1a'` specifically (the one level with independent live-read confirmation); every other
  level passes `null` and falls back to `web/engine/real-terrain.js`'s generic real-collision
  standable-spot search, same as before the `.pin`-spawn feature existed. This removes the false
  confidence, not just the visual symptom.
- **Bonus fix, independent of the above**: `real-terrain.js`'s authored-spawn snapping used a plain
  "nearest non-solid cell, no floor or headroom required" BFS, which can land in a floor-less or
  three-walls-tight pocket and visibly look wedged into rock even when technically not stuck. It
  now prefers a genuinely standable spot (solid floor + headroom), relaxing headroom from 2 → 1 → 0
  before finally falling back to "any non-solid cell." Each headroom tier gets a **tight** search
  radius (not unbounded) — an early attempt at just relaxing headroom over an unbounded search
  found level 1a's nearest *full*-headroom standable spot 33 tiles away, which would have thrown
  away the real authored position's whole point. Radius-capped-per-tier keeps 1a's result at its
  previous, already-verified (160, 80)-settling snap while still preferring more headroom when it's
  genuinely nearby.
- **Verified**: headless-browser run across all 8 levels — all load with zero JS errors, all show
  real per-level-appropriate spawn positions (no more identical/near-identical values across
  worlds), and a hold-right-for-2-seconds movement test on five levels (1a, 1b, 2b, 3b, 4b) shows
  real net displacement on every one (nobody frozen in place). Screenshots of 1a and 2b confirm the
  player visibly stands in open space, not embedded in wall art.
- **Still open**: levels other than 1a use a generic (not real) spawn point — getting their real
  authored positions needs the camera-position table's runtime source, which remains unresolved.

### Follow-up deep-dive — walking back level 1a's spawn too, and why

User reported the fix above still wasn't right, with the same "level position within the world"
framing, and asked for a real deep dive using DOSBox to double-check. Connected live
(`dosbox-mcp`) to the user's already-running instance to re-verify from scratch, more carefully
this time.

- **First live read, reproduced**: paused mid-play at world 1/sublevel 1 (confirmed via
  `[0x8b89]`/`[0x8b8b]`), found the entity-pointer-array slot at index 1 (`0x93da`) with class 3,
  type 3, X=144, Y=80 — exactly reproducing the previous session's reading. Re-read the surrounding
  "camera position" globals `[0x8bbb]`/`[0x8bbd]` at the same moment: **(-80, -832)**, not (0, 0) —
  already a red flag, since the previous session's reasoning assumed level 1a's offset was zero.
- **The reproduction was the wrong entity, caught by testing persistence over time**: resumed
  emulation for real (not just single-stepping) and re-read the same "player" entity (slot 1,
  `0x93da`) after visible, active gameplay — a moving enemy on screen, then later a scene change and
  the score climbing from empty to 500 to 9200. Its X/Y **never changed**, not once, across all of
  that. A real player-controlled or even demo-driven avatar cannot stay frozen through minutes of
  active play. This entity is a static template/reference marker, not the live position.
- **Found the actual live-tracked entity**: entity slot 0 (`0x9398`, type 1, class 1) DOES move —
  its X/Y exactly mirrors `[0x8bbb]`/`[0x8bbd]` at every read, both before and after movement (X
  went -80 → -160 → -596 across the session while Y tracked separately). This is almost certainly
  the real camera/position tracker; slot 1 (the one every previous session, including this port's
  own docs, assumed was "the player") is not it.
- **Why this session's readings can't be trusted as ground truth for real gameplay**: score jumped
  from 500 to 9200 with no meaningful correlation to the deliberate key presses sent (`KBD_right`
  held, `KBD_esc`), and the visible scene changed completely between two ~1.5s-apart pauses. This
  is almost certainly `Game_StartAttractDemoAndRunLoop`'s attract-mode demo replay, not a real
  controlled session — DOSBox was left idle before this investigation started. A scripted demo's
  own "camera position" trace doesn't tell us anything about a real game's initial spawn state.
- **Tried to cross-reference the moving entity's coordinate space against real `.pap` tile data**:
  rendered level 1a's full 4096×2048 tile map via the port's own pipeline (`buildLevelScene`,
  screenshotted through Playwright) to visually locate where in the tile grid the live DOSBox
  screenshot's terrain pattern actually sits, as an alternative to trusting the raw camera-position
  numbers. Inconclusive within this pass's time budget — the visible terrain is repetitive enough
  that a confident visual match wasn't reached, and the moving entity's values (consistently
  negative, -80 to -596) don't fall inside the `.pap` grid's own natural 0–4096×0–2048 pixel range
  at all, meaning either its coordinate origin doesn't align with the `.pap`'s top-left the way this
  port assumes, or it's a pure scroll-delta rather than an absolute position. Not resolved this
  pass.
- **Fix applied given all of this**: removed 1a's special-casing entirely. `web/main.js` no longer
  extracts an "authored" spawn from the level-script for any level; `web/engine/real-terrain.js`'s
  `buildLevelPlayfield` dropped the `authoredSpawnPx` parameter and the now-dead
  `snapToStandableNear`/`nearestMatchingCell` BFS-with-relaxed-headroom machinery entirely — every
  level, 1a included, uses the same generic standable-spot search uniformly. This is a deliberate
  step back from "level 1a has real data" to "no level has real data (yet)", which is the honest
  state given the above.
- **Verified**: headless-browser run across all 8 levels, zero JS errors; a hold-right-for-2-seconds
  movement test on five levels shows real net displacement everywhere (nobody frozen).
- **What a real fix needs**: a **definitely-not-attract-mode** live session — the user deliberately
  starting a new game from the title screen (not resuming/finding an already-idle instance) and
  pausing at a clearly-defined moment (e.g. immediately after the level-start transition, before any
  input) — reading entity slot 0 (not slot 1) at that exact moment, for each of the 8 levels. Even
  then, the coordinate-space mismatch against `.pap` tile pixels would need solving before the
  number is directly usable.

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
- **Regression baseline**: `level.html` + `build/` stay as a cheap, fast, no-simulation
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
