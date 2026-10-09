// Per-world tile solidity tables used by the hero's ground scans -- the data `[0xef23]` points at.
//
// `[PROVEN]` live in DOSBox (2026-10-09): `[0xef23]` read 0xEFA5 during world 1 gameplay, and the
// 256 bytes there equal the EXE's. The new-game state initializer (`1000:0C69`..) sets it with
//     di = 0xEF25; ax = ([8B89] != 0 ? [8B89] : [8B8B]) - 1; di = [di + ax*2]; [0xEF23] = di
// where the word list at DS:0xEF25 holds 0xEFA5, 0xF097, 0xF189, 0xF2F5. So worlds 1-3 each have
// their own 242-byte table (two 121-byte halves, indexed by the raw .pap tile byte 1..121); world 4's
// pointer (0xF2F5) leads to a differently shaped block that is NOT transcribed here yet.
// `Entity_ThinkPatrolWithCustomTileTable{A,B}` temporarily point [0xef23] at 0xF189 / 0xF27B.
//
// ⚠️ An earlier version of this file held only the 0xF189 table (world 3's) and used it for every
// world, calling it "the default"; that made level 1a read 9.4% passable instead of 40.3% and the
// hero's cave look solid. tools/verify checks every table below byte-for-byte against GAMEU.EXE.
// The meaning of the value 16 and of the second 121-byte half is not decoded (ledger items 7-9).

'use strict';

export const TABLE_BYTES = 242;

// prettier-ignore
export const WORLD_GROUND_TABLES = [
[
  0,0,1,1,1,1,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,1,
  1,1,1,1,1,1,1,1,0,1,1,1,0,0,0,1,1,0,0,1,1,1,
  0,1,1,1,1,0,0,1,1,0,1,1,1,0,0,0,1,0,1,1,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,0,0,1,
  1,0,0,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,1,1,0,
  0,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,
  1,1,1,1,1,1,1,1,1,0,1,1,1,0,0,1,1,1,1,1,0,1,
  0,0,0,1,1,1,1,1,0,1,0,0,0,1,1,1,1,1,0,1,0,0,
  1,1,0,1,1,1,0,1,0,0,1,1,1,1,1,1,0,1,0,0,1,1,
  1,1,1,1,0,0,0,0,1,1,1,1,1,1,1,1,1,0,0,0,0,0,
  1,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,
],
[
  0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,
  1,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,1,1,1,
  1,1,1,1,0,1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,
  1,0,0,1,0,0,0,0,0,1,1,1,0,1,1,0,0,1,1,0,0,0,
  0,1,0,0,1,1,1,1,0,0,1,1,1,0,0,0,0,0,1,1,1,1,
  1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,16,16,16,16,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,
  1,0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
],
[
  0,1,1,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,1,16,16,1,1,1,
  1,1,1,1,1,16,16,1,1,0,1,1,1,1,1,16,16,1,1,1,1,1,
  1,1,1,16,16,1,1,0,0,1,1,1,1,16,16,16,16,16,16,1,1,1,
  1,16,16,0,0,0,0,16,16,1,16,16,16,0,0,0,0,16,16,1,16,16,
  16,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,
  0,0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
],
].map((t) => Uint8Array.from(t));

/** DS-relative address of each world's table, for provenance checks against the EXE. */
export const WORLD_GROUND_TABLE_ADDR = [0xefa5, 0xf097, 0xf189];

/** The table for world 1..3, or null for a world whose table has not been transcribed. */
export function groundTableForWorld(world) {
  return WORLD_GROUND_TABLES[world - 1] || null;
}

/** True if raw tile byte `v` (a real .pap cell value, 1..121) is solid in this world's table. */
export function isGroundTileValue(world, v) {
  const t = groundTableForWorld(world);
  return !!t && v > 0 && v < TABLE_BYTES && t[v] !== 0;
}

/** World 3's table under its old name, kept so committed callers that predate per-world tables still load. */
export const GROUND_TABLE = WORLD_GROUND_TABLES[2];
