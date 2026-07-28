# GAMEU.EXE memory map

Program: `GAMEU.EXE` (UNP-unpacked form of the shipped `GAME.EXE`).
Language: `x86:LE:16:Real Mode`. Image base `1000:0000`. 440 functions (Ghidra count).

MZ header (of `GAMEU.EXE` itself): `e_ss=0x6db2 e_sp=0x0010 e_cs=0x0010 e_ip=0x0000`
(all relative to the relocated load segment). `entry` (`1000:0010`) computes the real SS
value at runtime and stashes it at `DAT_1000_b39f = 0x7db2`.

## Segments

| Block | Range | Role |
|---|---|---|
| `CODE_0` | `1000:0000–ffaf` | Main engine. ~410 of the 440 functions. |
| `CODE_1` | `1ffb:0000–0edf` | Secondary code. Contains the CGA/Tandy credits string (`1ffb:0c4c`) crediting Chris Wood — likely the CGA/Tandy video driver module. |
| `CODE_2` | `20e9:0000–95ff` | **No functions decompiled — runtime load buffer.** |
| `CODE_3` | `2a49:0000–95ff` | Runtime load buffer. Target of world-1 loader (`FUN_1000_b56b`). |
| `CODE_4` | `33a9:0000–50df` | Runtime load buffer. |
| `CODE_5` | `38b7:0000–2f1f` | Runtime load buffer. |
| `CODE_6` | `3ba9:0000–019f` | Runtime load buffer. |
| `CODE_7` | `3bc3:0000–78ff` | Runtime load buffer. Target of world-1 loader. |
| `CODE_8` | `4353:0000–c7ff` | Runtime load buffer. Target of world-1 loader. |
| `CODE_9` | `4fd3:0000–c7ff` | Runtime load buffer. |
| `CODE_10` | `5c53:0000–e0ff` | Runtime load buffer. Target of world-1 loader. |
| `CODE_11` | `6a63:0000–31ff` | Runtime load buffer. Target of world-1 loader. |
| `CODE_12` | `6d83:0000–05ff` | Small buffer — likely stack-adjacent scratch, NOT confirmed to be the real stack (see caveat below). |
| `CODE_13` | `6de3:0000–fce1` | Contains the resident data segment (filename tables, driver name, etc. — see below) *and* is a load-buffer target. |
| `DATA` | `6de3:fce2–7000:e2c1` | Globals, string tables, stack. |

**Caveat (Phase 1 task):** the decompiler currently renders many stack pushes in `entry` and
elsewhere as writes to fake globals named `DAT_6d83_05xx`. These values step by exactly 3
between consecutive call sites (the byte length of a near `CALL rel16`), which means they are
**return-address / stack-marker pushes**, not real globals in `CODE_12`. This needs a stack
frame / SS fix in Ghidra before the decompiled output can be trusted (see Phase 1 of the plan).

## Known resident globals (segment `6de3` unless noted)

| Address | Meaning |
|---|---|
| `6de3:8b89` | Current world/level-set selector (0=?, 1..4), read by `FUN_1000_b51e` |
| `6de3:8c11` | Loader state byte; `'1'` short-circuits reloading already-resident world-1 banks |
| `6de3:8c75` | Destination segment for the next `LoadPackedFile` call (set by caller before the call) |
| `6de3:8a5a` | Video driver selector byte: `'E'`=EGA/VGA16, `'C'`=mode 0Dh, `'T'`=Tandy, `'4'`/`'0'`=CGA, `'i'`=other |
| `6de3:8a54`/`89fc` | Video page A segment (`A000` EGA / `B800` Tandy/CGA) |
| `6de3:8a56`/`89fe` | Video page B segment (double buffer / page flip) |
| `1000:22d7` | Sentinel checked against `-1`/`0xff` in several places — looks like an "initialized" flag |
| `1000:b39f` | Stashed real SS (`0x7db2`) computed once in `entry` |

## File → segment load map (from `FUN_1000_b51e` / `FUN_1000_b56b` family)

World 1 (`FUN_1000_b56b`), when not already resident (`[8c11] != '1'`):
```
seg 2a49  <- FUN_1000_bbbd (world-1 primary bank)
seg 4353  <- FUN_1000_bbbd
seg 5c53  <- FUN_1000_bbbd
seg 20e9  <- FUN_1000_bbbd
seg 3bc3  <- FUN_1000_bbbd
seg 6a63  <- FUN_1000_bbbd
seg 6de3  <- FUN_1000_bbbd
```
Each preceded by setting `DAT_1000_b152` to a small near-pointer (`0xa778`, `0xac78`,
`0xa838`, `0xa7b8`, …) — almost certainly the **filename pointer** passed to the loader.
These near-pointers need to be resolved to actual string data (Phase 2 loader task) to build
the complete file → segment table for all 4 worlds.

World 2/3/4 (`World2_LoadBanks`/`World3_LoadBanks`/`World4_LoadBanks`) are structurally
identical to `World1_LoadBanks` — same 7 target segments, same callee sequence, gated on
`[8c11] != '2'/'3'/'4'` respectively — just with different `DAT_1000_b152` near-pointer
values per world. **These near-pointers cannot be resolved statically**: the addresses they
point at (e.g. `6de3:a778`, `6de3:acb8`, `6de3:a8f8`, ...) read as all-zero in the static file
image, because segment `6de3` gets overwritten by `Load_PackedFile` calls earlier in the very
same function — the filename table lives in dynamically-loaded content, not static resident
data. Resolving the actual filenames requires a dosbox-x breakpoint + memory dump at each call
site (see Verification section / task #6), not further static analysis.

## The RNC ProPack loader (`FUN_1000_bbbd`)

```
LoadPackedFile:
  in:  DX = near ptr to ASCIIZ filename (in DS, resident data segment)
       DI = destination offset
       CX = (unused directly; buffer sizing assumed by caller)
       word [6de3:8c75] = destination segment (set by caller before call)
  DOS AH=3Dh AL=0 (open, read-only) -> BX = handle
  DOS AH=3Fh (read all, count from caller context) into [8c75]:DI
  DOS AH=3Eh (close)
  if word [DI] == 0x524E ('RN'):
      construct pointer to header trailer (DI + [DI+6] byteswapped), preserve 16 bytes
      of following memory across the call
      far call FUN_1000_fcc4 (RNC depack, in place)
      restore the 16 preserved bytes
      CX = depacked size (from FUN_1000_fcc4 return in AX)
  returns CX = final size; AX=0 on success
  on any DOS error or CX mismatch: falls to FUN_1000_1987 (fatal exit path, prints error & exits via INT 21h AH=4Ch after INT 10h reset)
```

## RNC ProPack depacker (`FUN_1000_fcc4`)

Validates `*(u16*)0 == 0x4E52` ("RN") and `*(u16*)2 == 0x0143` (method 1, i.e. "RNC\x01").
Reads chunk count from header offset `0x11`. Performs the standard RNC method-1 in-place,
LZ77-with-huffman decompression using an 0x8000-byte trailing window shift. This matches the
publicly documented RNC ProPack format exactly (see `docs/formats/rnc.md`).

## Video mode set-up (`FUN_1000_133b`)

Dispatches on driver byte `[6de3:8a5a]`:

- `'E'` (EGA/VGA 16-colour, **the reference mode for extraction**): INT 10h AH=0Dh
  (256-colour-ready init helper?), sets CRTC (port `3D4h`) register `0x0D` = pointer, `0x0C`
  attribute-controller word from page-B segment nibble; sets page A = page B = `A000`/`A300`;
  key detail — CRTC **offset register `0x13` = `0x16`** (22 words = 44 bytes/scanline),
  giving a **352-pixel-wide virtual screen** for smooth pixel-level horizontal scrolling
  before page flip. Calls `FUN_1000_3bbf` (likely "wait vsync" or "set start address").
- `'i'` / `'C'`: mode `0Dh` via INT 10h AH=0
- `'T'` (Tandy): mode `09h`, pages at `B800`, sets port `3DFh` (Tandy/PCjr banking register)
  bit twiddled from `[0xf95b]`.
- `'4'`/`'0'` (CGA variants incl. the undocumented high-speed mode mentioned in the credits
  string at `1ffb:0c4c`): defaults to `'4'` if unrecognised.

## Palette setting — CORRECTED: a real palette setter exists on the `'C'` (VGA) driver path

**This overturns the earlier "no palette-setting code exists anywhere" finding below.** That
search only looked for raw `OUT 3C0h/3C8h/3C9h`; it missed `INT 10h AH=10h` BIOS palette calls
entirely. Found by pivoting to the `'C'` driver branch — the one this project's own shipped
`pockets.ini` actually selects (`Colour VGA` on line 2, parsed to the single char `'C'` by
`Config_ParseIniAndLoadSoundDriver`).

`Video_SetMode`'s `'C'` branch sets BIOS mode `0x0D` (`MOV AX,0xd; INT 10h`) — **still the
EGA-style 320x200 4-plane 16-colour mode, not chunky 256-colour mode `0x13`** (confirmed: no
`OUT 3C8h/3C9h` or mode-0x13 setup exists anywhere) — then falls into the *same* `A000/A300`
CRTC 352px-wide setup as `'E'`/`'i'`. So "Colour VGA" in this game's own vocabulary still means
16-colour planar, exactly as suspected. What's different is what happens *after* mode-set:

- **`Video_SelectAndLoadPalette`** (`1000:3bbf`) — picks one of **24 contiguous 32-byte (16-word)
  palette banks** in a table at `6de3:da96` (`bank[i] = da96 + i*32`) and copies it into a
  working buffer at `[8ae7]`. Bank 0 is the "current" slot (all-zero in the static image —
  populated at runtime from loaded level data). Banks 0–17 are a smooth **brightening fade-in
  ramp** from black to a bright target; bank 7 doubles as **world 1's fully-lit target palette**,
  banks `0x13`/`0x14`/`0x15` (19/20/21) are the equivalent targets for **worlds 2/3/4**. This is
  the mechanism behind `Fx_UpdateTransition`/`Fx_TransitionStep` (`[8ba2]` increments once per
  frame and walks straight through these bank indices) — confirming that function is a
  **palette-fade transition**, not a screen-wipe.
- **`Video_ApplyVgaPalette`** (`1000:170b`) — only reached when driver `[8a5a]=='C'`. For each of
  16 colours, reads one word from `[8ae7]` and splits it as: **R = high memory byte of the word,
  G = high nibble of the low byte, B = low 3 bits of the low byte**. Each component is scaled
  0–7(ish) → 6-bit VGA DAC value via `Video_ScaleColorComponent` (`f(0)=0`, else `(n*63)/7+6`
  clipped to 63), packed into a 48-byte RGB-per-colour buffer, then:
  - `INT 10h AX=0x1002` (`AH=10h AL=02h`, "Set All Palette Registers + Overscan")
  - `INT 10h AX=0x1012` (`AH=10h AL=12h`, "Set Block of DAC Color Registers", **VGA-only** — this
    is the call that actually paints the custom colours)
  - `INT 10h AX=0x101b` (`AH=10h AL=1Bh`, "Sum to Gray Scale"), gated once
- **`Video_ApplyPaletteNonVga`** (`1000:17ae`) — the `'E'`/`'i'`/`'T'` counterpart. Its per-component
  step (`Video_ScaleColorComponentStub`) is an **empty `RET` stub** — i.e. the non-VGA driver
  paths genuinely do nothing and rely on the BIOS-default EGA palette. That half of the original
  finding was correct; only the VGA/`'C'` half was wrong.

**Extracted world palettes (6-bit DAC values scaled to 8-bit, R,G,B order), decoded directly
from the binary — no guessing involved:**

World 1 (bank 7, `6de3:db76`): `(0,0,0) (61,61,134) (134,97,170) (134,134,243)
(170,170,255) (255,255,255) (255,206,170) (255,170,134) (243,134,97) (170,97,0) (134,0,0)
(0,134,97) (0,170,134) (170,243,170) (255,255,134) (0,0,0)`

Worlds 2/3/4 (banks `0x13`/`0x14`/`0x15`) are near-identical variants of the same 16-colour
scheme with minor differences. See `symbols/gameu.json` / a future `docs/formats/palette.md` for
the full 24-bank dump if that thread gets picked back up — **not yet done**: re-deriving
`tools/ega.js`'s palette from this real data (it currently still hardcodes a generic default EGA
palette, and the empirically-guessed `PLANE_TO_INDEX_BIT` mapping in `docs/formats/pak.md` /
`pip.md` was tuned against that *wrong* reference palette, so it needs to be re-validated against
these real, per-world colours).

## Sprite rendering (found via `MOV DX,0x3ce`/`0x3c4` port sweeps)

**Original finding (still correct for the non-VGA driver paths, corrected above for `'C'`):**
exhaustive instruction search for `OUT 3C0h/3C8h/3C9h` and `INT 10h AH=10h` initially returned
zero matches because that search didn't consider `INT 10h AH=10h` sub-function calls where the
mode number is loaded into `AX` right before the `INT` instruction rather than appearing as a
separate `MOV AH,0x10`.

`Gfx_BlitSpriteMasked` (`1000:7ea0`) is the confirmed sprite blitter: the classic EGA masked
blit (AND an inverted silhouette mask into all 4 bitplanes at once via `Gfx_AndMaskRow`, then OR
each of the 4 colour planes in separately via `Gfx_OrPlaneRow`, cycling the Sequencer Map Mask
register 3C4h between planes). `Gfx_BlitSpriteMaskedAlt` (`1000:7ff2`) is the same algorithm
with inline sub-byte pixel-shift support (for X positions not on an 8-pixel boundary). Both
step **-44 bytes/row**, confirming the 352px virtual-screen width from `Video_SetMode`'s CRTC
setup — two independent findings agreeing exactly.

`Gfx_DrawObject` (`1000:7419`), called from `FUN_1000_73a5` (one of `entry`'s main-loop calls,
confirming it's the per-frame render path), is the top-level per-object draw dispatcher. It
switches on a "shape type" byte at object-record offset `+0x16` to one of: masked-bitmap draw
(clipped, via a family of edge-clip-case helpers — see below), a probable text/font-string
renderer (case `0x0a`, loops a NUL-terminated string), or a sign-magnitude-transformed bitmap
variant (the numeric default case, callers `FUN_1000_7db4`/`7dcd`/`7e81`/`7e9b`/`8568` — not yet
named, likely another clip-case family for that different bitmap encoding). See its plate
comment in Ghidra for the full per-case breakdown and the object-record field offsets identified
so far (`+2`=type/shape-class, `+4`=sub-type, `+6`/`+8`=X/Y, `+0xa`, `+0x10`, `+0x12`, `+0x14`,
`+0x16`=shape-type).

**Edge-clip-case blitter family** (all confirmed: identical GC/SEQ register-programming
template to `Gfx_BlitSpriteMasked`, just different row widths / start offsets):

| Function | Row width | Notes |
|---|---|---|
| `Gfx_BlitSpriteMasked` | 2 words (32px) | Base case, byte-aligned or via `Gfx_AndMaskRow`/`Gfx_OrPlaneRow` |
| `Gfx_BlitSpriteMaskedAlt` | 2 words (32px) | Same, with inline sub-pixel shift |
| `Gfx_BlitSpriteMaskedWide` | 3 words (48px) | Wider sprite class, inline sub-pixel shift |
| `Gfx_BlitSpriteMaskedWideB` | 3 words (48px) | Wider class, via `Gfx_AndMaskRowWide`/`Gfx_OrPlaneRowWide` (handle shift internally); called for right-edge X positions in `Gfx_DrawObject` |
| `Gfx_BlitSpriteMaskedLeftClip` | 3 words (48px), first word skipped | Via `Gfx_AndMaskRowLeftClip`/`Gfx_OrPlaneRowLeftClip`; called for left-edge-straddling X positions |

Exact disambiguation of `Gfx_BlitSpriteMaskedWide` vs `WideB`'s distinct roles (both cover the
same row width) is still open — worth revisiting once dosbox-x tracing is underway. Right-edge
clip is confirmed via `Gfx_DrawObject`'s call-site X-range guard (`WideB` used when X `>= 0x140`).

**The other bitmap encoding** — `Gfx_DrawObject`'s numeric-default case (reached when the
shape-type byte doesn't match `0x0a/0x0b/0x0d/0x0e/0x0f`) decodes a *string* of small
glyph-index bytes via a sign-magnitude transform (`b=(*src)-1; if(b<0) b=0xfe-b`), then draws
each glyph cell through one of four helpers — confirmed by structure, **hypothesized** to be a
HUD/score/text-digit renderer (not yet proven):

| Function | Role |
|---|---|
| `Gfx_CopyGlyphCell` (`7db4`) | Straight `CX`-row × 4-byte copy, `+44`/row. No EGA port access at all — first function in this whole cluster that doesn't touch GC/SEQ registers. |
| `Gfx_CopyGlyphCellNarrow` (`7e81`) / `...Alias` (`7e9b`, a pure tail-call of the former) | Same, 2 bytes/row — presumably an edge-clipped narrower cell. |
| `Gfx_CopyGlyphString` (`7dcd`) | Self-loops over *multiple* glyphs per call (16 fixed rows × 4 bytes per glyph, then decodes the next glyph inline via the same sign-magnitude transform, decrementing `DAT_6de3_8b9c` — initialised to 10 by `Gfx_DrawObject`, a plausible "characters remaining" count). The fully-on-screen fast path. |
| `Gfx_NoOpStub` (`8568`) | Confirmed empty function (immediate RET) — one clip case is a deliberate no-op. |

None of these four touch EGA ports directly, unlike every function in the masked-sprite family
— they must rely on Map Mask/Write Mode already set appropriately by the caller. **Confirming
the "text renderer" hypothesis needs either a dosbox-x trace during a HUD update, or locating
the actual font/digit source data these routines read from** — next step if this thread is
picked back up.

## Segment aliasing gotcha

Far calls sometimes show as e.g. `CALLF 0x2000:0be9` in disassembly even though segment `2000`
isn't one of ours — in real mode `segment:offset` pairs alias, and `0x2000:0be9` is the exact
same physical address as `0x1ffb:0c39` (both = linear `0x20be9`). Always compute the linear
address before concluding a far call targets unmapped memory (this tripped up an earlier pass
on `Video_SetModeCga`, now corrected).

## `Sys_DetectCpuSpeed` (`1ffb:0b79`)

The first function `entry` calls, before anything else (appears as `CALLF 0x2000:0b29` in
disassembly — same aliasing trick, resolves to `1ffb:0b79`). Polls port `3DAh` (CGA/EGA Input
Status Register 1, bit 3 = vertical retrace) counting reads across a full
vsync-inactive→active→inactive cycle, comparing the two inactive-phase counts to classify the
machine fast/slow. Almost certainly what selects the "undocumented CGA mode... for very slow
CGA machines" path referenced in the `1ffb:0c4c` credits string.

Exhaustive interrupt search (every `INT` instruction in the whole 18425-instruction program) —
confirmed only `INT 10h` and `INT 21h` exist anywhere. No `INT 9h`/`16h`/`8h`/`15h`, no port
`0x60` reads. Keyboard handling is not BIOS-mediated at all.

## `pockets.ini` parsing and sound-driver loading (`Config_ParseIniAndLoadSoundDriver`, `1000:1af6`)

The 4th function `entry` calls. Opens and parses `pockets.ini` line-by-line (via the
`Config_SkipLine` helper), and this answers several previously-open questions at once:

- **Line 1** → single char → `[6de3:8cab]`, the **sound driver selector** (`'A'`=Adlib,
  `'R'`=Roland, `'S'`=SoundBlaster-compatible, `'B'`=Beeper, `'T'`=Tandy — matches the
  `data\*.pin` filename table exactly).
- **Line 2** → single char → **`[6de3:8a5a]`, the video driver selector `Video_SetMode` reads**
  (`'M'` in the ini forces it to `'C'`; otherwise the char is stored as-is). This is where
  `Video_SetMode`'s dispatch byte actually comes from.
- **Line 3** → single char → `[8c92]` = 3 if `'J'` else 2 — almost certainly joystick-vs-keyboard
  input mode (matches `pockets.ini`'s "Keyboard"/"Joystick" line).
- **Lines 4–8** → exactly 5 key-binding entries, each a 5-ASCII-digit DOS key-code
  (`scancode<<8 | ASCII`, e.g. `"18432"` = `0x4800` = extended Up-Arrow). Builds a **512-byte
  lookup table at `1000:1e27`** (plus a bitwise-complement companion at `+0x100`):
  `table[keycode] = action ID` (0=up/1=down/2=left/3=right/4=fire, in file order). **This is the
  keyboard input configuration** — but the code that actually *consults* this table (the
  key-polling loop or ISR) has still not been located.

After parsing, it loads the sound-driver `.pin` file(s) into segment `38b7`/`33a9` via
`Load_PackedFile`, and for Adlib/Roland/SoundBlaster (and the unrecognised-driver fallback)
**invokes the just-loaded driver code via a computed far call** (`CALLF [0x2029]` /
`CALLF [0x202d]`) — confirming `.pin` files are loadable driver *modules* (a small plugin-style
sound-driver architecture), not just data blobs.

## Input subsystem — FOUND, complete (`Input_KeyboardIsr`, `Input_ReadKeyboardState`, `Input_ReadState`)

The keyboard handler resisted every port/interrupt search because **Ghidra's auto-analysis
never created a function boundary for it** — it sat as unanalyzed bytes in a 155-byte gap
between `Sys_RestoreState` and `Config_ParseIniAndLoadSoundDriver` (found via
`find_code_gaps`), reachable only through a raw IVT write (segment `0000` offset `0x24`) rather
than a traceable `DOS AH=25h` "set vector" call. Manually defined as a function at `1000:1a5b`
and named `Input_KeyboardIsr`.

**`Input_KeyboardIsr`** (INT 9h handler, confirmed textbook ISR shape — `CLI`, register saves,
body, register restores, `STI`, `IRET`):
- Reads the scancode directly: `IN AL, 0x60`.
- Tracks Ctrl-held state (`6de3:8c88`) and latches Ctrl+C / Ctrl+Q into `6de3:8c89`.
- Writes the raw scancode (or 0 for break codes) to `6de3:8c87` **and `6de3:8b60`** — this is
  the exact byte `App_ExitOrReset` polls for `0x1E`/`0x13` (scancodes for **'A'**/**'R'** —
  now confirmed to be an Abort/Resume-or-Restart menu prompt, not an arbitrary pair of codes).
- Looks up the scancode in the **same 512-word table** `Config_ParseIniAndLoadSoundDriver`
  built at `1000:1e27` from `pockets.ini`'s key bindings. A nonzero entry means this scancode is
  a bound game action: clears `8c87`/`8b60` (so bound keys don't also read as menu keys), then
  ORs the action bit into `6de3:8c94` (edge accumulator) and `6de3:8c85` (held-state bitmask) on
  make, or ANDs it out of `8c85` on break.
- Standard keyboard-controller ack (port `0x61` bit-7 toggle) and 8259 PIC EOI (`OUT 0x20,0x20`).

**`Input_ReadKeyboardState`** (`1000:190d`) — combines `8c94` (cleared after reading — an
accumulator of events since the last poll) with `8c85` (persistent held-state, not cleared) via
OR, applies an opposite-direction debounce (mask `0xa0a`: clears bit *i* whenever its pair bit
is also set, preventing e.g. simultaneous up+down), and stores the result to `8c91`/`8c90`.

**`Input_ReadState`** (`1000:18a4`) — the unified per-frame input reader. Always calls
`Input_ReadKeyboardState` first (its return value also happens to trigger the joystick's RC
timer via `OUT 0x201`), then calibrates the joystick axes via `Input_PollJoystickPort` (reads
port `0x201` + vsync status `3DAh`, the same speed-independent-timing trick as
`Sys_DetectCpuSpeed`). If `6de3:8c92 & 1 == 0` (**keyboard mode** — recall
`Config_ParseIniAndLoadSoundDriver` sets `8c92`=2 for keyboard, 3 for joystick), the
joystick-derived byte is discarded in favour of `8c91`. Final byte → `1000:8b5d` and
`6de3:8c8f`.

## Open questions for Phase 2

- Resolve the `DAT_1000_b152` near-pointer values to actual filename strings for all 4
  worlds' load lists.
- ~~Identify the sprite blit routine~~ — done, see "Sprite rendering" above.
- ~~Identify the palette-set routine~~ — done: none exists, see "Sprite rendering" above.
- ~~Confirm whether `CODE_12` (`6d83`) is genuinely stack~~ — confirmed yes, `entry` sets
  `SS:SP=6d83:05fe` explicitly at `1000:0026`.
- ~~Locate the keyboard polling/ISR code~~ — done, see "Input subsystem" above:
  `Input_KeyboardIsr` was sitting in an un-auto-analyzed gap, installed via a raw IVT write
  (not yet located — the actual `MOV word ptr [0x24],...` install site is a minor remaining
  item, low value now that the ISR itself is fully understood).
- ~~Name the `Gfx_DrawObject` edge-clip-case helper family for the *other* bitmap encoding~~ —
  done, see "The other bitmap encoding" above. Still open: confirm the "HUD/text renderer"
  hypothesis and locate the font/digit source data.
- Name the remaining `Gfx_DrawObject` clip-case CGA/Tandy fallbacks (`FUN_1000_95c5`/`976f`/
  `9f02`/`a0fc`/`9929`/`9a4c`) — low priority, EGA/VGA is the extraction reference mode.
- Understand `Gfx_DrawObject`'s `0x0a` case (probable font/text-string renderer, calls
  `FUN_1000_b42e` per glyph) and its `0x0b` case's secondary `[0x8c34]` dispatch.
- Confirm the exact meaning of `[8c92]` (2 vs 3, keyboard vs joystick) and where it's consumed.
