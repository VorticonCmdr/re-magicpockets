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
| 8 | `Entity_UpdateAll` | guess | Walks a linked list of entity records from `0x91be`; dispatches per-entity update (`FUN_1000_22da`) or a lighter inactive-entity step (`FUN_1000_ca6d`), checking a `+0x40 == 0x19` "dead" marker throughout. |
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
`Entity_ProcessGroundStateByWorldAndKind`, `Entity_ApplyGroundStateTransitionByKind` — none
decoded branch-by-branch, all flagged as future-session targets). Along the way this revealed
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
- **`Entity_ChooseAndSpawnBonusItem`** (`1000:4a50`) is the actual bonus-item selection logic:
  dense per-world difficulty heuristics choose *which* bonus item to spawn and where. Not decoded
  branch-by-branch (flagged as a future-session target), but its role as the bonus-spawn decision
  point is confirmed by its callers and its use of `Rng_NextValue`/`Entity_SpawnFromQueuedEvent`.
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
  branch-by-branch.
- A small state-machine of helpers around this — `Entity_SetInteractionPhase1B`/`0E`/
  `1DFindTarget`/`27WithSound`, `Entity_SetInteractionState5DOr5B`, `Entity_ClampCameraOffset`, and
  the dispatcher `Entity_InteractionPhaseJumpTable` (an unrecoverable computed jump table) — track
  a multi-phase interaction sequence (sound cues, camera-offset clamping, finding a target entity)
  that plausibly backs a scripted cutscene-like reaction (e.g. end-of-level or checkpoint
  celebration), but the phase numbering's exact meaning was not fully traced.

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
- **`Entity_UpdateBehavior`**'s ~600 lines of per-type/per-state gameplay logic — the single
  highest-value remaining target; this is literally "how the game plays." (Its full immediate
  callee graph, 72 functions, is now named — see the entity-system writeup above — but the
  dense body of `Entity_UpdateBehavior` itself is not yet decoded branch-by-branch.)
- **`Entity_RunMovementAiScript`** (`1000:6320`) — the newly-found second AI bytecode
  interpreter (opcode chars `'n','p','q','r','s','t'` from per-kind tables at
  `0xec7c`/`0xec68`/`0xec90`). ~150 dense decompiled lines, not decoded opcode-by-opcode.
- **`Entity_RunScript`'s opcode jump table** (`1000:2383`, 256 entries) — decoding this reveals
  the entity scripting language.
- **All 441/441 functions are now named** (`symbols/gameu.json`) — the naming sweep itself is
  complete. What remains is *depth*, not *coverage*: several structurally-named-but-dense
  functions (`Entity_UpdateBehavior`, `Entity_ApplyGroundStateTransition`,
  `Entity_ApplyComplexGroundResponse`, `Entity_HandleSpecialInteraction`,
  `Entity_ProcessDamageAccumulation`, `Entity_ChooseAndSpawnBonusItem`,
  `Entity_RunMovementAiScript`, `Entity_RunScript`'s opcode jump table) are flagged `guess` and
  were deliberately not decoded branch-by-branch — each is a self-contained target for a future
  session, ideally paired with dosbox-x behavioral verification rather than reading magic numbers
  cold.
- The world/sub-level struct passed around as `[8b89]`/`[8b8b]` — worth formalizing as a Ghidra
  struct once its full field layout is known.
- Resolving the entity record layout fully — confirmed so far: `+0`=type/facing (sign bit used
  as an off-screen marker by `Entity_RebuildVisibleList`), `+1`=state byte, `+2`=type/shape-class,
  `+4`=kind, `+6`/`+8`=X/Y, `+0xc`=script pointer, `+0x14`=orientation/hitbox-size,
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
  pulling script pointers from tables `0xcd9c`/`0xcd88`/`0xcdfe` (a **third and fourth**
  state→script table, alongside `Entity_SetStateAndScript`'s `0xcd88`/`0xd996`); `0x2b` sets up a
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
