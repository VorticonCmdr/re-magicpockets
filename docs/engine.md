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
- **`Entity_FreeSlot`** (confirmed) — removes a dead entity from a **~140-slot entity-pointer
  array at `1000:9090`–`0x91a8`** via linear scan + compaction (classic dense-array free-list
  removal). Confirms `Entity_UpdateAll`'s list walk (`0x91be`) operates over this same array.

## Open threads for a future session

- **The `blocks*.pak` background-tile render consumer is still unlocated**, despite an exhaustive
  trace of every reader of the level-map buffer (`6de3:4200`/`[8c13]`), `Gfx_BlitSpriteMasked`'s
  full caller graph (only `Gfx_DrawObject`, which is entity-list-driven), and every
  `World*_LoadBanks` post-load helper. Working hypothesis: background geometry is built from
  placed entity records at load time rather than raster-blitted from the `.pap` grid — see
  `docs/formats/pak.md` for the full search trail. Needs a dosbox-x trace of entity-list
  population at level load to confirm or refute.
- **`Entity_UpdateBehavior`**'s ~600 lines of per-type/per-state gameplay logic — the single
  highest-value remaining target; this is literally "how the game plays."
- **`Entity_RunScript`'s opcode jump table** (`1000:2383`, 256 entries) — decoding this reveals
  the entity scripting language.
- Name `Gfx_DrawObject`'s render pass caller context more precisely (`FUN_1000_73a5` itself).
- `FUN_1000_02e2` (animated-tile callback), `FUN_1000_c2f3` (event-queue callback).
- The world/sub-level struct passed around as `[8b89]`/`[8b8b]` — worth formalizing as a Ghidra
  struct once its full field layout is known.
- Resolving the entity record layout fully — confirmed so far: `+2`=type/shape-class,
  `+4`=kind, `+6`/`+8`=X/Y, `+0xc`=script pointer, `+0x40`=state (`0x19`="dead/remove"). Many
  other offsets appear in `Entity_UpdateBehavior` but aren't named yet.
