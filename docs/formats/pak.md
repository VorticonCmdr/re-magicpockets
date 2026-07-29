# `.pak` sprite/tile bank format

**Three distinct on-disk layouts share this one extension** — do not assume the 640-byte/32x32
format below applies to a `.pak` file just because its size divides evenly by 640; both
`blocks*.pak` (256B/32x32, unmasked, see its own RESOLVED section) and `extras.pak`/
`extrax1-4.pak` (160B/16x16, masked, see its own RESOLVED section) also divide evenly by 640 by
coincidence, and decode to pure noise if forced through the 640-byte path. Always verify by
rendering, not by byte-math alone.

The 640-byte/32x32 masked-sprite format itself was confirmed empirically (not just inferred from
the blit code) by decoding the first two tiles of `special1.pak` and visually inspecting the
mask-plane bits as ASCII art — both produced coherent, symmetric rounded-block silhouettes. See
`tools/extract-pak.js` / `tools/ega.js` for the implementation.

## Layout (640-byte masked 32x32 sprite banks: `special`/`kidx`/`nasty`/`bitkid`/`ape`)

**No header at all.** A `.pak` file (once RNC-depacked — see `docs/formats/rnc.md`) is a flat
array of fixed-size tile records:

```
tileCount = fileSize / 640
tile[i] starts at offset i * 640
```

Each **640-byte tile** is a 32×32-pixel masked EGA sprite, matching `Gfx_BlitSpriteMasked`'s
on-disk expectations exactly:

```
offset 0    : AND-mask bitplane   (32 rows x 4 bytes = 128 bytes)
offset 128  : color bitplane 0    (128 bytes)
offset 256  : color bitplane 1    (128 bytes)
offset 384  : color bitplane 2    (128 bytes)
offset 512  : color bitplane 3    (128 bytes)
```

Within each plane: 32 rows of 4 bytes (32 bits = 32 pixels), MSB-first (bit 7 of the first
byte = leftmost pixel), **no row padding** — this is the source-side stride
`Gfx_AndMaskRow`/`Gfx_OrPlaneRow` read (distinct from the *destination* side, which strides by
44 bytes to match the video buffer's 352px virtual width).

**Mask semantics**: bit = 1 → transparent (background shows through, matches the AND-clears-
nothing-here-so-original-stays behaviour); bit = 0 → opaque sprite pixel (mask AND clears the
destination to 0, ready for the OR-color passes).

**Color-plane read order**: confirmed from disassembly — `Gfx_BlitSpriteMasked` cycles the
Sequencer Map Mask register through `0x01,0x02,0x04,0x08` in that exact sequence, reading/
writing the 4 color planes 0..3 in the same temporal order, **matching the on-disk chunk order
exactly (chunk 1 = plane 0, chunk 2 = plane 1, etc, no reordering)**. The plane→index-bit
assembly is the **identity mapping** (`PLANE_TO_INDEX_BIT = [0,1,2,3]` in `tools/ega.js`) —
confirmed both by this disassembly trace and empirically, by `kidx1.pak`/`nasty1.pak` rendering
as clean sprite art once the real per-world palette was used (see "RESOLVED" section below; an
earlier `[1,0,3,2]` guess had been tuned against a wrong hardcoded default-EGA palette and was
never actually correct). The game **does** set a real custom palette per world — see
`docs/memory-map.md`'s "Palette setting" section and `tools/palette.js` — the index resolves
through that, not a fixed default.

## Tile counts per file (all confirmed exact — no remainder)

| Unpacked size | Tile format | Tile count | Files |
|---|---|---|---|
| 12800 | 640B masked 32x32 | 20 | `special1-4.pak`, `kidx1-4.pak` |
| 12800 | 160B masked 16x16 | 80 | `extrax1-4.pak` (same byte size as the row above — coincidental, see "RESOLVED" section below) |
| 30720 | 256B unmasked 32x16 | 120 | `blocks1-4.pak` (see "RESOLVED" section below — a completely different format from the other `.pak` files, despite the shared extension) |
| 38400 | 640B masked 32x32 | 60 | `nasty1-4.pak`, `bitkid.pak`, `ape.pak` |
| 38400 | 160B masked 16x16 | 240 | `extras.pak` (same byte size as the row above — coincidental, see "RESOLVED" section below) |

## Verification

`node tools/extract-pak.js build/raw/<file>.pak.raw --palette worldN` produces a PNG sprite
sheet. Every file extracts cleanly (exact division by its tile size, no leftover bytes) and, with
the real per-world palette and identity plane mapping, `kidx1-4.pak`/`nasty1-4.pak`/
`special1-4.pak`/`bitkid.pak`/`ape.pak` render as clean, coherent sprite art — character/enemy
sprites with multiple readable animation frames, correct colors, no artifacts. `extras.pak`/
`extrax1-4.pak` render just as cleanly once decoded at their real 16x16 size (see "RESOLVED —
`extras.pak`/`extrax1-4.pak` are 16x16, not 32x32" below) — a full HUD icon sheet and per-world
bonus-item icons respectively, not noise.

**`blocks1-4.pak`** uses a different, unmasked, direct 4-plane 32x16 tile format — see the
"RESOLVED" section on it below; this is not a `Gfx_BlitSpriteMasked` consumer at all.

## RESOLVED — identity plane mapping confirmed by disassembly AND clean renders; `blocks*.pak` is a separate, still-open format question

Traced directly from `Gfx_BlitSpriteMasked`'s disassembly (`1000:7ea0`), not guessed: the four
color-plane chunks in a tile record are consumed under Sequencer Map Mask `0x01, 0x02, 0x04,
0x08` **in that literal file order** — chunk 1 (bytes 128-255) is hardware plane 0, chunk 2
is plane 1, chunk 3 is plane 2, chunk 4 is plane 3. No reordering anywhere. Combined with the
real per-world palette (`tools/palette.js`, see `docs/memory-map.md`), this means the
plane→index-bit assembly is the **identity mapping** — the same one confirmed for `.pip` (see
`docs/formats/pip.md`). `Gfx_AndMaskRow`/`Gfx_OrPlaneRow`'s byte-aligned path also confirms
straightforward, non-swapped, 4-bytes/row source reads (2x `LODSW`, each byte written to the
matching destination byte in order) — ruling out a `.pip`-style byte-order bug too.

**Proof this is right**: re-rendering `kidx1.pak` and `nasty1.pak` (character/enemy sprite
banks, same 640-byte masked-tile format) with the real world-1 palette and identity mapping now
produces clean, fully coherent sprite art — multiple readable animation frames, correct colors,
no artifacts. `tools/ega.js`'s `PLANE_TO_INDEX_BIT` is now `[0,1,2,3]` (identity) and the whole
plane-mapping question from earlier in this project is closed.

**`blocks1-4.pak` (level background/terrain tiles) still renders as pure noise** through this
exact same, now-confirmed-correct pipeline. Since `kidx`/`nasty` (same code path, same 640-byte
tile format) work perfectly, the `.pak` decode itself is not the bug — `blocks*.pak` is simply
**not consumed by `Gfx_BlitSpriteMasked`/this 640-byte tile format at all**, despite its file
size dividing evenly by 640 (30720/640=48, purely coincidental — it also divides evenly by other
plausible tile sizes). The mask-plane ASCII-art check that "confirmed" this format back at the
start of the project was only ever run against `special1.pak`, never against `blocks1.pak` --
so `blocks*.pak`'s layout was never actually independently verified, only assumed by analogy.

Searched for the real `blocks*.pak` consumer, exhaustively this time — every reader of both the
raw buffer address (`6de3:4200`) and the scroll-computed read pointer (`[8c13]`) was traced:

- `Level_RewriteAnimatedTileIndex` (`Level_UpdateAnimatedTiles`'s callback) — rewrites a
  tile-index byte for animation, does not draw pixels.
- `Gfx_DrawObject`'s HUD-text default case reads `[8c13]` too — but it turns out `[8c13]` is a
  **reused scratch global**, not a stable "level-map pointer": `Camera_UpdateScroll` writes it
  for scroll purposes early in the frame, but by the time this HUD case runs later in the same
  frame it's been repurposed as a glyph-string source pointer. Its CGA/Tandy fallbacks
  (`Gfx_DrawObjectHudCaseCgaA`/`B`) do the same thing.
- `Gfx_BlitSpriteMasked`'s **only caller in the whole binary is `Gfx_DrawObject`**, which is
  entity-list-driven (walks a linked list at `0x9090`-`0x91a8` via `FUN_1000_73a5`) — there is no
  separate tile-grid-walking blit loop anywhere.
- Every `World*_LoadBanks` post-load helper was checked too: `World_LoadAltBuildBank(Variant/Alt)`
  and `AltBuild_ConvertTileBank(Wide)` are alt-build-only CGA/Tandy tile-format conversion
  routines (no-ops on the main VGA path); `World_ResetGraphicsAfterLoad`/
  `World_InitDefaultByteTable`/`World_FlashScreenAfterLoad` are simple GC-register resets/table
  inits — none touch tile or map data.

**No dedicated background-tile-blit function exists anywhere in the traced call graph.** Working
hypothesis for a future session: background/level geometry may be built from **placed ENTITY
RECORDS** at load time (each referencing a specific `.pak` tile via its shape-type fields,
rendered through the exact same `Gfx_DrawObject`/`Gfx_BlitSpriteMasked` pipeline as sprites)
rather than raster-blitted from the `.pap` tile-index grid directly. This would neatly explain
why there's no separate blitter to find. Unconfirmed — needs a dosbox-x trace of what populates
the entity list at level load, and/or resolving `DAT_1000_b152`'s near-pointer filename table to
identify exactly which loaded file `blocks*.pak`'s data lands in and who actually reads it.

**Supporting structural evidence found while naming `Entity_UpdateBehavior`'s callee graph**:
`Entity_RebuildVisibleList` (`1000:c998`) walks the raw ~140-slot entity-pointer array at
`0x9090` (the same array `Entity_FreeSlot` manages) every frame, applies the current
camera-scroll delta to each entity's X/Y, and **culls entities to the screen-relative viewport**
(X in `[-0x3f,0x17f]`, Y in `[-0x3f,0xdf]`) by flipping a sign-bit marker — building the working
list at `0x91be` that `Entity_UpdateAll` walks and (via `FUN_1000_73a5`) that `Gfx_DrawObject`
actually renders. This is exactly the mechanism placed background-tile entities would need: if
`blocks*.pak` tiles are loaded as entity records at level-load time, this function is where
they'd get camera-relative-transformed and culled into the render list alongside gameplay
entities, using the identical pipeline. Still not proof (no dosbox-x trace has confirmed
`blocks*.pak` data actually lands in the `0x9090` array), but it closes the "how would a
tile-as-entity even get drawn" mechanical gap the hypothesis previously left open.

## RESOLVED (mostly) — the real `blocks*.pak` consumer found: `World_ResetGraphicsAfterLoad`

Found by tracing `World_ResetGraphicsAfterLoad` one level deeper than the earlier "exhaustive"
pass did — that pass characterized it from its name/shallow summary alone ("simple GC-register
resets") and never decompiled into what it actually calls.

**The real chain, confirmed byte-for-byte in all four `World*_LoadBanks` functions** (identical
in each): `blocksN.pak` loads into segment `0x3bc3` at offset 0 with `CX=0x7800` (30720, its
exact known unpacked size — confirmed by reading the ASCIIZ filename directly out of memory at
the near-pointer used for the `Load_PackedFile` call: `data\blocksN.pak`), then **immediately and
unconditionally** falls into `World_ResetGraphicsAfterLoad` → `Gfx_CopyTileBankPlanes`. This is a
completely different code path from `Gfx_BlitSpriteMasked` (whose only caller is `Gfx_DrawObject`,
confirmed unchanged) — `blocks*.pak` was never 640-byte masked sprite tiles to begin with.

`Gfx_CopyTileBankPlanes` (`1000:85d0`) dispatches on `DAT_1000_22d7` exactly like every other
hardware-mode switch in this codebase:
- `DAT_1000_22d7 == -1` → `AltBuild_ConvertTileBankRleVariant` (CGA path)
- `DAT_1000_22d7 == 0xff` → `AltBuild_ConvertTileBankRle` (Tandy path)
- otherwise → the **direct EGA/VGA plane copy** via 4x `Gfx_CopyPlaneRow32Words`, cycling
  Sequencer Map Mask `0x1,0x2,0x4,0x8` — i.e. writing 4 separate bitplanes, no AND-mask plane at
  all. This is structurally much closer to `.pip`'s direct-picture format than to the masked-sprite
  `.pak` format.

**Confirmed which branch the real 'C'/'E' (Colour VGA / EGA) driver path takes**: `Video_SetMode`
only ever writes `DAT_1000_22d7` on the `'T'` (Tandy, sets `0xff`) branch; `Video_SetModeCga`
presumably sets it to `-1` for `'4'`/`'0'`. Neither the `'E'` nor `'C'` branch writes it at all, so
on the actual VGA path this global keeps its zero-initialized default — meaning **the reference
build takes the direct 4-plane-copy branch**, not one of the AltBuild RLE converters. This also
means the RLE scheme documented above (`AltBuild_ConvertTileBankRle`/`RleVariant`) is
`blocks*.pak`'s CGA/Tandy-specific decode path specifically — not some unrelated curiosity.

## RESOLVED — `blocks*.pak` is 120 individually-packed 32x16 tiles, not one big raster image

The remaining ambiguity above (what does `CX` actually equal, and how can 256 bytes/"row" times
120 "rows" possibly fit a 30720-byte file) was resolved by re-disassembling
`World_ResetGraphicsAfterLoad` (`1000:b6d7`) directly instead of re-deriving `CX` through the
loader chain:

```
1000:b6d7: MOV AX,0xa800  ; ES = a800 (destination: a separate VGA-plane page, not a000)
1000:b6de: MOV AX,0x3bc3  ; DS = 3bc3 (source: the just-loaded blocksN.pak buffer)
1000:b6e3: XOR DI,DI      ; DI = 0
1000:b6e5: XOR SI,SI      ; SI = 0
1000:b6e7: MOV CX,0x78    ; CX = 0x78 = 120  <-- the value that couldn't be pinned down before
1000:b6ea: CALL Gfx_CopyTileBankPlanes
```

`CX = 0x78 = 120` confirmed directly, no guessing needed. The earlier "120 rows of 512px is
dimensionally impossible" confusion came from assuming each of the 120 loop iterations was one
*pixel scanline* of one giant image. It is not — **each iteration is one entire 32x16 tile**.

Re-deriving the byte math on that basis: a 32x16 tile's single bitplane is `32/8 = 4` bytes/row ×
16 rows = **64 bytes** — exactly the `REP MOVSW` count (`0x20` words) seen in
`Gfx_CopyPlaneRow32Words`. The `ADD SI,0xC0` (192 bytes) that runs after each 64-byte plane-chunk
copy is the source skipping over that *same tile's other 3 planes* (192 = 3 × 64) to reach the
next tile's chunk for the plane currently being copied. Across the 4 sequential
`Gfx_CopyPlaneRow32Words` calls (masks `0x1,0x2,0x4,0x8`), each net `SI` advances by only `+0x40`
(64) between calls — landing exactly on the next plane-chunk within tile 0's own 256-byte record.
So the on-disk layout per tile is:

```
tile[i] starts at offset i * 256   (i = 0..119)
  offset +0   : color bitplane 0   (16 rows x 4 bytes = 64 bytes)
  offset +64  : color bitplane 1   (64 bytes)
  offset +128 : color bitplane 2   (64 bytes)
  offset +192 : color bitplane 3   (64 bytes)
```

**No AND-mask plane at all** (4 planes, not 5) — background/terrain tiles are always fully
opaque, matching `Gfx_CopyTileBankPlanes`'s dispatch (it's a direct 4-plane copy, distinct from
`Gfx_BlitSpriteMasked`'s 5-plane masked format). `120 tiles x 256 bytes = 30720` — exactly the
unpacked file size, zero remainder, for all four `blocks1-4.pak`.

**This also lines up with the `.pap` format docs** (`docs/formats/pap.md`): tile size there is
documented as 32x16 (asymmetric), and observed tile-index byte values range ~1-120 — exactly
120 tiles, matching this format precisely. The `.pap` tile-index byte is simply a direct index
into a `blocksN.pak` file's 120-tile array.

**Visually confirmed** via `tools/extract-pak.js` (now format-detects `blocks*.pak` by filename
and uses `decodeDirectTile`/4-plane-no-mask instead of the 640-byte masked-sprite path): all four
`blocksN.pak` files render as clean, coherent 32x16 terrain-tile sheets — rock/stone tiles with
glowing crystal veins and mushrooms (world 1), jungle vine/leaf tiles (world 2), and world 4's
sheet even contains legible text tiles ("EXIT", "KEEP OUT" signage). No shearing, no noise, no
ambiguity left. The earlier 512x120-monolithic-image hypothesis was wrong — it happened to also
satisfy the byte-total math (256 bytes/"row" x 120 "rows" = 30720) but produced sheared,
TV-static-looking output because it concatenated scanlines from many unrelated tiles into fake
"rows"; the tile-array interpretation is the one that actually decodes cleanly.

No dosbox-x trace was needed in the end — the missing register values were sitting directly in
`World_ResetGraphicsAfterLoad`'s own disassembly, one function up from where the trace had
stopped.

## RESOLVED — `extras.pak`/`extrax1-4.pak` are 16x16 masked sprites, not 32x32

These five files were originally lumped into the same 640-byte/32x32 "sprite bank" bucket as
`kidx`/`nasty`/`special`/`bitkid`/`ape` purely because their unpacked sizes also divide evenly by
640 (`extrax1-4.pak`: 12800/640=20; `extras.pak`: 38400/640=60) — the exact same kind of
byte-math coincidence that misled the original `blocks*.pak` hypothesis. Decoding them at 32x32
produces mostly pure noise (confirmed genuinely random, not just "busy dithered art" — directly
compared against a known-good `kidx1.pak` character-face tile at the same zoom level, which
shows clean edges/regions; the `extrax1.pak` tiles at 32x32 showed zero coherent structure
anywhere), with only a handful of suspiciously-identical "clean" tiles per file (turned out to be
genuinely blank/unused reserved slots, not evidence the 32x32 reading was right).

**Root cause, found via the actual per-shape descriptor table, not more guessing.** Every sprite
draw ultimately goes through `Gfx_DrawObject` (`1000:7419`), which — for the "simple masked
bitmap" case — calls `Entity_LookupShapeDescriptor` (`1000:c16a`) with the entity's shape-class id in AX.
This function was previously tagged **"trivial passthrough (returns AX unchanged)"** — true, but
incomplete: that characterization only checked the AX return value and missed that **DI carries
the real result**:

```
1000:c16a: PUSH AX
1000:c16b: ADD AX,AX          ; shapeClassId * 2
1000:c16d: MOV DI,0xc39a      ; DS-relative (6de3:c39a) -- a table of pointers
1000:c170: ADD DI,AX
1000:c172: MOV DI,word ptr [DI]   ; DI = descriptor pointer for this shape class
1000:c174: POP AX
1000:c175: RET
```

`6de3:c39a` is a table of 96 pointers, each exactly `0x1c` (28) bytes apart, pointing into a flat
array of 96 fixed-size 28-byte shape-descriptor records starting at `6de3:b91a`. `Gfx_DrawObject`
reads six fields straight out of whichever descriptor DI points at: `+0xa` (frame count),
`+0xc` (frame-to-frame byte stride), `+0xe` (**bank id** — the very same bank id resolved to a
segment via the `6de3:f941` table documented above, e.g. bank 6 → segment `0x5c53`, where
`extras.pak`+`extraxN.pak` load), `+0x12`, `+0x14` (**sprite height, in rows**), and `+0x16`.

Reading all 96 descriptors and filtering to `bankId == 6` (i.e. every shape drawn from
`extras.pak`/`extrax*.pak`) gives an unambiguous, unanimous answer: **every single one of the ~44
matching descriptors has height field `+0x14 == 16`**, never 32. This is the real sprite height
for this bank — half of what every other sprite bank uses.

**Confirmed by rendering**: decoding at 16x16 (1 AND-mask + 4 OR-color planes, 2 bytes/row × 16
rows = 32 bytes/plane, 160 bytes/tile) produces completely clean art for all five files:
- `extras.pak` (240 tiles) is a full HUD/pickup icon sheet — score digits `100`–`1000`, the
  entire `A`–`Z` and `0`–`9` alphabet, food/drink icons (candy, ice cream, soda, a chocolate
  bar), hand gestures, sunglasses, a `GAS` sign.
- `extrax1-4.pak` (80 tiles each) are per-world bonus-item icon sets — a spinning
  dumbbell/weight animation, rotating gems, a power-up cross, a "1UP"-style heart icon,
  directional arrows, short text sprites. `extrax4.pak` (world 4, the ice/snow world) contains a
  legible "EXIT" sign tile, echoing the one already found in `blocks4.pak`.

`160B x 240 = 38400` and `160B x 80 = 12800` — exactly the unpacked sizes of `extras.pak` and
each `extraxN.pak`, zero remainder, for all five files.

**Also spot-checked `bitkid.pak`/`ape.pak`** (bundled in the same unverified blanket claim as
`extras.pak` previously) at the original 640B/32x32 format — both are genuinely clean at that
size (a "Bit Kid" running/animated player-character sheet and a gorilla enemy sheet
respectively), so the fix is scoped exactly to `extras.pak`/`extrax1-4.pak` and does not affect
`bitkid`/`ape`.

`tools/extract-pak.js` now format-detects `extras`/`extrax*` by filename (alongside the existing
`blocks*` detection) and decodes them at 16x16 via a new third code path.

## Open questions

- **RESOLVED (partially)**: sprite *placement/identity* metadata (per-shape frame count, height,
  bank/segment) **is** found — the 96-entry, 28-byte-record descriptor table at `6de3:b91a`
  (indexed via `Entity_LookupShapeDescriptor`'s table lookup, `6de3:c39a`), see the `extras.pak`
  resolution above. Still untraced: fields `+0x0`..`+0x8`, `+0x12`, `+0x16` (only `+0xa`
  frame-count, `+0xc` frame-stride, `+0xe` bank-id, and `+0x14` height are decoded/named so far),
  and which *entity records* (not shape-class ids) reference which specific tile index within a
  bank — that placement layer likely still lives in the `.pap` files or in per-level entity-spawn
  tables, not yet traced.
- **CORRECTION**: `Gfx_BlitSpriteMaskedWide`'s disassembly was checked directly — it is NOT a
  48-pixel-wide *source* format. It reads the same 2 words (4 bytes) per row per plane as the
  regular byte-aligned path; "Wide" refers to a 5-byte *destination* footprint from sub-pixel
  ROR-shift spill (the same mechanism as `Gfx_BlitSpriteMasked`'s CL!=0 branch), not a different
  on-disk tile geometry. **The hypothesized second/wider tile size was a red herring in the
  "wide" direction — the real second tile size found (`extras.pak`/`extrax*.pak`) is
  *narrower/shorter* (16x16), not wider**; see the dedicated RESOLVED section above.
- ~~`blocks1-4.pak`'s consumer/geometry~~ — **fully resolved**, see "`blocks*.pak` is 120
  individually-packed 32x16 tiles" above.
- `.pip` full-screen images do **not** use this same fixed-tile-array layout (unpacked sizes
  like 32066 don't divide evenly by 640 or by any obvious plane-count assumption) — still
  unresolved, see the note in `tools/extract-pak.js`'s history / next session's open items.
