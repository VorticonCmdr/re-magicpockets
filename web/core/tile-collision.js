// The REAL per-tile ground-collision table -- `[0xef23]`'s default target, `6de3:f189` (256
// bytes), read directly from GAMEU.EXE's data segment via Ghidra. This resolves the open item
// tracked since Phase 3 (docs/engine.md's "[0xef23]" note, docs/port-plan.md Phase 3): the table
// IS indexed directly by the raw `.pap` tile byte value (confirmed: entries 1-120 are exactly
// the valid on-disk tile-value range, docs/formats/pap.md), and it's a clean, clearly
// hand-authored 0/1/16 classification, not noise -- e.g. a solid rock-face run reads
// `1,1,1,1,1,1,1,1,1,...` while background/decorative runs read `0,0,0,0`. `Entity_ScanGroundRow`
// (docs/engine.md) accumulates this value into a ground-contact score rather than treating it as
// a flat boolean, so the exact 1-vs-16 distinction (maybe "normal ground" vs. "strong/special
// ground", possibly a ladder or hazard marker) isn't confirmed -- this port treats both as solid
// for basic AABB collision, only 0 as passable, which is the safe, evidence-supported reading.
//
// A second table exists at `6de3:f27b` (the "custom tile table" docs/enemies.md's
// Entity_ThinkPatrolWithCustomTileTableA/B temporarily swap `[0xef23]` to) -- structurally
// near-identical to this one but with every `16` entry replaced by `0`, i.e. a stricter variant
// that treats the special tiles as non-solid. Not wired up yet (would need per-entity-kind
// [0xef23] swapping, which movement-ai-vm.js doesn't do) -- every entity in this port uses the
// default table.

'use strict';

// prettier-ignore
export const GROUND_TABLE = new Uint8Array([
  0,1,1,1,1,0,0,1,1,1,1,1,1,1,1,1,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  1,1,1,1,0,1,1,16,16,1,1,1,1,1,1,1,
  1,16,16,1,1,0,1,1,1,1,1,16,16,1,1,1,
  1,1,1,1,1,16,16,1,1,0,0,1,1,1,1,16,
  16,16,16,16,16,1,1,1,1,16,16,0,0,0,0,16,
  16,1,16,16,16,0,0,0,0,16,16,1,16,16,16,0,
  0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,
  1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,1,1,0,0,0,0,1,1,1,1,1,1,
  1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,1,1,1,1,0,0,1,1,1,1,1,1,1,
]);

/** True if raw tile byte value `v` (a real `.pap` cell value, 1-120) is solid for standing/walking. */
export function isGroundTileValue(v) {
  return v > 0 && v < GROUND_TABLE.length && GROUND_TABLE[v] !== 0;
}
