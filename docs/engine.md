# GAMEU.EXE engine architecture

The main loop, entity model, and per-frame update order — reverse-engineered from `entry`'s
14-call main loop (`1000:0010`, the `do { ... } while(true)` at its tail). Every function below
is named and commented in Ghidra; this document is the narrative walkthrough. Confidence is
marked per function: **confirmed** (structure and role both solid) vs **guess** (structure
confirmed, semantic role inferred — tagged `guess` in Ghidra, not `verified`).

## Startup sequence (before the main loop)

1. `entry` sets up its own stack (`SS:SP = 6d83:05fe`) and resident data segment (`DS=ES=6de3`).
2. `Sys_DetectCpuSpeed` — vsync-poll-count fast/slow machine classification.
3. `FUN_1000_b3a3`, `FUN_1000_b3c2` — unexamined, likely further hardware setup.
4. `Config_ParseIniAndLoadSoundDriver` — parses `pockets.ini` (video driver, sound driver,
   joystick/keyboard mode, 5 key bindings), loads and invokes the sound driver `.pin` module.
5. `FUN_1000_1cce` — a further init step; return value gates fatal-exit vs. normal continue vs.
   a `World_Dispatch` fast-path (`iVar1==0` branch, not yet named in detail).
6. `Video_SetMode`, then bank loading via `World_Dispatch` (world 1 fast-path if the PSP command
   tail's first char was `'1'`, matching the debug/cheat init flag noted on `entry`).
7. Falls into the main loop.

**CORRECTION**: the 14-call loop is not unique to `entry` — `Game_WarpToLevelStageAndRunLoop`
(`1000:03ff`, called from `Debug_HandleCheatInput`'s level-select warp and `Demo_PlaybackInput`)
and `Game_StartAttractDemoAndRunLoop` (`1000:0089`, called from the former and from
`Level_RunScriptedEventStream`) each contain their own **physical copy of the identical 14-call
sequence** after their own world/level bootstrap code, and neither ever returns to its caller.
Functionally there is one loop; structurally there are (at least) three copies of it compiled
into the binary, reached via different bootstrap paths (normal boot, cheat/demo warp, attract
mode). See `docs/engine.md`'s entity-system section and `symbols/gameu.json` for the full
bootstrap-path writeup.

## The main loop — 14 calls per frame, in order

| # | Function | Confidence | Role |
|---|---|---|---|
| 1 | `Camera_UpdateScroll` | **confirmed** | Reads a scroll-target struct, negates X/Y, splits into whole-tile (÷32/÷16) + sub-tile pixel remainder. Sub-tile X remainder → `[8b69]`, later fed to the EGA pixel-panning register by `Video_FlipAndScroll`. Computes the read pointer into the column-major level-map buffer at `6de3:4200` — see `docs/formats/pap.md`. |
| 2 | `Level_UpdateAnimatedTiles` | **confirmed** | Skipped for world 4. Walks an 11×14 visible-tile grid (0x80-byte row stride) from the scroll-computed screen offset, calling `FUN_1000_02e2` for tiles with a flag bit set. |
| 3 | `FUN_1000_73a5` → `Gfx_DrawObject` | confirmed | The render pass — see `docs/memory-map.md` "Sprite rendering". |
| 4 | `Video_FlipAndScroll` | **confirmed** | Page-flip (A000/A300 alternation) + **EGA pixel-panning register write (Attribute Controller index `0x13`)** for hardware fine-scroll. Also services the loaded sound driver via a computed far call. This is the *other* AC-index write in the whole binary besides the CGA palette-select — not a palette write, refining the "no palette setter" finding. |
| 5 | `Fx_UpdateTransition` | **confirmed** | Dispatches on `[8ba2]`; the default case (`Fx_TransitionStep`) increments it once per frame and feeds it straight into `Video_SelectAndLoadPalette`'s 24-bank fade table — this is a **palette-fade transition** system between levels/screens, not a screen wipe. See `docs/memory-map.md`. |
| 6 | `Level_UpdateEventQueue` | guess | Walks an opcode/length-tagged script structure at `[8bb5]`; plausible scripted-event or timed-trigger queue. |
| 7 | `Demo_PlaybackInput` | **confirmed** | If a demo recording is active, overrides this frame's input with replayed input from an RLE `(repeatCount, state)` buffer at `[8ba6]`. |
| 8 | `Entity_UpdateAll` | **confirmed** | Walks a linked list of entity records from `0x91be`, skipping any with the `+0x40 == 0x19` "dead" marker. **CORRECTION**: not a heavy/light split as previously described here — every live entity unconditionally gets `Entity_UpdateBehavior` (`1000:ca6d`) every frame; entities that also have an active script flag (`+1 != 0`) additionally get `Entity_RunScript` (`1000:22da`, the opcode-256-jump-table bytecode VM) *first*, as an extra step, not an alternative. See `docs/enemies.md` for the full entity-behavior writeup this correction comes from. |
| 9 | `Demo_RecordInput` | **confirmed** | Write-side counterpart to #7 — RLE-encodes the current input state into the same `[8ba6]` buffer when not in playback mode. |
| 10 | `Debug_HandleCheatInput` | **confirmed** | The debug console: single-step (`p`), vsync-skip (`q`), a hardcoded debug bonus setup (`b`), and — the big one — **a 4-digit level-select cheat code system** (digits `0`–`9` build a code, matched against a table, warping directly into any `World1..4_LoadBanks` with a given sub-level). |
| 11 | `Input_ReadState` | confirmed | Unified joystick-or-keyboard per-frame input read (see `docs/memory-map.md`). |
| 12 | `Hud_UpdateScoreDisplay` | **confirmed** | Converts the running distance/score (`[8b75]`) into HUD digits, written as **custom glyph codes** (not ASCII) into a buffer at `0xe70e` — this is the confirmation for the "HUD/text renderer" hypothesis on `Gfx_DrawObject`'s numeric-default case. Also triggers periodic level-progress callbacks (every 50 / 1000 / 10000 units) and, for world 3 past sub-level 7, a second BCD-style counter display. |
| 13 | `Rng_NextValue` | **confirmed** | A 16-bit LFSR pseudo-random generator, advanced exactly once per frame. |
| 14 | `Video_WaitVsyncAndCountFrame` | confirmed | Frame-pacing: busy-wait for vsync, increment the frame counter. |

## Cross-cutting findings from this pass

- **CORRECTION: a real palette setter does exist** — on the `'C'` ("Colour VGA") driver path,
  which is what this project's own shipped `pockets.ini` actually selects. See
  `docs/memory-map.md`'s "Palette setting" section for the full trace
  (`Video_SelectAndLoadPalette`, `Video_ApplyVgaPalette`, `Video_ScaleColorComponent`) and the
  real, code-derived per-world 16-colour palettes. This means `tools/ega.js`'s hardcoded default
  EGA palette and the empirically-guessed `PLANE_TO_INDEX_BIT` mapping in `docs/formats/pak.md`/
  `pip.md` were tuned against the *wrong* reference colours and need re-validation.
- **`.pap` level maps and `.pip` full-screen pictures are both fully decoded and extractable**
  (`tools/extract-pap.js`, `tools/extract-pip.js`) — see `docs/formats/pap.md`/`pip.md`.
  `Level_LoadMapIntoScrollBuffer`/`Level_TransposeMapToColumnMajor` transpose the row-major
  on-disk `.pap` file into the column-major buffer `Camera_UpdateScroll` reads from.
  `Gfx_DrawFullScreenPicture` is the `.pip` renderer — found by tracing `new.pip`'s load site.
- **The demo/attract-mode system is real and fully located** (`Demo_PlaybackInput` +
  `Demo_RecordInput`), sharing one RLE-encoded input buffer at `[8ba6]`.
- **The level-select cheat code system is fully located** (`Debug_HandleCheatInput`), reusing
  the same scancode table (`6de3:edb4`) noted at the very start of this project and a lookup
  table at `0xfc2a` mapping 4-digit codes to `(world, sub-level)` pairs.
- **The HUD renders through the "mystery" glyph-copy family** identified while naming
  `Gfx_DrawObject` — `Hud_UpdateScoreDisplay` is confirmed to be one of its producers. The glyph
  encoding is custom (offset from ASCII by fixed constants like `-0x44`/`+0xBC`), meaning the
  eventual JS port needs the actual font/glyph bitmap data, not a system font.
- Entity records have a confirmed field layout fragment: `+0x40` = state byte, `0x19` = "dead,
  pending removal" (consistent across `Entity_UpdateAll`, `Gfx_DrawObject`, and other object-init
  sites seen earlier in the session).

## The entity system

`Entity_UpdateAll` dispatches each live entity to one of three functions, now all named:

- **`Entity_RunScript`** (confirmed) — a genuine **bytecode VM**. Entities can carry a script
  pointer (`+0xc`); if unset, it's initialized from a default-script table at `0xcd88`. Each
  iteration reads one opcode byte and, unless it's a terminator (`-1`/`-0x52`) or the special op
  `-4` (→ `FUN_1000_2659`), calls through a **256-entry function-pointer jump table at
  `1000:2383`** — i.e. entity behaviors are authored as opcode sequences, not hardcoded
  per-type branches. Decoding that jump table is a rich, self-contained target for a future
  session — it would reveal the actual scripting language driving enemy/object behavior.
- **`Entity_UpdateBehavior`** (guess — structure confirmed, *not* decoded branch-by-branch) — the
  dense, hardcoded-per-type gameplay rules dispatcher: switches on a "kind" field (`+4`) and
  nested sub-type/state fields, implementing movement, collision response, and (via `[8b6b]`,
  `Rng_NextValue`'s output) randomized behavior choices. This is genuinely where the gameplay
  rules live, but at ~600 decompiled lines of entity-specific magic numbers, it was deliberately
  **not** decoded further in this pass — the effort/payoff ratio favors a dedicated future
  session, ideally with dosbox-x behavioral verification rather than reading magic numbers cold.
  A later pass named its full ~29-function immediate callee graph (see `symbols/gameu.json`):
  two parallel per-world x per-kind dispatch tables (`Entity_DispatchUpdateByKind` for per-frame
  update, `Entity_DispatchHitReactionByKind` for on-hit reactions), a state-driven collision
  handler (`Entity_HandleCollisionOrStateDispatch`) with five `[8b98]`-keyed sub-handlers, the
  entity state->script-pointer resolver (`Entity_SetStateAndScript`, confirmed to read the same
  `0xcd88` default-script table `Entity_RunScript`'s docs already named, plus a second table at
  `0xd996` for negative state IDs), movement primitives gated by collision flags
  (`Entity_MoveHorizontalByFlags`/`Entity_MoveVerticalUpByFlags`/`Entity_MoveVerticalDownByFlags`),
  the sound-effect trigger (`Snd_TriggerEffect`/`Snd_TriggerEffectRaw`), and the spawn-event queue
  producer (`Entity_PushSpawnEvent`, confirmed to push onto the same `[8bb5]` buffer
  `Level_UpdateEventQueue` already reads). **`Entity_RebuildVisibleList`** (called from this
  graph) was also found and is a significant structural lead for the still-open `blocks*.pak`
  question — see `docs/formats/pak.md`. The ~34 leaf kind-handler functions these two dispatch
  tables fan out to are still unnamed and are the natural next target.
- **`Entity_FreeSlot`** (confirmed) — removes a dead entity from a **~140-slot entity-pointer
  array at `1000:9090`–`0x91a8`** via linear scan + compaction (classic dense-array free-list
  removal). Confirms `Entity_UpdateAll`'s list walk (`0x91be`) operates over this same array.

A full follow-up pass named the entire immediate + one-level-deep callee graph of
`Entity_UpdateBehavior`'s two per-world x per-kind dispatch tables (see `symbols/gameu.json`,
72 functions total). Key structural discoveries:

- **Entity struct size is `0x42` (66) bytes**, stored in a separate contiguous block
  (`~0x9356`–`0xb918`, ~146 max entities) from the `0x9090`–`0x91a8` pointer array —
  `Entity_FindEntityByKind` (formerly misnamed `Entity_LookupTypeTableEntry`) linear-scans this
  block by a type/kind field to find a target entity (e.g. the player) for chase/attack AI.
- **`[0xef23]` is a *swappable pointer variable*, not a fixed table address.** Most patrol-AI
  kinds share one generic think function (`Entity_ThinkPatrolAI`) but several
  (`Entity_ThinkPatrolWithCustomTileTableA`/`B`) temporarily redirect `[0xef23]` to their own
  per-kind tile/collision-flag table before calling it, then restore it — a clean data-driven
  mechanism for per-kind terrain rules without duplicating the patrol logic itself.
  **Sharpened while starting the JS port's ground-collision code (`docs/port-plan.md` Phase 3):**
  `Entity_ScanGroundRow` (`1000:e366`) reads `*(char*)([0xef23] + tileByte)` — i.e. the table is
  indexed **directly by the raw level-map tile byte value** (0-255) and returns a per-tile
  collision-contribution score, accumulated into `[8bc9]`. This is genuinely the tile-solidity
  rule the port needs, but (a) it's per-kind (several distinct tables, not one universal
  solid/passable table) and (b) none of the actual table *contents* at `0xef23`'s default target
  have been dumped yet. This confirms, from the collision side, what `docs/formats/pap.md`
  already established from the data side: every shipped `.pap` cell is 1-120 (real tile art),
  zero cells are ever `0` -- so "tile value 0" isn't a usable empty/passable marker for collision
  purposes (it just doesn't occur), and a quick brightness/variance heuristic over the decoded
  tile art doesn't cleanly separate solid rock from passable cave interior either.
  **RESOLVED: the default table's contents are now dumped.** `read_memory` at `6de3:f189`
  (256 bytes) returns a clean, clearly hand-authored classification -- entries 1-120 (exactly the
  valid `.pap` range) are `0` (passable), `1` (solid), or `16` (a distinct "special" ground type,
  meaning unconfirmed -- possibly a ladder or hazard marker; both `1` and `16` are treated as
  solid-for-standing by the JS port, only `0` as passable). Cross-checked against
  `level1a.pap`: 9.4% of cells read passable under this table, a plausible fraction for a
  carved-cave level. The alternate table `Entity_ThinkPatrolWithCustomTileTableA`/`B` swap
  `[0xef23]` to, `6de3:f27b`, was also dumped -- structurally near-identical but with every `16`
  replaced by `0` (a stricter variant), which independently corroborates that `0xf189` isn't
  noise. See `web/core/tile-collision.js` for the transcribed table and
  `web/engine/real-terrain.js` for the JS port's real (not placeholder) collision built from it --
  this closes the open item `docs/port-plan.md` Phase 3 left tracked, and the placeholder
  collision surface it introduced has been retired.
  ⚠️ **Corrected 2026-10-09 (ledger items 8-9, `[PROVEN]`).** The table above at `0xf189` is **world 3's**, not "the default": `[0xef23]` is set per world from the word list at `DS:0xEF25` (`0xEFA5`, `0xF097`, `0xF189`, `0xF2F5` for worlds 1-4), each 242 bytes; world 1 gameplay reads `0xEFA5`. The "alternate table at `0xf27b`" is a small separate table (values 0/1/99) that two patrol think functions swap in. The percentages and the "tile 16 = stricter variant" reading above were derived from the wrong table and should not be relied on.
- **Two independent AI systems exist for entities**: `Entity_RunScript`'s bytecode VM (opcode
  jump table at `1000:2383`, entity-behavior-level) and a second, movement-focused interpreter,
  `Entity_RunMovementAiScript` (`1000:6320`), which consumes opcode *characters*
  (`'n','p','q','r','s','t'`) from per-animation-set tables at `0xec7c`/`0xec68`/`0xec90` (chosen
  by `Entity_SelectAiScriptTableBlocked`/`Clear`/`Default` based on `Entity_ThinkPatrolAI`'s
  3-tile lookahead check) to drive chase/patrol/flee/attack decisions. Not decoded
  opcode-by-opcode — ~150 dense decompiled lines, a strong future-session target.
- **`Entity_SetStateAndScript`** is the confirmed state→script-pointer resolver: table at
  `0xcd88` for positive state IDs (matches this doc's earlier "default-script table" note) and
  `0xd996` for negative ones. Most `Entity_DispatchHitReactionByKind` leaves are simple inlined
  calls to this same pattern with hardcoded constants (`Entity_HitReactToState15` etc.).
- **`Entity_PushSpawnEvent`** confirmed as the entity-side producer for the same `[8bb5]` opcode
  queue `Level_UpdateEventQueue` consumes.
- **`Entity_RebuildVisibleList`** (see `docs/formats/pak.md`) builds the per-frame culled render
  list from the raw entity array — a significant structural lead for the still-open
  `blocks*.pak` background-tile question, though not yet proof (no runtime trace has confirmed
  `blocks*.pak` data actually lands in that array, and the ~146-slot cap may be too small to
  hold full level geometry for larger levels — a caveat against the entity-record hypothesis
  worth weighing in a future session).

Named function-kind entity handlers found this pass (non-exhaustive list; see
`symbols/gameu.json` for full addresses/comments): swinging/sliding/rotating gates
(`Entity_ThinkSwingingGate`/`ThinkSlidingGate`/`ThinkRotatingGate`), sleeping enemies that wake on
proximity (`Entity_ThinkSleeperWakeUp`/`WakeUpQuiet`), a charging/rolling hazard
(`Entity_ThinkChargingHazard`), an edge/obstacle-reset handler (`Entity_ThinkEdgeDetectReset`), a
vertical-column pathfinder (`Entity_ThinkVerticalPathfinder`), periodic idle-fidget handlers, and
eight functionally-identical generic-patrol delegates (`Entity_ThinkPatrolDefaultA`..`H`) reused
across many kinds/worlds.

## Ground collision and the breakable-tile mechanic (found this pass)

`Entity_ResolveGroundCollision` (`1000:e14f`) is the core floor/ground collision engine, called
from `Entity_SyncViewportTargetFromEntity`. It fans out through a cluster of ground-scan helpers
(`Entity_ScanGroundRow`/`Column` + `Variant`, `Entity_MergeGroundScanResults`) into several very
dense per-kind/per-world state-transition dispatchers (`Entity_ApplyGroundStateTransition`,
`Entity_ProcessGroundStateByWorldAndKind`, `Entity_ApplyGroundStateTransitionByKind` — since
decoded branch-by-branch in a later pass, see `docs/enemies.md`'s "Ground-collision per-kind
reactions" section and the "RESOLVED" note below). Along the way this revealed
the game's **breakable-tile mechanic**: `Entity_BreakTileOrBounce` and its siblings
(`Entity_BreakTilesAhead`/`Behind`/`AtOffset`, `Entity_BreakSpecificTileChar`) check whether a
tile in the level-map buffer is marked with a specific breakable-tile byte (e.g. `'<'`) and, if
so, rewrite that byte in place (the same mechanism as `Level_RewriteAnimatedTileIndex`) before
killing the triggering entity and playing a sound — this is how the player breaks blocks in the
level geometry.

## System/timer subsystem (found this pass)

`Sys_InstallCustomTimerHandler`/`Sys_RestoreOriginalTimerHandler` reprogram PIT channel 0 to a
custom tick rate and install/restore a timer interrupt vector — the game's own frame-pacing
clock, installed early and restored on exit. `Sys_InstallInterruptHandlers` separately saves and
replaces two more interrupt vectors (likely keyboard ISR + a DOS critical-error handler).
`Video_ExpandPaletteFadeTable` does a one-time bulk expansion of the 24-bank fade table at
`0xda96` using the same 3-bit→4-bit scaling as `Video_ScaleColorComponent`.
`Input_ReadCpuSpeedCalibrationByte` (`1000:1882`) calls directly into the `1ffb` segment
unconditionally — **segment `1ffb` is not purely alt-build-only code**; it hosts at least some
shared low-level utility routines used on every build.

## Bonus/checkpoint/score-popup subsystem (found this pass)

A cluster of periodic and collision-triggered gameplay-reward mechanics, distinct from the core
damage/interaction dispatcher:

- **`Entity_UpdatePeriodicBonusTimer`** (`1000:4464`) is a per-world ticker that pushes a bonus
  spawn event every 100 frames — the same "every-100" cadence pattern seen elsewhere in the
  timer-driven subsystems (c.f. `AltBuild_AdvanceScrollBankState`'s 100-frame counter, a
  coincidence worth noting but not yet shown to be related).
- **RESOLVED: `Entity_ChooseAndSpawnBonusItem`** (`1000:4a50`) decoded branch-by-branch. It runs
  every call (pushing a small "hit" event, playing a sound, and incrementing the bonus-marker
  frame counter `[0x8bb4]` — the same counter `EntityScriptOp_CheckBonusMarkerAndMaybeSpawn`
  documents in `docs/entity-script-vm.md`), but only does its actual item-selection work once the
  kind-`0x18` bonus-marker entity it looks up (via `Entity_FindEntityByKind`) has counted down to
  state `0x7b` — otherwise it just decrements that entity's state and returns early. Once ready,
  it plays a second sound, resets/re-tags the marker entity, and — unless a suppression path is
  hit (`[0x8b98]=-1` early-out, or the marker's own state gets set to `'C'`/0x43 first) — spawns a
  score popup and evaluates a **purely deterministic, counter-driven difficulty heuristic** (no
  RNG call anywhere in this function — a correction to an earlier guess that it used
  `Rng_NextValue`) keyed on world (`[0x8b89]`, falling back to `[0x8b8b]` for `0`, the same
  world-selector idiom used throughout) to pick which bonus item (entity `type`, written to
  `[0x8c1f]`) to spawn:
  - **World 1**: checks, in order, a level-progress counter `[0x8bb3]` (<4 → type `0x3a`), a
    second counter `[0x8c07]` (>10 → `0x3b`; <4 → `0x3d`; else its ratio against `[0x8c08]`
    gates → `0x3c`), then the running score/distance global `[0x8b75]` (>200 → `0x38`, shared with
    world 2's threshold below).
  - **Worlds 2–4** (the `else` branch): world 2 additionally checks `[0x8b75]` >400 → `0x38`
    first; then falls through the same three counters worlds 1 doesn't use — `[0x8c09]` >0 →
    `0x3f`, `[0x8bb2]` >0 → `0x36`, `[0x8bff]` >1 → `0x35` (a *different* consumer of the
    `[0x8bff]` step-counter than the one `docs/entity-script-vm.md` documents for opcode 68 — same
    global, unrelated read site).
  - **Shared fallback** (both branches, when nothing above matched): a final counter `[0x8c05]`
    picks between `0x37` (< 0x1f) and `0x39` (>= 0x1f).
  - All ten resulting type values (`0x35`–`0x3d`, `0x3f`) resolve, via the shape-descriptor table
    (`symbols/entity-shapes.json`), to sprites in bank `3` ("`special`", per-world) or bank `6`
    ("`extras`"/"`extrax`", the fixed/shared bonus-icon set) — except `0x3f`, the one exception,
    which draws from bank `2` ("`kidx`", the player-adjacent bank) — confirming these are all
    genuine spawnable bonus-item entities, not placeholder/debug values. (Numeric coincidence
    worth flagging: `docs/enemies.md`'s breakable-tile-type table also uses hex values in this
    same `0x35`–`0x3f` range, but for an unrelated tile-char namespace — don't conflate the two.)
  - After selection, it always finishes with a fixed-position spawn (`0x8c21`/`0x23`/`0x25`/`0x27`
    = `0x66`/`4`/`0x20`/`0x155`) via `Entity_PushSpawnEvent` (opcode `0x2d`).
  **Follow-up pass, most of the remaining difficulty-input globals now named** (via
  `search_byte_patterns` on each global's raw address bytes, the same method
  `docs/entity-script-vm.md` used for `[0x8bff]`/`[0x8bb4]`):
  - **`[0x8bb3]` — a per-level "special block destroyed" counter**, world-1/2-specific. Reset to 0
    in `Level_InitStateForSublevel`, incremented in `FUN_1000_3fe2` (state=`0x1c`/script=`0xc655`,
    also clears the `[0x8b96]` cooldown `Entity_ChooseAndSpawnBonusItem` sets), which is called
    from `Entity_HandleSpecialInteraction` exactly when the entity collided with has type `0xd`
    (world 1) or `0x33` (world 2) — the same world-1/2 "four-part breakable block" types
    `docs/enemies.md`'s ground-collision section documents. So world 1's `[0x8bb3]<4 → item 0x3a`
    branch really reads as "spawn the basic bonus item until the player has broken at least 4 of
    this world's special blocks."
  - **`[0x8c07]`/`[0x8c08]` — a paired "generic hazard block destroyed" counter and its
    accumulated reward-value total.** Both are written together in
    `Entity_InteractionPhaseResolveByWorldAndType`'s shared epilogue (table index 5, reached for
    types `0x10`/`0x34`/`0x39`/`0x3e` — the cross-world generic hazard-block types
    `docs/enemies.md` already documents): `[0x8c07] += 1` per block destroyed, `[0x8c08] +=` that
    block's own reward-value byte (`entity+0x3f`). Same epilogue also zeroes `[0x8c05]` — see
    below.
  - **`[0x8c09]` — an AI-side "captured/despawned by predator" counter**, incremented in all three
    branches of `Entity_AiOpDespawnOrKill` (`1000:6aa7`, the movement-AI VM's `'n'`-opcode
    despawn/attach handler) alongside the acting entity's own `+0x3c` "kills performed" field. This
    is thematically tight: `[0x8c09]>0` selects bonus type `0x3f`, and `0x3f` is the one bonus item
    drawn from bank 2 (`bitkid`/`kidx`, the player-adjacent bank) rather than bank 3/6 like every
    other bonus type — i.e. "if a predator enemy captured a `kidx`-bank companion this level, the
    replacement/rescue bonus is drawn from that same character bank" is a coherent read, though the
    exact narrative (kidnapped companion vs. some other `kidx`-bank actor) isn't nailed down by
    code alone.
  - **RESOLVED: `[0x8c05]` — a broader "hazard/breakable interaction resolved" tally, distinct
    from (but overlapping) `[0x8c07]`.** Incremented (`+=1`, alongside a sibling counter
    `[0x8c06]`) at the top of `Entity_ResolveInteractionRewardAndBonusMarker` (`1000:549c`), the
    shared reward primitive called from **three** interaction-phase-table entries (1/4/12 —
    `Entity_InteractionPhaseResolveHitAndPairing`/`ResolveBreakOrHazard`, a wider set of
    interactions than the single "generic hazard block" epilogue that resets it). Two independent
    consumers now confirmed: `Entity_ChooseAndSpawnBonusItem`'s final `<0x1f` split (read-only),
    and `Entity_InteractionPhaseType1bHandler`'s own `0x17`-tag pickup case, which *also*
    read-and-resets it (`bVar1 = [0x8c05]; [0x8c05] = 0;`) to compute a bonus-item spawn value —
    a second, independent reset path beyond the `Entity_InteractionPhaseResolveByWorldAndType`
    epilogue already documented above. Net effect: `[0x8c05]` counts hazard/breakable
    interactions resolved since the last time either a generic-hazard-block break *or* a specific
    pickup-type-`0x17` collection last drained it.
  - **RESOLVED: `[0x8bb2]` — a capped (max 3) "pickup collected" counter, specific to one
    paired-entity collectible tag.** `Entity_InteractionPhaseType1bHandler` (`1000:5bad`) turned
    out to be exactly the right function (the earlier pass just hadn't read far enough into it):
    it dispatches on the *other*, paired entity's `+10` field — a small family of one-shot pickup
    handlers, each of which kills the collected entity and plays a sound. Tag `0x1b`'s handler
    increments `[0x8bb2]`, capped at `3` (further collections past the cap instead fall through to
    a no-reward despawn path, `FUN_1000_596b`); tag `0x17`'s handler (see `[0x8c05]` above) reads
    `[0x8bb2]==3` as a gate for a bonus spawn value. So worlds 2–4's `[0x8bb2]>0 → item 0x36`
    branch in `Entity_ChooseAndSpawnBonusItem` reads as "spawn a better bonus once the player has
    started collecting this specific pickup type" — sibling counters `[0x8b93]`/`[0x8b90]`/
    `[0x8c03]` in the same handler function are the same "capped pickup-type counter" idiom for
    three *other* collectible tags (`0x19`/`0x18`/`0x1a`), not yet cross-referenced to their own
    bonus-heuristic consumers if any.
- **`Entity_ChooseAndPlaceBonusMarker`** (`1000:5609`) places/updates a *marker* (likely a visual
  indicator of upcoming bonus placement) based on distance-travelled-since-last-marker compared
  against a per-difficulty table — a separate, simpler heuristic from the item-choice logic above.
- **`Entity_SpawnScorePopup`** (`1000:4bd1`) writes a HUD glyph digit (via the same custom
  glyph-code family `Hud_UpdateScoreDisplay` uses) and pushes a spawn event — this is the
  floating score/counter popup shown when points are earned.
- **Checkpoint/respawn behavior** is the best-supported guess for `Entity_ProcessCollisionState15`
  (`1000:d9e6`), the `0x8b98==0x15` handler inside `Entity_HandleCollisionOrStateDispatch`: it
  manipulates counters at `[8b94]`/`[8b95]`/`[8b97]`, triggers a sound on state transitions, and on
  a completion condition resets several state fields and pushes a spawn event with opcode `0x15` —
  consistent with a checkpoint-reached or score-milestone trigger, but not fully decoded.
  `Entity_HandleSpecialInteraction` (`1000:3e15`) is the broader collision-effect dispatcher this
  and other checkpoint/pickup/hazard reactions hang off of; also dense, also not decoded
  branch-by-branch, **though its own decompile was read in full by a later pass (see below) to
  chase its cross-references, even though its ~180-line body isn't narrated branch-by-branch here.**
- A small state-machine of helpers around this — `Entity_SetInteractionPhase1B`/`0E`/
  `1DFindTarget`/`27WithSound`, `Entity_SetInteractionState5DOr5B`, `Entity_ClampCameraOffset`, and
  the dispatcher `Entity_InteractionPhaseJumpTable` — track a multi-phase interaction sequence
  (sound cues, camera-offset clamping, finding a target entity) that plausibly backs a scripted
  cutscene-like reaction (e.g. end-of-level or checkpoint celebration).
  **RESOLVED (two later passes, see `docs/entity-script-vm.md`'s "The interaction-phase table,
  fully accounted for"): the table is NOT unrecoverable — a direct `read_memory` dump of its 20
  words worked cleanly, and its real caller chain is `Entity_UpdateBehavior` →
  `Entity_BroadcastEventToVisibleByKindFlag` → `Entity_CheckAabbOverlapOrBroadcast` (an AABB
  hitbox-overlap test) → this table on full overlap — i.e. it's the generic "two entities' hitboxes
  now overlap, keyed by why the check was run" resolver, not a fixed cutscene-phase enum.** 9 of its
  20 slots are self-referential dead/trap entries; the rest resolve to already-documented machinery
  (`Entity_ChooseAndSpawnBonusItem`, the breakable-block reward path) plus one newly-found generic
  "pair two entities into an interaction" sequence (`Entity_InteractionPhaseResolveHitAndPairing`)
  that turns out to share its exact state/script/countdown constants with
  `Entity_PairWithType1cPropAndArmCutscene` — confirming that function is a specialized front-end
  for this same general mechanism, not a one-off.
  **CONFIRMED (later pass, see `docs/entity-script-vm.md`'s "Struct-field and global-register
  findings" section): this native-code interaction-phase family and the entity-scripting VM's
  `EntityScriptOp_RunSpecialInteractionSequence`/`EntityScriptOp_SpawnEffectByTypeCode` opcodes are
  two ends of one shared pipeline, not independent systems.** `Entity_HandleSpecialInteraction`
  itself writes `[0x8c04] = 0x40` (`'@'`) — the exact value the script-VM opcode polls as a
  one-shot trigger — among several other tag values, and `Entity_SetInteractionPhase1B` writes the
  same `[0x8bf7]`/`[0x8bf9]`/`[0x8c69]` globals the script VM's type-`0xe`/`0x1b` spawn branch
  reads. This was checked properly (xrefs/shared-globals), not assumed from structural similarity —
  contrast `docs/enemies.md`'s `Entity_HandleWorld3SpecialTrigger`, which looked similarly related
  to the same script opcode but, when actually checked, turned out **not** to be linked.

## RLE tile-bank decompression (alt-build only; found this pass)

Separate from the RNC ProPack depacker used for every shipped data file (see
`docs/formats/pak.md`), the CGA/Tandy alt-build code path has its **own**, simpler RLE scheme for
unpacking tile banks after the RNC layer, plus a CGA-specific bit-packing step to go from
EGA-style planar data down to CGA's 2-bit format:

- **`AltBuild_InitRleDecoder`**/**`AltBuild_AdvanceRleDecoder`** (`1000:af32`/`af2a`) — a
  `(repeatCount, value)`-pair RLE stream reader, structurally similar to the demo-input RLE buffer
  (`Demo_PlaybackInput`/`RecordInput`) but for tile-bank pixel data, not input state.
- **`AltBuild_ComputeXorKey`** (`1000:af1b`) computes `BX ^ (BX+0x10)` as a lookup key feeding the
  decompression — likely a cheap transposition/whitening step rather than real encryption.
- **`AltBuild_ConvertTileBankRle`**/**`AltBuild_ConvertTileBankRleVariant`** (`1000:afb1`/`afcd`)
  are the two top-level converters (differing only in XOR key), driving the RLE decoder and
  writing decompressed nibbles into the CGA tile-bank buffer.
- **Bit-packing chain**: `AltBuild_ExtractSignBitPair` → `AltBuild_PackBitsToNibbles` →
  `AltBuild_PackNibbleFromSignBits` → `AltBuild_ConvertTileNibbleGroup`/
  `ConvertTileNibbleDispatch` progressively fold 4 EGA-style plane-bit registers down into packed
  CGA nibbles/bytes — this is the plane-de-interlacing step referenced in the earlier
  "alt-build subsystem" finding, now with its individual stages named.
- The intro-image loaders (`AltBuild_LoadTandyIntroImage`/`LoadCgaIntroImage` and their
  `ConvertIntroImageBank`/`ConvertIntroImageRow` helpers, `192` rows matching `.pip` picture
  height) reuse this same nibble-packing chain for the full-screen intro picture, not just tile
  banks.
- **Low priority for the JS port**: since the port targets EGA/VGA 16-colour as the reference
  display mode (per the project plan), this entire chain only matters for reproducing the
  CGA/Tandy fallback renderer, not for asset extraction.

## Viewport edge-clipping (two independent copies; found this pass)

Smooth horizontal scrolling needs the newly-exposed screen column at the scroll edge to be
cleared/masked each frame (the sub-tile pixel-panning remainder means tile columns don't line up
with the pixel grid). This mechanism exists **twice** in the binary, structurally parallel but
using entirely separate globals — consistent with the project's now-familiar pattern of
duplicated subsystems (three copies of the main loop, a full CGA sibling of the scaled HUD-text
blitter, etc.):

- **Primary (VGA) copy**: `Gfx_ComputeViewportEdgeMask` (`1000:8f6a`) computes an AND-mask from
  the destination X position adjusted by the pixel-panning remainder; `Gfx_MaskViewportEdgeColumn`
  (`1000:88f5`) applies it across all 4 bitplanes over 192 rows; `Gfx_ClearViewportEdgeColumn`
  (`1000:88d2`) clears a tile-row's worth of bytes outright; `Gfx_CopyViewportColumn` (`1000:8952`)
  and `Gfx_UpdateViewportClipBounds` (`1000:87a1`) manage the column copy and the clip-bounds state
  across frames. `Gfx_ComputeFramebufferRowOffset`/`ComputeViewportEdgeMaskVariant` are 2-plane vs
  4-plane sibling variants of the mask computation.
- **Second (alt-build) copy**: `AltBuild_AdvanceScrollBankState` (`1000:a3e3`) is the top driver,
  keyed on the same `DAT_1000_22d7` mode flag seen throughout the CGA/Tandy alt-build code; it
  counts a frame counter to 100 then calls `AltBuild_ResetScrollBankState` and rewrites the CRTC
  offset-register constant `0x16` into `[8c34]` — the exact value `docs/memory-map.md` documents
  as producing the 352-pixel virtual scroll width, confirming this second copy manages the same
  hardware scroll-width parameter as the primary copy, just for the alt-build display path.
  `AltBuild_ComputeScrollBankBase`, `AltBuild_ClearScrollBankRegion`,
  `AltBuild_AndMaskScrollBankColumn`(`Pair`/`Loop`), and `AltBuild_RotateScrollMaskBits` mirror the
  primary copy's compute/clear/mask/copy quartet function-for-function.
- Both copies use the identical `+0x2000`-with-wraparound bank-interleave arithmetic pattern
  (wrapping at `0x4000` or `0x8000` depending on mode), which is also the same pattern used by the
  unrelated CGA scaled-glyph/sprite blit family (`Gfx_BlitScaledGlyphRowCga` etc.) — this appears
  to be a general idiom for indexing bank-switched EGA/CGA framebuffer memory throughout the
  codebase, not specific to scrolling.

## Confirmed: the sprite-mirroring bit-reversal table

`Gfx_BuildBitReversalTable` (`1000:b4aa`) builds the 256-byte bit-reversal lookup table at
`0x8eee`, **confirming** the hypothesis noted earlier (`Gfx_MirrorRowThroughLut`) that horizontal
sprite mirroring works by reversing each byte's bit order through a precomputed LUT rather than by
any per-pixel branching. A second, structurally identical table exists at `0xa2e3` for the
scaled-blit sprite family.

## `.pin` sound/music files: 161 real MIDI files recovered (found this pass)

A byte-level scan of every depacked `.pin` file (see `docs/formats/pin.md` for the full
writeup) found genuine, valid embedded Standard MIDI File data in 4 of the 18 files —
`roland2.pin` (one full 17KB song), `soundbnk.pin` (a short placeholder track plus ~17KB of
still-unidentified trailing data), and `adlib.pin`/`roland.pin`, which turn out to be
**sound-effect banks**: 78 and 81 tiny individual MIDI cues respectively, concatenated
back-to-back behind a small resource-offset table. `tools/extract-pin.js` extracts all of them
as playable `.mid` files — a complete, independently-verified (macOS `file(1)` confirms
"Standard MIDI data" on the output) audio-asset recovery requiring no OPL/MT-32 driver-bytecode
decoding at all. The other 14 `.pin` files (Adlib/SoundBlaster OPL-format siblings, per-level
`level*.pin` files, driver code stubs) remain unclassified beyond header-shape guesses.

## Open threads for a future session

- **The `blocks*.pak` background-tile render consumer is still unlocated**, despite an exhaustive
  trace of every reader of the level-map buffer (`6de3:4200`/`[8c13]`), `Gfx_BlitSpriteMasked`'s
  full caller graph (only `Gfx_DrawObject`, which is entity-list-driven), and every
  `World*_LoadBanks` post-load helper. Working hypothesis: background geometry is built from
  placed entity records at load time rather than raster-blitted from the `.pap` grid — see
  `docs/formats/pak.md` for the full search trail. Needs a dosbox-x trace of entity-list
  population at level load to confirm or refute.
- **RESOLVED: `Entity_UpdateBehavior` is now decoded branch-by-branch for every class (0-7) and
  both special-cased pre-check types**, not just dispatch shape, and both of its per-(world, type)
  AI tables (`Entity_DispatchUpdateByKind`, `Entity_DispatchHitReactionByKind`) plus a **third**
  one found this pass (`Entity_SelectNextStateByWorldAndKind`, the "clear all enemies"/defeat-state
  table) are fully mapped — see `docs/enemies.md`. That doc also corrects this file's earlier claim
  that `Entity_UpdateAll` dispatches to *either* a heavy or a light per-entity step (see the
  corrected main-loop table entry above). What's left inside `Entity_UpdateBehavior` is only the
  *contents* of the `+0xc` script pointers each branch writes (that's `Entity_RunScript`'s own
  opcode VM, a separate concern — see below), not the dispatch logic itself.
- **RESOLVED (opcode-level *and* byte-exact): `Entity_RunMovementAiScript`** (`1000:6320`) — the
  second AI bytecode interpreter (opcode chars `'n','p','q','r','s','t'` from per-animation-set
  tables at `0xec7c`/`0xec68`/`0xec90`) now has every opcode's role characterized *and* the three
  20-byte tables dumped/tabulated byte-for-byte via `read_memory` — see `docs/enemies.md`.
- **RESOLVED: the ground-collision per-kind pipeline** (`Entity_ApplyGroundStateTransition`,
  `Entity_ProcessGroundStateByWorldAndKind`, `Entity_ApplyGroundStateTransitionByKind`,
  `Entity_DispatchGroundStateByKindA`/`B`) is now decoded to concrete per-world/per-type detail —
  a distinct breakable-tile/hazard-block system (bank 3/6 sprites) separate from the patrol/chase
  "nasty" enemy tables above. **RESOLVED: `Entity_ApplyComplexGroundResponse`** (the class-3/player
  branch of this same pipeline) is now decoded — see `docs/enemies.md`'s player-physics section.
- **RESOLVED: `Entity_RunScript`'s opcode jump table.** The table is 78 entries (`0x00`-`0x4D`),
  not 256 as originally guessed — the byte range beyond that is real code
  (`Entity_ResetExtendedFields`), not table data. All 78 opcodes are characterized — movement,
  spawn, sound, palette-fade, a CALL/RETURN subroutine mechanism, and direct opcode-level control
  over the `[0x8ba1]` AI-freeze flag and the hardware scroll-width register — with two real
  example scripts decoded byte-exact from the default-script tables. A separate VM from
  `Entity_RunMovementAiScript` above. See `docs/entity-script-vm.md`; some opcodes' call targets
  remain untraced, listed honestly in that doc's closing section.
- **All 441/441 functions are now named** (`symbols/gameu.json`) — the naming sweep itself is
  complete. **RESOLVED: `Entity_HandleWorld3SpecialTrigger`** is now confirmed as a world-3
  boss-defeat reward-sequence trigger (searches for kind `0x41`, independently cross-validated as
  world 3's boss kind by `EntityScriptOp_WaitForBossDefeatThenKillSelf`'s per-world boss-kind
  table `0x15/0x40/0x41/0x43` — see `docs/enemies.md`). Remaining depth gaps, narrowed by this
  session: `Entity_HandleSpecialInteraction` and `Entity_ProcessDamageAccumulation` — each a
  self-contained target for a future session, ideally paired with dosbox-x behavioral verification
  rather than reading magic numbers cold.
  `Entity_ChooseAndSpawnBonusItem` and `Entity_RunScript`'s opcode jump table are now resolved —
  see `docs/entity-script-vm.md` for the latter (the former is cross-referenced from it, still
  not decoded branch-by-branch itself but confirmed as the target of `EntityScriptOp_CheckBonusMarkerAndMaybeSpawn`).
- **RESOLVED: `[0x8b8b]` is a sub-level index, not a second copy of the world number.** Confirmed via
  `search_instructions` across every reference to it: several level/sub-level-start call sites write
  the literal constant `1` into it regardless of which world is selected, and other readers compare
  it against `6`/`8` (values that make no sense as a 4-world selector). The `if([8b89]==0) x=[8b8b]`
  fallback idiom used in several dispatch functions is a narrow special case, not evidence the two
  fields are interchangeable in general — see `docs/enemies.md`'s charging-hazard section for the
  byte-identical-instruction evidence (shared with `Level_RunScriptedEventStream`'s already-documented
  world-1/sub-level-6 cutscene check) that nails this down. The world/sub-level struct passed around
  as `[8b89]`/`[8b8b]` is still worth formalizing as a real Ghidra struct now that both fields'
  actual roles are known.
- Resolving the entity record layout fully — confirmed so far: `+0`=type/facing (sign bit used
  as an off-screen marker by `Entity_RebuildVisibleList`), `+1`=state byte, `+2`=type/shape-class,
  `+4`=kind (confirmed, per a later pass, to be a direct spawn-time copy of the shape descriptor's
  own `+0x18` field — see `docs/entity-script-vm.md`), `+6`/`+8`=X/Y, `+0xc`=script pointer,
  `+0x10`/`+0x12`=animation range start/end (also descriptor-copied at spawn), `+0x14`=orientation/
  hitbox-size, `+0x16`=a spawn-time copy of the shape descriptor's `+8` render-dispatch/shape-type
  value, script-overridable at runtime (`docs/entity-script-vm.md`'s op 57) — likely a live
  blit-variant/shape-class swap, e.g. for a boss phase-transform, `+0x18`-`+0x22`=a 6-word
  hitbox-extent block copied at spawn from a per-shape-class table (resolves
  `docs/formats/pak.md`'s long-open `+0x1a` hitbox-index question — see `docs/entity-script-vm.md`),
  with `+0x1c`/`+0x20` (two words inside this same block) also script-adjustable at runtime for
  animation-frame-keyed hitbox resizing,
  `+0x24`=collision/blocked-direction flags, `+0x26`/`+0x28`=speed pair (set by
  `Entity_SetupDirectionVector`), `+0x2a`=charge/wind-up counter, `+0x2c`=linked-child entity
  pointer, `+0x2e`=animation-set-progress counter, `+0x30`/`+0x32`/`+0x34`=direction-vector
  sign+magnitude, `+0x36`/`+0x37`/`+0x38`=charge threshold/state fields, `+0x39`=animation-set
  selector (feeds `Entity_ThinkPatrolAI`'s tile-lookahead and the `[0xef23]` swappable table),
  `+0x3a`/`+0x3b`=animation frame counter/target, `+0x3c`=a counter incremented by
  `Entity_SetupDirectionVector`, `+0x3e`/`+0x3f`=misc state, `+0x40`=state (`0x19`="dead/remove").
  Entity struct size is `0x42` (66) bytes total, stored in a contiguous block at
  `0x9356`-`0xb918` (~146 entities max) — separate from the `0x9090`-`0x91a8` pointer array that
  indexes into it. `Entity_ResetExtendedFields` (`1000:241f`, zeroes `+0x24`..`+0x3c` on spawn)
  and `Entity_SpawnFromQueuedEvent` (`1000:c2f3`, the entity factory — see below) are the two
  best single references for this layout.

## The entity spawn/creation system

Found while naming `Entity_UpdateBehavior`'s callee graph, this resolves the open
"`FUN_1000_c2f3` (event-queue callback)" item from an earlier pass:

- **`Entity_SpawnFromQueuedEvent`** (`1000:c2f3`) is the entity **factory**: given an opcode and
  a payload (dequeued from the `[8bb5]` event queue — see `Entity_PushSpawnEvent`/
  `Entity_PushPositionEvent`), it allocates a free slot (`Entity_FindFreeSlot`, scanning the
  `0x9356`-`0xb918` struct block for a zero type field) and initializes it per-opcode: `0x11`/
  `0x25` create a linked child attached to a parent entity; `0x1f`/`0x44`/`0x53` do raw setup
  pulling script pointers from tables `0xcd9c`/`0xcd88`/`0xcdfe`. **Correction (see
  `docs/entity-script-vm.md`): these are not a third/fourth independent table.** Byte-exact
  `read_memory` comparison proves `0xcd9c` and `0xcdfe` are literal aliases *into* `0xcd88` —
  `0xcd9c = 0xcd88 + 10*2` (16 consecutive words verified identical) and
  `0xcdfe = 0xcd88 + 59*2` (16 consecutive words verified identical). There are only **two**
  physical state→script tables in the whole engine: `0xcd88` (positive states) and `0xd996`
  (negative states) — `Entity_SetStateAndScript`'s pair, also reused everywhere else (the VM's
  own seed-on-first-run logic, `Entity_SpawnFromQueuedEvent`'s `0xcd9c`/`0xcdfe` "aliases" above,
  and opcode 8's controller-entity state assignment in `docs/entity-script-vm.md`); `0x2b` sets up a
  fixed charge-type entity; `0x2f` re-splices an entity's list position; and **`0x5e` is
  confirmed as the firework/particle-spawn opcode** used by `Game_WarpToLevelStageAndRunLoop`'s
  ending sequence, picking one of 4 random animation-frame ranges via `Rng_NextValue`. After
  per-opcode setup, a shared default path fills position/orientation/state from the payload
  (varying by payload word-count: 4/5/6/8-word layouts), and the new entity is inserted into the
  list per a **separate priority selector** read from `[8c77]` (values 1–6, each targeting a
  specific kind-ordered insertion point) — a z-order/priority insertion scheme.
- **`Entity_SetupDirectionVector`** (`1000:30b3`) computes a Bresenham-like direction vector
  toward a fixed-point target — likely homing-projectile setup, used by opcode `0x1f`.
- **`Level_RunScriptedEventStream`** (`1000:c1e6`) is a second, *static* level-scripted-event
  system (sentinels `0xaaaa`/`0xbbbb`/`0xcccc`/`0xdddd`), distinct from this dynamic runtime
  queue — see the cross-cutting findings section above.
- **RESOLVED: found the on-disk file this static stream reads from.** `Level_RunScriptedEventStream`
  walks data loaded from `new1.pin`/`level2.pin`/`level3a-c.pin`/`level4.pin` (one per world,
  `level0.pin` an alternate world-1 variant) straight into the main data segment at level-load
  time — these were previously miscategorized as unclassified/music `.pin` files (see
  `docs/formats/pin.md`). The full on-disk record format (byte-exact, derived from this
  function's raw disassembly) — including a header table of per-sub-level entry-point offsets,
  and the entity-spawn record layout giving type + X/Y position — is documented in
  `docs/formats/pin-level-script.md`. This is exactly the "sprite placement/identity metadata"
  `docs/formats/pak.md` had flagged as living "elsewhere, not yet traced". Extracted and
  overlaid on rendered levels via `tools/extract-level-script.js` + `tools/viewer.html`.
