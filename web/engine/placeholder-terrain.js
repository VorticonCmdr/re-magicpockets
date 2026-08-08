// A synthetic, hand-authored collision layer -- NOT derived from the real .pap tile data.
//
// Why this exists: collision.js originally assumed ".pap cell value 0 = passable" (matching
// docs/formats/pap.md's on-disk format notes), but every real level file has zero 0-valued cells
// -- confirmed while wiring this phase up (see docs/engine.md's updated `[0xef23]` note). The
// real tile-solidity rule lives in a per-tile collision-flag table (`Entity_ScanGroundRow` reads
// `[0xef23][tileByte]`) that hasn't been dumped yet, and a pixel-brightness heuristic over the
// decoded tile art doesn't cleanly separate solid rock from passable cave interior either (this
// is apparently a dig-through-rock game -- most terrain may simply BE solid by design). Rather
// than fake a wrong solidity rule against the real cave art, this module builds a small authored
// test level so collision.js/player.js can be proven correct in isolation. Swap this out once the
// `[0xef23]` table is decoded -- collision.js itself doesn't need to change, only the grid it's
// pointed at.

'use strict';

import { GRID_SIZE } from '../core/pap.js';

/** Builds a Uint8Array(GRID_SIZE*GRID_SIZE) collision grid: 0 = passable, nonzero = solid. */
export function buildPlaceholderCollisionGrid() {
  const grid = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const set = (col, row, solid = 1) => {
    if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) return;
    grid[row * GRID_SIZE + col] = solid;
  };
  const rect = (col0, row0, w, h, solid = 1) => {
    for (let r = row0; r < row0 + h; r++) for (let c = col0; c < col0 + w; c++) set(c, r, solid);
  };

  // Ground floor across a wide starting area, at row 20 (y=320px).
  rect(0, 20, 40, 3);
  // A couple of stepped platforms to demonstrate landing/blocking.
  rect(6, 16, 4, 1);
  rect(12, 13, 4, 1);
  rect(18, 17, 5, 1);
  // Breakable blocks sitting directly in the walking lane, reachable on foot from spawn without
  // jumping -- walk right and fire to clear a path through them.
  rect(10, 19, 3, 1);
  // A wall further along, past the blocks, to demonstrate horizontal blocking on its own.
  rect(24, 10, 1, 10);

  return { size: GRID_SIZE, grid, spawnCol: 2, spawnRow: 19 };
}
