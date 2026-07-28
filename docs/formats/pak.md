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

**Color-plane bit order**: plane 0/1/2/3 → Blue/Green/Red/Intensity, forming a standard 4-bit
EGA palette index (`intensity<<3 | red<<2 | green<<1 | blue`). This matches the Sequencer Map
Mask cycling order (`0x01,0x02,0x04,0x08`) confirmed in `Gfx_BlitSpriteMasked`'s disassembly.
Since no custom palette is ever set (see `docs/memory-map.md`), the index maps directly to the
fixed default EGA/VGA 16-colour palette — see `tools/ega.js::EGA_PALETTE`.

## Tile counts per file (all confirmed exact — no remainder)

| Unpacked size | Tile count | Files |
|---|---|---|
| 12800 | 20 | `special1-4.pak`, `kidx1-4.pak`, `extrax1-4.pak` |
| 30720 | 48 | `blocks1-4.pak` |
| 38400 | 60 | `nasty1-4.pak`, `bitkid.pak`, `ape.pak`, `extras.pak` |

## Verification

`node tools/extract-pak.js build/raw/<file>.pak.raw` produces a PNG sprite sheet. Every file
extracts cleanly (exact division by 640, no leftover bytes). Visual inspection of the produced
sheets (sent to the user directly) shows recognizable, coherent game art — rounded platform
tiles, character sprites, enemy sprites — not noise, confirming the format end-to-end.

## Open questions

- **Sprite *placement/identity* metadata** (which tile index means what, animation frame
  groupings, hotspots) lives elsewhere — likely in the `.pap` level-map files or in code tables,
  not in the `.pak` files themselves. Not yet traced.
- **The "wide" sprite class** (`Gfx_BlitSpriteMaskedWide`/`WideB`, 48px/6-byte rows) implies a
  second tile size (48×32 or similar) must exist somewhere — not yet located in any `.pak` file
  examined so far (all confirmed files so far use the 32px/640-byte layout). Worth checking
  `bitkid.pak`/`ape.pak`/`extras.pak` (the "60 tile" class) more closely, or the `.pip` files,
  once those are understood.
- `.pip` full-screen images do **not** use this same fixed-tile-array layout (unpacked sizes
  like 32066 don't divide evenly by 640 or by any obvious plane-count assumption) — still
  unresolved, see the note in `tools/extract-pak.js`'s history / next session's open items.
