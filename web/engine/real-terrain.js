// Real per-level collision, derived from the actual `.pap` tile data + the real `[0xef23]`
// ground-collision table (core/tile-collision.js) -- replaces Phase 3/5's synthetic, hand-authored
// placeholder-terrain.js now that the table has been dumped. Every level plays on its own real
// geometry: the player collides with the actual cave walls/floors from the shipped level file,
// not an unrelated authored test arena.
//
// Spawn point, pickups, and the exit are all PLACEHOLDER, for every level, no exceptions -- a
// generic standable-spot search on the real collision grid, not real per-level authored data.
// This was tried twice and walked back twice:
//
// 1. The level-script's own type-3 (player) entity record looked promising, but decoding every
//    sub-level of all six shipped .pin files shows it's the exact same constant, X=144, Y=80, in
//    literally every sub-level of every world -- level-authoring-tool boilerplate, not real
//    per-room data (see docs/formats/pin-level-script.md).
// 2. That constant *looked* independently confirmed for level 1a by a live DOSBox memory read
//    (world 1/sublevel 1, entity array, class 3, X=144 Y=80) -- but a longer, more careful live
//    session found that exact entity (slot 1 in the pointer array) stays completely frozen
//    through minutes of clearly-active gameplay (score climbing from 500 to 9200, scenery
//    scrolling far from spawn), while a DIFFERENT entity (slot 0, type 1/class 1) is the one
//    actually tracking movement, mirroring the level's `[0x8bbb]`/`[0x8bbd]` "camera position"
//    globals exactly. The "confirmation" was reading the wrong entity. See docs/port-plan.md's
//    follow-up entries for the full trail (including why `[0x8bbb]`/`[0x8bbd]` isn't a usable
//    substitute either -- its coordinate space doesn't obviously align with `.pap` tile-grid
//    pixels, and it wasn't fully decoded before the live session became unreliable -- probably an
//    attract-mode demo, not a real controlled game).
//
// Getting real per-level spawn positions needs a cleaner live session (a definitely-real,
// deliberately-started game, paused at a well-defined moment) than either attempt so far.
//
// This game's real terrain is extremely dense (thin dug/carved passages through mostly-solid
// rock, not open platforms), which `isStandableSpot`'s floor+headroom check accounts for.

'use strict';

import { GRID_SIZE } from '../core/pap.js';
import { groundTableForWorld, WORLD_GROUND_TABLES } from '../core/tile-collision.js';
import { TILE_WIDTH, TILE_HEIGHT } from './camera.js';

/** Builds a {size, grid} collision grid (0/1) from real .pap data, matching collision.js's expected shape. */
export function buildRealCollisionGrid(pap, world) {
  // World 4's table (pointer 0xF2F5) is not transcribed yet; fall back to world 3's so the level is
  // still playable, but that is a stand-in, not the real table (ledger item 8).
  const table = groundTableForWorld(world) || WORLD_GROUND_TABLES[2];
  const grid = new Uint8Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = table[pap.grid[i]] !== 0 ? 1 : 0;
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
function isStandableSpot(grid, col, row, headroom = HEADROOM_ROWS) {
  if (isSolidCell(grid, col, row) || !isSolidCell(grid, col, row + 1)) return false;
  for (let h = 1; h <= headroom; h++) {
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
 * Builds spawn point, a handful of pickups, and an exit zone for a level, all placed on real
 * standable geometry. See module header for what's real (the collision) vs. placeholder
 * (everything else -- spawn, pickups, exit are all a generic standable-spot search for now).
 */
export function buildLevelPlayfield(pap, world) {
  const grid = buildRealCollisionGrid(pap, world);
  const spots = findStandableSpots(grid);

  const spawn = spots[0] || { col: 2, row: 2 };
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
