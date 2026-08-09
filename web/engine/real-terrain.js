// Real per-level collision, derived from the actual `.pap` tile data + the real `[0xef23]`
// ground-collision table (core/tile-collision.js) -- replaces Phase 3/5's synthetic, hand-authored
// placeholder-terrain.js now that the table has been dumped. Every level plays on its own real
// geometry: the player collides with the actual cave walls/floors from the shipped level file,
// not an unrelated authored test arena.
//
// Spawn point: for level "1a" this is now the REAL authored position -- confirmed by connecting
// live to a running DOSBox instance (dosbox-mcp), pausing at world 1/sublevel 1, and reading the
// entity array directly out of guest memory (6de3 segment, entity struct block starting near
// 0x9398, 66 bytes/entity, +2=type +4=class +6/+8=X/Y): exactly one entity has class 3 (the
// player, per docs/enemies.md's confirmed sprite cross-reference), type 3, at X=144, Y=80 -- read
// twice (byte-identical both times) while genuinely paused, not a mid-motion snapshot. See
// AUTHORED_SPAWN_PX below. Not done for the other 7 levels -- would need the same live read
// repeated per level, not attempted this pass.
//
// This game's real terrain turns out to be extremely dense (thin dug/carved passages through
// mostly-solid rock, not open platforms -- see the ASCII-art dump in this investigation's session
// notes), so the exact authored pixel can sit inside what this port's simplified single-tile AABB
// collider calls "solid" even though the real game clearly doesn't treat it that way (the entity
// was sitting there, running, not stuck). Rather than trust a collision model that's demonstrably
// too strict for this terrain, the authored point is snapped to the nearest PASSABLE cell (a
// plain BFS flood-fill, no floor/headroom requirement) and left for gravity to settle from there
// -- empirically this converges within one fall to almost exactly the real Y (dropping onto the
// solid floor immediately below the nearest gap lands the player's feet at y=80, matching the
// authored value, since the real spawn sits right at that same floor line).
//
// Pickups and the exit zone are still NOT from real game data -- there's no decoded "pickup"/
// "exit" entity-type mapping (see docs/engine.md's Entity_InteractionPhaseType1bHandler note) --
// found generically by scanning for standable spots, same as before.

'use strict';

import { GRID_SIZE } from '../core/pap.js';
import { GROUND_TABLE } from '../core/tile-collision.js';
import { TILE_WIDTH, TILE_HEIGHT } from './camera.js';

// Real, live-memory-confirmed player spawn positions, keyed by level-registry id. Level-space
// pixel coordinates (same 32x16 tile-pixel convention as everything else in this port).
export const AUTHORED_SPAWN_PX = {
  '1a': { x: 144, y: 80 },
};

/** Builds a {size, grid} collision grid (0/1) from real .pap data, matching collision.js's expected shape. */
export function buildRealCollisionGrid(pap) {
  const grid = new Uint8Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = GROUND_TABLE[pap.grid[i]] !== 0 ? 1 : 0;
  }
  return { size: GRID_SIZE, grid };
}

function isSolidCell(grid, col, row) {
  if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) return true;
  return grid.grid[row * GRID_SIZE + col] !== 0;
}

// The player's box is ~30px tall (engine/player.js) against 16px tile rows -- 2 rows of headroom
// needed, not 1, or the spawn point embeds the player's head in solid rock (a real bug this
// module shipped with initially: a 1-row check found spots that were passable at the floor cell
// but still solid 2 tiles up, freezing the player in place on spawn -- caught by an automated
// browser test where the player never moved despite input being held for 2+ seconds).
const HEADROOM_ROWS = 2;

/** A passable cell with enough passable headroom above and solid floor below -- a place something could stand. */
function isStandableSpot(grid, col, row) {
  if (isSolidCell(grid, col, row) || !isSolidCell(grid, col, row + 1)) return false;
  for (let h = 1; h <= HEADROOM_ROWS; h++) {
    if (isSolidCell(grid, col, row - h)) return false;
  }
  return true;
}

/**
 * Scans for standable spots within [colRange, rowRange], in scan order (column-major, ascending).
 * Generic, level-agnostic -- works the same for any world's real geometry.
 */
function findStandableSpots(grid, { colStart = 2, colEnd = GRID_SIZE - 2, rowStart = 0, rowEnd = GRID_SIZE - 2, maxResults = 200 } = {}) {
  const found = [];
  for (let col = colStart; col <= colEnd && found.length < maxResults; col++) {
    for (let row = rowStart; row <= rowEnd && found.length < maxResults; row++) {
      if (isStandableSpot(grid, col, row)) found.push({ col, row });
    }
  }
  return found;
}

/**
 * Plain BFS flood-fill to the nearest passable cell from (col, row) -- no floor/headroom
 * requirement, just "not solid". Used to place the player as close as possible to a real authored
 * spawn point without embedding it in rock, on terrain too dense for `isStandableSpot`'s stricter
 * definition to ever match nearby (see module header).
 */
function nearestPassableCell(grid, col, row, maxSteps = 4000) {
  const startKey = `${col},${row}`;
  const seen = new Set([startKey]);
  const queue = [[col, row]];
  let steps = 0;
  while (queue.length && steps++ < maxSteps) {
    const [c, r] = queue.shift();
    if (!isSolidCell(grid, c, r)) return { col: c, row: r };
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc;
      const nr = r + dr;
      const key = `${nc},${nr}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push([nc, nr]);
      }
    }
  }
  return null;
}

/**
 * Builds spawn point, a handful of pickups, and an exit zone for a level, all placed on real
 * standable geometry. See module header for what's real (the collision) vs. placeholder (which
 * exact spots get used for what). `authoredSpawnPx` (optional, {x,y}) overrides the generic
 * standable-spot spawn search with a real position, snapped to the nearest passable cell.
 */
export function buildLevelPlayfield(pap, authoredSpawnPx = null) {
  const grid = buildRealCollisionGrid(pap);
  const spots = findStandableSpots(grid);

  let spawn = spots[0] || { col: 2, row: 2 };
  if (authoredSpawnPx) {
    const authoredCol = Math.floor(authoredSpawnPx.x / TILE_WIDTH);
    const authoredRow = Math.floor(authoredSpawnPx.y / TILE_HEIGHT);
    const nearest = nearestPassableCell(grid, authoredCol, authoredRow);
    if (nearest) spawn = nearest;
  }
  // Pickups: a handful of spots spread out from the spawn, not immediately adjacent to it.
  const pickupSpots = spots.filter((s) => Math.abs(s.col - spawn.col) > 3).slice(0, 12);
  const pickups = [];
  const step = Math.max(1, Math.floor(pickupSpots.length / 3));
  for (let i = 0; i < pickupSpots.length && pickups.length < 3; i += step) {
    const s = pickupSpots[i];
    pickups.push({ x: s.col * TILE_WIDTH + TILE_WIDTH / 2, y: s.row * TILE_HEIGHT - 4 });
  }

  // Exit: the farthest-right standable spot found (a placeholder stand-in for a real decoded
  // level-completion trigger -- see module header).
  const exitSpot = spots.reduce((best, s) => (!best || s.col > best.col ? s : best), null) || spawn;
  const exitZone = {
    x: exitSpot.col * TILE_WIDTH - TILE_WIDTH,
    y: exitSpot.row * TILE_HEIGHT - TILE_HEIGHT,
    w: TILE_WIDTH * 3,
    h: TILE_HEIGHT * 2,
  };

  // Flatten `grid` ({size, grid: Uint8Array}) into the returned object's own top level -- this
  // object IS the collision grid collision.js/movement-ai-vm.js expect ({size, grid: Uint8Array}
  // directly), plus the extra playfield fields, not a further nesting under its own `.grid` key.
  return { size: grid.size, grid: grid.grid, spawnCol: spawn.col, spawnRow: spawn.row, pickups, exitZone };
}
