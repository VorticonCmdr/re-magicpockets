// Entity free-list allocator -- port of the structural facts docs/engine.md confirms about
// Entity_FreeSlot/the entity system: a ~140-slot (this doc's later pass narrows it to ~146)
// pointer array walked by Entity_UpdateAll, with dead entities (state byte +0x40 == 0x19) removed
// by linear-scan compaction. A plain JS array of slot objects (or null) is a direct, equivalent
// stand-in -- no need to replicate the fixed-size compaction shuffle, since JS doesn't pay for
// sparse-array holes the way the original's dense C-style array did.
//
// Entity_UpdateBehavior (the per-kind gameplay dispatcher) and Entity_RunScript (the opcode
// bytecode VM) are NOT wired up yet -- see docs/port-plan.md Phase 4. This phase spawns every
// level-script entity into the pool (capped at MAX_ENTITIES, matching the original's real
// capacity) so they're visible in the world, but nothing calls a per-entity update: they sit
// exactly at their spawn position/frame, "idle sprites" per this phase's checkpoint goal.

'use strict';

export const MAX_ENTITIES = 146;

export class EntityPool {
  constructor(maxEntities = MAX_ENTITIES) {
    this.maxEntities = maxEntities;
    this.slots = new Array(maxEntities).fill(null);
  }

  /** Entity_FindFreeSlot equivalent: first empty slot, or -1 if the pool is full. */
  _findFreeSlot() {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i] === null) return i;
    }
    return -1;
  }

  /**
   * Entity_SpawnFromQueuedEvent equivalent, restricted to the generic (type, X, Y) fields the
   * level-script decoder already extracts (docs/formats/pin-level-script.md) -- the nine
   * bespoke-layout types' extra fields (direction vectors, linked spawns) aren't populated.
   * Returns the slot index, or -1 if the pool is full.
   */
  spawnFromLevelScriptRecord(record) {
    const i = this._findFreeSlot();
    if (i === -1) return -1;
    this.slots[i] = {
      type: record.type, // entity struct field +2
      x: record.x, // +6
      y: record.y, // +8
      dead: false, // state byte +0x40 == 0x19 in the original
    };
    return i;
  }

  /** Entity_FreeSlot equivalent. */
  free(index) {
    this.slots[index] = null;
  }

  /** Entity_UpdateAll's list walk, minus dead entities. */
  get live() {
    return this.slots.filter((e) => e !== null && !e.dead);
  }
}
