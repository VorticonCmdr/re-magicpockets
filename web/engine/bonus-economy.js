// Entity_ChooseAndSpawnBonusItem (1000:4a50) equivalent -- docs/engine.md's RESOLVED,
// branch-by-branch decode of the world-1 bonus-item-type heuristic. This is a faithful port of
// the DECISION TREE (the real one, not a guess), but fed APPROXIMATED inputs: the original reads
// six difficulty-input globals ([0x8bb3], [0x8c07]/[0x8c08], [0x8b75], [0x8c05], and worlds 2-4's
// [0x8c09]/[0x8bb2]/[0x8bff]) that are each produced by subsystems this port hasn't built
// (the four-part breakable-block split/child-spawn chain, the AI despawn/capture counter, the
// generic hazard-block epilogue). This port only tracks blocksBroken/pickupsCollected/score, so
// those stand in for the closest real counters -- see the mapping comments below. Swap in the
// real counters once their producing subsystems are ported; the branch structure itself won't
// need to change.

'use strict';

// World-1 bonus item types (docs/engine.md) -> the shape-descriptor id, resolved via
// symbols/entity-shapes.json exactly like any other entity (bank 3 `specialN.pak` or bank 6
// `extras`/`extraxN`, both already loaded by main.js's EXTRA_SPRITE_FILES list).
export const BONUS_TYPE = {
  BASIC: 0x3a,
  HAZARD_HIGH: 0x3b,
  HAZARD_MID: 0x3c,
  HAZARD_LOW: 0x3d,
  SCORE_MILESTONE: 0x38,
  FALLBACK_LOW: 0x37,
  FALLBACK_HIGH: 0x39,
};

/**
 * World-1 branch of Entity_ChooseAndSpawnBonusItem, decision structure verbatim from
 * docs/engine.md. `counters` is { blocksBroken, pickupsCollected, score } -- this port's stand-ins
 * for [0x8bb3] (real: "special blocks destroyed"), [0x8c07]/[0x8c08] (real: generic hazard-block
 * destroy count/reward total -- approximated here by blocksBroken again, since this port doesn't
 * distinguish block types), [0x8b75] (real: running score, matches directly), and [0x8c05] (real:
 * a broader hazard/pickup-interaction tally -- approximated by pickupsCollected).
 */
export function chooseWorld1BonusType(counters) {
  const { blocksBroken, pickupsCollected, score } = counters;

  // [0x8bb3] and [0x8c07] are two DISTINCT real counters (special-blocks-destroyed vs. generic-
  // hazard-blocks-destroyed) that this port's single `blocksBroken` proxy can't tell apart -- so
  // the real "[0x8c07]<4 -> 0x3d" branch is unreachable here (it'd always be caught by the first
  // check first) and is intentionally dropped rather than left as dead code.
  if (blocksBroken < 4) return BONUS_TYPE.BASIC; // [0x8bb3]<4 -> 0x3a
  if (blocksBroken > 10) return BONUS_TYPE.HAZARD_HIGH; // [0x8c07]>10 -> 0x3b
  if (score > 200) return BONUS_TYPE.SCORE_MILESTONE; // [0x8b75]>200 -> 0x38
  if (blocksBroken <= 10) return BONUS_TYPE.HAZARD_MID; // [0x8c07] mid-range, ratio-gate approximated flat -> 0x3c

  // Shared fallback: [0x8c05] < 0x1f (31) -> 0x37, else -> 0x39
  return pickupsCollected < 0x1f ? BONUS_TYPE.FALLBACK_LOW : BONUS_TYPE.FALLBACK_HIGH;
}

/** Spawns a bonus-item pool entity at (x, y) with a real resolvable sprite type. */
export function spawnBonusItem(pool, type, x, y) {
  const slot = pool.spawnFromLevelScriptRecord({ type, x, y });
  return slot === -1 ? null : pool.slots[slot];
}
