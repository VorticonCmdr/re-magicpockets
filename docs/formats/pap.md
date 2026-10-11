# `.pap` level tile-map format

Traced from the actual consumer code. **Correction**: an earlier pass concluded the on-disk
format was column-major based on visual inspection of the raw bytes alone (both row-major and
column-major readings produced non-random, tile-map-looking structure — a textbook case of
confirmation bias, since tile maps have local correlation in both dimensions). Tracing the
exact address arithmetic in the actual transpose routine resolved this unambiguously — trust
the code trace over a subjective visual read.

## The pipeline

- **`Level_LoadMapIntoScrollBuffer`** (`1000:1259`), called at the end of every
  `World1-4_LoadBanks` right after the segment-`6de3` `Load_PackedFile` call that reads the
  level's `.pap` file, does two things: a plain byte copy (`FUN_1000_1230`), then
  **`Level_TransposeMapToColumnMajor`**.
- **`Level_TransposeMapToColumnMajor`** (`1000:1291`) performs, for `row, col` in `0..127`:
  ```
  dest[0x4200 + col*128 + row] = source[0 + row*128 + col]
  ```
  i.e. **`dest[col*128+row] = source[row*128+col]`** — an explicit transpose from a
  **row-major source buffer** (offset `0`, populated directly by loading the `.pap` file) into
  a **column-major destination buffer** (`6de3:4200`).
- **`Camera_UpdateScroll`** and **`Level_UpdateAnimatedTiles`** (main-loop calls #1 and #2) read
  *only* from the column-major buffer at `6de3:4200` — never from the raw file layout — via
  `[8c13] = 0x4200 + tileX*0x80 + tileY` (see `docs/engine.md`).

**Conclusion: the `.pap` file itself is plain row-major** (`byte at row*128+col` = tile at map
row, col — the natural, boring, simplest interpretation). The column-major buffer is a
pure engine-internal optimization, built once at level-load time, for `Camera_UpdateScroll`'s
fast per-column scrolling access pattern (each on-screen column of tiles is then contiguous in
memory, cheap to fetch during horizontal scroll).

## Layout

Every shipped `.pap` file is exactly `16384` bytes = `128 × 128`, **no header**:

```
byte at offset (row * 128 + col) = tile index for map row `row`, column `col`
```

Tile size is asymmetric per `Camera_UpdateScroll`'s divide constants: 32px horizontally,
16px vertically — not yet fully explained (see open questions).

Tile byte values observed range roughly 1–120 (not 0–255).

## RESOLVED — tile index → `.pak` mapping, and the 32×16 asymmetric size

Both open questions below turned out to have the same answer. `blocks*.pak` was found (see
`docs/formats/pak.md`) to be exactly **120 individually-packed 32×16 tiles** — and every shipped
`.pap` file's byte values range **exactly 1–120 inclusive, with zero occurrences of 0**
(confirmed by scanning every cell of `level1a.pap`: min 1, max 120, 0 never appears). That is a
one-to-one match, not a coincidence: **tile byte value `V` indexes atlas tile `V-1`** (1-based on
disk) in the world's own `blocksN.pak` (`levelNa`/`levelNb` -> `blocksN.pak`, matched by the
world digit in the filename).

This also answers the asymmetric-tile-size question: there's **no row-doubling** — level tiles
are genuinely 32×16, rendered 1:1 against the `blocksN.pak` atlas, one map cell per tile. No
dosbox-x trace needed; the byte-range match alone was conclusive.

**Still open**: `pcmap.pap` and `sea.pap` have no world digit in their filenames, so which
`blocksN.pak` (if any single one) they render against is unconfirmed — `level.html`
defaults them to `blocks1` but lets the tileset be picked manually.

## Verification

`node tools/extract-pap.js build/raw/<file>.pap.raw` dumps the **row-major** grid (the
confirmed on-disk format) as a tile-index heatmap PNG, plus the raw grid as JSON. For an actual
rendered level (real tiles, not the heatmap), run `node tools/serve.js` and open
`level.html` — see `docs/viewer.md`.
