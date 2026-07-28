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

## Open questions

- **The 32×16 asymmetric tile size.** Is Y-granularity finer for collision/scroll purposes
  while rendering still uses 32×32 visual tiles (two map rows per rendered tile row), or are
  level tiles genuinely 32×16?
- **Tile index → `.pak` tile mapping.** Not yet confirmed which `.pak` file(s) a given byte
  value indexes into, or whether indices combine multiple tile banks. Needed before `.pap`
  files can be rendered as actual level images rather than an index heatmap.
- Confirm both of the above with a dosbox-x memory dump comparison once available.

## Verification

`node tools/extract-pap.js build/raw/<file>.pap.raw` dumps the **row-major** grid (the
confirmed on-disk format) as a tile-index heatmap PNG for visual sanity-checking — not yet a
true rendered level (see open questions above).
