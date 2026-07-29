# `.pak` sprite/tile bank format

Confirmed empirically (not just inferred from the blit code) by decoding the first two tiles
of `special1.pak` and visually inspecting the mask-plane bits as ASCII art — both produced
coherent, symmetric rounded-block silhouettes, and every shipped `.pak` file's unpacked size
divides evenly by the predicted tile size (640 bytes) with no remainder. See
`tools/extract-pak.js` / `tools/ega.js` for the implementation.

## Layout

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
| 12800 | 640B masked 32x32 | 20 | `special1-4.pak`, `kidx1-4.pak`, `extrax1-4.pak` |
| 30720 | 256B unmasked 32x16 | 120 | `blocks1-4.pak` (see "RESOLVED" section below — a completely different format from the other `.pak` files, despite the shared extension) |
| 38400 | 640B masked 32x32 | 60 | `nasty1-4.pak`, `bitkid.pak`, `ape.pak`, `extras.pak` |

## Verification

`node tools/extract-pak.js build/raw/<file>.pak.raw --palette worldN` produces a PNG sprite
sheet. Every file extracts cleanly (exact division by 640, no leftover bytes) and, with the real
per-world palette and identity plane mapping, `kidx1-4.pak`/`nasty1-4.pak`/`special1-4.pak`/
`extrax1-4.pak`/`bitkid.pak`/`ape.pak`/`extras.pak` render as clean, coherent sprite art —
character/enemy sprites with multiple readable animation frames, correct colors, no artifacts.

**`blocks1-4.pak` is the one exception** — it does not render correctly through this same,
now-confirmed pipeline. See the "RESOLVED" section below: this is a separate, still-open format
question (background tiles aren't consumed by `Gfx_BlitSpriteMasked` at all), not a regression
in the mapping/palette work.

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

## Open questions

- **Sprite *placement/identity* metadata** (which tile index means what, animation frame
  groupings, hotspots) lives elsewhere — likely in the `.pap` level-map files or in code tables,
  not in the `.pak` files themselves. Not yet traced.
- **CORRECTION**: `Gfx_BlitSpriteMaskedWide`'s disassembly was checked directly — it is NOT a
  48-pixel-wide *source* format. It reads the same 2 words (4 bytes) per row per plane as the
  regular byte-aligned path; "Wide" refers to a 5-byte *destination* footprint from sub-pixel
  ROR-shift spill (the same mechanism as `Gfx_BlitSpriteMasked`'s CL!=0 branch), not a different
  on-disk tile geometry. The hypothesized second/wider tile size has **not** been located anywhere
  yet — open question, not resolved by this correction.
- ~~`blocks1-4.pak`'s consumer/geometry~~ — **fully resolved**, see "`blocks*.pak` is 120
  individually-packed 32x16 tiles" above.
- `.pip` full-screen images do **not** use this same fixed-tile-array layout (unpacked sizes
  like 32066 don't divide evenly by 640 or by any obvious plane-count assumption) — still
  unresolved, see the note in `tools/extract-pak.js`'s history / next session's open items.
