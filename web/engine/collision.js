// Tile-grid AABB collision -- a deliberately simplified stand-in for the original's
// Entity_ResolveGroundCollision (1000:e14f) and its ground-scan helpers
// (Entity_ScanGroundRow/Column + Variant, Entity_MergeGroundScanResults), which docs/engine.md and
// docs/enemies.md both flag as genuinely undecoded: a dense, per-(world,kind) dispatcher (~600
// decompiled lines of magic numbers) that the reverse-engineering sessions deliberately left for a
// dedicated future pass with dosbox-x behavioral verification, rather than reading register-mangled
// pseudocode cold. Reproducing it byte-for-byte is out of scope for this phase.
//
// What IS solidly established (docs/formats/pap.md, verified by rendering every level): .pap cell
// value 0 = empty/background, 1-120 = a real terrain tile. That's the one fact this module leans
// on: any non-zero cell is solid ground. Real per-kind ground reactions (one-way platforms, slopes,
// the breakable-block *entity* system in docs/enemies.md's "Ground-collision per-kind reactions")
// are not modeled here -- this is a standard, generic platformer tile collider, not a port of
// Entity_ResolveGroundCollision. Revisit once that function gets decoded branch-by-branch.

'use strict';

import { TILE_WIDTH, TILE_HEIGHT } from './camera.js';
import { GRID_SIZE } from '../core/pap.js';

/** Out-of-grid columns/rows are treated as solid (a hard level border), matching the camera's own clamp-to-level-bounds behavior. */
function isSolidTile(pap, col, row) {
  if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) return true;
  return pap.grid[row * GRID_SIZE + col] !== 0;
}

function columnSolid(pap, x, yTop, yBottom) {
  const col = Math.floor(x / TILE_WIDTH);
  const rowTop = Math.floor(yTop / TILE_HEIGHT);
  const rowBottom = Math.floor(yBottom / TILE_HEIGHT);
  for (let row = rowTop; row <= rowBottom; row++) {
    if (isSolidTile(pap, col, row)) return true;
  }
  return false;
}

function rowSolid(pap, y, xLeft, xRight) {
  const row = Math.floor(y / TILE_HEIGHT);
  const colLeft = Math.floor(xLeft / TILE_WIDTH);
  const colRight = Math.floor(xRight / TILE_WIDTH);
  for (let col = colLeft; col <= colRight; col++) {
    if (isSolidTile(pap, col, row)) return true;
  }
  return false;
}

/**
 * Moves an axis-aligned box {x,y,w,h} by (dx,dy) against the .pap solid-tile grid, one axis at a
 * time (X then Y), snapping to the tile boundary on contact. Mutates `box` in place. Returns
 * { onGround, hitCeiling, hitWall }.
 */
export function moveAndCollide(box, dx, dy, pap) {
  const flags = { onGround: false, hitCeiling: false, hitWall: false };

  if (dx !== 0) {
    box.x += dx;
    const edgeX = dx > 0 ? box.x + box.w : box.x;
    if (columnSolid(pap, edgeX, box.y + 1, box.y + box.h - 2)) {
      flags.hitWall = true;
      const col = Math.floor(edgeX / TILE_WIDTH);
      box.x = dx > 0 ? col * TILE_WIDTH - box.w : (col + 1) * TILE_WIDTH;
    }
  }

  if (dy !== 0) {
    box.y += dy;
    const edgeY = dy > 0 ? box.y + box.h : box.y;
    if (rowSolid(pap, edgeY, box.x + 1, box.x + box.w - 2)) {
      const row = Math.floor(edgeY / TILE_HEIGHT);
      if (dy > 0) {
        flags.onGround = true;
        box.y = row * TILE_HEIGHT - box.h;
      } else {
        flags.hitCeiling = true;
        box.y = (row + 1) * TILE_HEIGHT;
      }
    }
  }

  return flags;
}

export { isSolidTile };
