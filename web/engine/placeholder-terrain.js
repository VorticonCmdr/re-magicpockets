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
import { TILE_WIDTH, TILE_HEIGHT } from './camera.js';

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

  // Positioned (cols 9-40, rows 0-10 => x288-1280, y0-160) to overlap where new1.pin's real
  // type-0x12/0x13/0x14/0x20/0x23 entities actually spawn (x360-1084, y0-112, per Phase 4's
  // wiring in engine/entity-ai.js) -- so the player demo happens near the real, moving AI
  // entities instead of an empty corner of the map.
  //
  // Ground floor across a wide area, at row 10 (y=160px).
  rect(9, 10, 31, 3);
  // A couple of stepped platforms to demonstrate landing/blocking.
  rect(13, 7, 4, 1);
  rect(19, 5, 4, 1);
  rect(25, 8, 5, 1);
  // Breakable blocks sitting directly in the walking lane, reachable on foot from spawn without
  // jumping -- walk right and fire to clear a path through them.
  rect(15, 9, 3, 1);
  // A wall further along, past the blocks, to demonstrate horizontal blocking on its own.
  rect(35, 3, 1, 7);

  // Placeholder pickups (Phase 5) -- NOT derived from real level-script pickup entities (this
  // port doesn't have the runtime "+0x10" pairing field docs/engine.md's
  // Entity_InteractionPhaseType1bHandler note describes, so it can't identify which real entity
  // types are pickups vs. AI-driven vs. background prop yet). Placed on the jump platforms so
  // collecting them naturally follows from Phase 3's jump demo.
  const pickups = [
    { x: 13 * TILE_WIDTH + 8, y: 7 * TILE_HEIGHT - 4 },
    { x: 19 * TILE_WIDTH + 16, y: 5 * TILE_HEIGHT - 4 },
    { x: 27 * TILE_WIDTH + 16, y: 8 * TILE_HEIGHT - 4 },
  ];

  // Placeholder level-exit zone, past the wall -- reaching it ends the demo run.
  const exitZone = { x: 37 * TILE_WIDTH, y: 8 * TILE_HEIGHT, w: 3 * TILE_WIDTH, h: 2 * TILE_HEIGHT };

  return { size: GRID_SIZE, grid, spawnCol: 10, spawnRow: 9, pickups, exitZone };
}
