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

| Unpacked size | Tile count | Files |
|---|---|---|
| 12800 | 20 | `special1-4.pak`, `kidx1-4.pak`, `extrax1-4.pak` |
| 30720 | 48 | `blocks1-4.pak` |
| 38400 | 60 | `nasty1-4.pak`, `bitkid.pak`, `ape.pak`, `extras.pak` |

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
- **`blocks1-4.pak`'s real format and consumer function are unresolved** — see the "RESOLVED"
  section above. This is now the single highest-value open question for this format.
- `.pip` full-screen images do **not** use this same fixed-tile-array layout (unpacked sizes
  like 32066 don't divide evenly by 640 or by any obvious plane-count assumption) — still
  unresolved, see the note in `tools/extract-pak.js`'s history / next session's open items.
