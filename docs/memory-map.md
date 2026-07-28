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

## Sprite rendering (found via `MOV DX,0x3ce`/`0x3c4` port sweeps)

**No palette-setting code exists anywhere in the binary.** Exhaustive instruction search for
`OUT 3C0h/3C8h/3C9h` and `INT 10h AH=10h` returned zero matches (the only palette-adjacent call
at all is `Video_SetModeCga`'s single `INT 10h AH=0Bh` CGA palette-select). The EGA/VGA path
relies entirely on the BIOS-default 16-colour EGA palette. **`tools/ega.js` can hardcode the
standard EGA palette — there is nothing to extract.**

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
(clipped, via a family of edge-clip-case helpers `FUN_1000_843a`/`81ad`/`832c`/`8568`/`7db4`/
`7dcd`/`7e81`/`7e9b` — each very likely a clip-case-specialized sibling of
`Gfx_BlitSpriteMasked`/`Alt`), a probable text/font-string renderer (case `0x0a`, loops a
NUL-terminated string), or a sign-magnitude-transformed bitmap variant (the numeric default
case). See its plate comment in Ghidra for the full per-case breakdown and the object-record
field offsets identified so far (`+2`=type/shape-class, `+4`=sub-type, `+6`/`+8`=X/Y, `+0xa`,
`+0x10`, `+0x12`, `+0x14`, `+0x16`=shape-type). **Next highest-value naming target**: the
edge-clip-case helper family above — each is presumably `Gfx_BlitSpriteMasked` specialized for
one of {fully off-left, straddling-left, on-screen, straddling-right, fully off-right}.

## Open questions for Phase 2

- Resolve the `DAT_1000_b152` near-pointer values to actual filename strings for all 4
  worlds' load lists.
- Identify the sprite blit routine (reachable from video init call graph).
- Identify the palette-set routine (INT 10h AH=10h or direct attribute-controller writes).
- Confirm whether `CODE_12` (`6d83`) is genuinely stack, or a second small load buffer, once
  the stack-frame fix (Phase 1) is in place.
