# `tools/viewer.html` — JS level viewer

Renders actual `.pap` levels using the real `blocksN.pak` tile atlases (not the tile-index
heatmap `tools/extract-pap.js` produces on its own) — a canvas-based, dependency-free static
page over `build/` output.

## Usage

```
node tools/build-all.js   # regenerate build/ (needed once, or after any decoder change)
node tools/serve.js       # zero-dependency static server (browsers block fetch() on file://)
# open http://localhost:8080/tools/viewer.html
```

Pick a level from the dropdown; the matching world's tileset (`blocksN.pak`, matched by the
digit in the level's filename) is auto-selected, and can be overridden manually — useful for
`pcmap`/`sea`, which have no world digit and no confirmed tileset (see
`docs/formats/pap.md`'s "Still open" note). Hover any tile to see its raw on-disk value and
resolved atlas index. Zoom slider covers 25%–400%; the canvas itself is always rendered at
native tile resolution (`gridWidth*32 x gridHeight*16` px) and scaled via CSS so pixel art stays
crisp (`image-rendering: pixelated`).

## How it works

- `build/manifest.json` (written by `tools/build-all.js`) lists every `.pap` level and every
  `blocksN.pak` tileset, with a best-effort "world" number parsed from the filename.
- `build/png/<tileset>.pak.json` (written by `tools/extract-pak.js`) is a small sidecar next to
  the PNG atlas giving `{tileWidth, tileHeight, cols, rows, tileCount}` — the viewer uses this to
  compute each tile's source rect instead of hardcoding atlas geometry.
- `build/png/<level>.pap.json` (written by `tools/extract-pap.js`) is the raw 128x128 row-major
  tile-index grid.
- Per cell: on-disk value `V` (range 1–120, confirmed exact, see `docs/formats/pap.md`) draws
  atlas tile `V-1` (0-based) via `drawImage` with a source rect from the sidecar. This 1:1
  value-to-tile mapping, and the resulting coherent, seamless level renders (real corridors,
  platforms, ladders — not noise), is the empirical confirmation that closed both of
  `docs/formats/pap.md`'s former open questions in one shot.
