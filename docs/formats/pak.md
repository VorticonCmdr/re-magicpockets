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
writing the 4 color planes 0..3 in the same temporal order. **Which plane feeds which bit of
the final 4-bit palette index is a separate question**, and empirically does *not* match the
naive textbook EGA convention (plane0=Blue,1=Green,2=Red,3=Intensity — that assignment produced
visibly wrong colors when tested against a decoded `.pip` screen). The mapping that looked
correct on visual inspection is `PLANE_TO_INDEX_BIT = [1,0,3,2]` in `tools/ega.js` — i.e. index
bit 0 comes from plane 1, bit 1 from plane 0, bit 2 from plane 3, bit 3 from plane 2. This was
selected by generating several candidate permutations and eye-balling the result (see
`docs/formats/pip.md`), not derived from a definitive reference — treat as **tentatively
confirmed**, not certain. Since no custom palette is ever set (see `docs/memory-map.md`), the
resulting index maps directly to the fixed default EGA/VGA 16-colour palette — see
`tools/ega.js::EGA_PALETTE`.

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

## CORRECTION pending — a real palette exists and this file's color guess needs re-validation

A real, code-derived per-world 16-colour palette was found on the `'C'` ("Colour VGA") driver
path — see `docs/memory-map.md`'s "Palette setting" section. This project's own shipped
`pockets.ini` selects exactly that driver. The `PLANE_TO_INDEX_BIT` mapping above was tuned by
eyeballing candidates against a *hardcoded default EGA palette* that is very likely NOT what the
game actually displays for any given world. The plane→index-bit assembly (which of the 4 planes
feeds which bit of the 0-15 index) may still be right — that's a separate question from which
RGB each index maps to — but the color-mapping "confirmation" needs to be redone against the
real extracted palette, not the default one. Not yet done.

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
