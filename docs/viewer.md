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

An **Entities** dropdown overlays enemy/item/trigger placements decoded from that world's
level-script `.pin` file — see `docs/formats/pin-level-script.md`. Auto-selected by world like
the tileset; toggle off with the "show" checkbox. Hover a marker to see its type, position, file
offset, and raw payload words. A meaningful fraction of entities have unresolved (often
negative/off-map) coordinates — these are still plotted (the status line reports how many), not
hidden, since the coordinate-origin question is still open.

Entities render as their **actual sprite tile** when the mapping is confirmed exact (currently
only bonus/HUD-icon entities, via `extras.pak`/`extraxN.pak` — see
`docs/formats/pin-level-script.md`'s "Entity sprite rendering" section); everything else
(enemies/characters, whose sprite-bank tile-index formula isn't fully resolved yet) falls back to
a colored dot (one hue per type) rather than guessing the wrong tile.

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
- `build/png/<entityScript>.pin.json` (written by `tools/extract-level-script.js`) is the decoded
  entity list — `{entities: [{type, x, y, offset, bx, payload}, ...]}` — drawn directly in level
  pixel coordinates.
- `build/png/entity-shapes.json` (copied from `symbols/entity-shapes.json`, Ghidra-derived) maps
  entity `type` → shape descriptor (bank id + starting animation frame). For bank id 6, the
  viewer resolves this to a real tile in `extras.pak.png`/`extrax<world>.pak.png` and draws it at
  the entity's position instead of a dot.
