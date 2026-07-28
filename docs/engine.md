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
| 1 | `Camera_UpdateScroll` | guess | Reads a scroll-target struct, negates X/Y, splits into whole-tile (÷32/÷16) + sub-tile pixel remainder. Sub-tile X remainder → `[8b69]`, later fed to the EGA pixel-panning register by `Video_FlipAndScroll`. |
| 2 | `Level_UpdateAnimatedTiles` | guess | Skipped for world 4. Walks an 11×14 visible-tile grid (0x80-byte row stride) from the scroll-computed screen offset, calling `FUN_1000_02e2` for tiles with a flag bit set. |
| 3 | `FUN_1000_73a5` → `Gfx_DrawObject` | confirmed | The render pass — see `docs/memory-map.md` "Sprite rendering". |
| 4 | `Video_FlipAndScroll` | **confirmed** | Page-flip (A000/A300 alternation) + **EGA pixel-panning register write (Attribute Controller index `0x13`)** for hardware fine-scroll. Also services the loaded sound driver via a computed far call. This is the *other* AC-index write in the whole binary besides the CGA palette-select — not a palette write, refining the "no palette setter" finding. |
| 5 | `Fx_UpdateTransition` | guess | Dispatches on `[8ba2]` ("transition/effect ID"); likely a screen wipe/fade between levels. |
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

## Open threads for a future session

- Name `Gfx_DrawObject`'s render pass caller context more precisely (`FUN_1000_73a5` itself).
- `FUN_1000_22da`/`FUN_1000_ca6d`/`FUN_1000_c961` — the actual per-entity physics/AI/removal
  logic called by `Entity_UpdateAll`. This is where gameplay rules live.
- `FUN_1000_02e2` (animated-tile callback), `FUN_1000_c2f3` (event-queue callback).
- The world/sub-level struct passed around as `[8b89]`/`[8b8b]` — worth formalizing as a Ghidra
  struct once its full field layout is known.
- Resolving the entity record layout fully (only `+0x40` is confirmed; `Gfx_DrawObject`'s
  comment lists several other offsets seen but not yet named).
