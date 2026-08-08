// Wires spawned level-script entities up to real behavior, using docs/enemies.md's CONFIRMED
// EXACT world-1 entries of Entity_DispatchUpdateByKind (the per-frame "think" dispatch table) --
// not a guess at which types are AI-driven, the literal table from the doc:
//
//   0x12 Entity_ThinkSwingingGate        (gate/switch family)
//   0x13 Entity_ThinkPatrolDefaultB      (generic patrol)
//   0x14 Entity_ThinkPeriodicIdleFidgetA (idle fidget, delegates to patrol)
//   0x20 Entity_ThinkChargingHazard      (charging hazard, delegates to patrol when idle)
//   0x23 Entity_ThinkPatrolDefaultA      (generic patrol)
//   0x2c Entity_ThinkPatrolDefaultC      (generic patrol, shared across all 4 worlds)
//
// Any (world, type) combination not in that table is a documented silent no-op in the original --
// entities whose type isn't one of the six above stay exactly as Phase 3 left them: spawned,
// visible, idle. What IS a labeled simplification, not a port: the exact per-type animation-set
// (+0x39, which table row an entity reads), the gate's real target-X coordinate semantics, the
// charging-hazard's exact charge-counter tuning, and the patrol-window bound substituting for real
// ground-extent detection -- see inline notes. All movement-AI-VM entities use animation-set 0 (a
// real, documented row -- "a baseline patroller: turn around when blocked/clear, re-sense when
// mixed" -- not a fabricated value), since the real per-type animSet assignment isn't dumped.

'use strict';

import { tickMovementAi } from './movement-ai-vm.js';

// World-1 Entity_DispatchUpdateByKind entries this port wires up (docs/enemies.md, exact).
export const GATE_TYPES = new Set([0x12]);
export const MOVEMENT_AI_TYPES = new Set([0x13, 0x14, 0x20, 0x23, 0x2c]);
const CHARGING_HAZARD_TYPE = 0x20;

const PATROL_RANGE_PX = 96; // placeholder stand-in for real ground-extent/lookahead detection
const PATROL_SPEED = 0.5; // px/frame, placeholder
const CHASE_SPEED = 1.1; // px/frame, placeholder
const CHASE_RANGE_PX = 140; // placeholder for the real +0x37/+0x38 per-entity range fields
const STRIKE_RANGE_PX = 110;
const GATE_SPEED = 0.6; // px/frame, placeholder
const GATE_TRAVEL_PX = 96; // placeholder stand-in for the real target-X (0x8c25) semantics
const GATE_PARK_FRAMES = 90;

/** Attaches an `.ai` behavior record to `entity` if its type matches a wired-up world-1 dispatch entry. Returns true if attached. */
export function attachAiIfKnown(entity) {
  if (GATE_TYPES.has(entity.type)) {
    entity.ai = {
      kind: 'gate',
      homeX: entity.x,
      facing: 1,
      parkTimer: 0,
    };
    return true;
  }
  if (MOVEMENT_AI_TYPES.has(entity.type)) {
    entity.ai = {
      kind: entity.type === CHARGING_HAZARD_TYPE ? 'chargingHazard' : 'patrol',
      animSet: 0, // see module header
      homeX: entity.x,
      y: entity.y,
      facing: Math.random() < 0.5 ? -1 : 1,
      state: 'patrol',
      chaseRangePx: CHASE_RANGE_PX,
      strikeRangePx: STRIKE_RANGE_PX,
      charge: 0,
      lastOpcode: null,
    };
    return true;
  }
  return false;
}

function tickGate(entity, collisionGrid) {
  const ai = entity.ai;
  if (ai.parkTimer > 0) {
    ai.parkTimer--;
    return;
  }
  entity.x += ai.facing * GATE_SPEED;
  const travelled = entity.x - ai.homeX;
  if (Math.abs(travelled) >= GATE_TRAVEL_PX) {
    entity.x = ai.homeX + Math.sign(travelled) * GATE_TRAVEL_PX;
    ai.facing = -ai.facing;
    ai.parkTimer = GATE_PARK_FRAMES; // "rolls a chance to settle into a parked state"
  }
}

function tickMovementAiEntity(entity, player, collisionGrid, rng) {
  const ai = entity.ai;
  // keep the movement-AI's own (x,y) view in sync with the entity's real position
  ai.x = entity.x;
  ai.y = entity.y;

  if (ai.kind === 'chargingHazard') {
    // ±2/frame clamped 0-0xc, per docs/enemies.md's charge-counter note
    ai.charge = Math.max(0, Math.min(0xc, ai.charge + (ai.state === 'chase' ? 2 : -2)));
  }

  // Placeholder stand-in for real ground-extent detection (see movement-ai-vm.js's
  // sampleLookahead header) -- close to the patrol-window edge reads as "blocked".
  ai.nearPatrolEdge = Math.abs(entity.x + ai.facing * PATROL_SPEED * 4 - ai.homeX) >= PATROL_RANGE_PX;

  tickMovementAi(ai, player, collisionGrid, rng);

  // The actual position-delta application: per docs/enemies.md's class-2 note, this happens in
  // the POST-dispatch step (Entity_MoveHorizontalByFlags), not inside the think function itself.
  const chargeMul = ai.kind === 'chargingHazard' ? 1 + ai.charge / 0xc : 1;
  if (ai.state === 'chase' || ai.state === 'strike') {
    const dx = player.x - entity.x;
    const dy = player.y - entity.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (ai.state === 'chase') {
      entity.x += (dx / dist) * CHASE_SPEED * chargeMul;
      entity.y += (dy / dist) * CHASE_SPEED * chargeMul;
    }
    // 'strike' range: close enough that we just hold position (no attack/damage system yet).
  } else {
    entity.x += ai.facing * PATROL_SPEED * chargeMul;
    if (Math.abs(entity.x - ai.homeX) > PATROL_RANGE_PX) {
      entity.x = ai.homeX + Math.sign(entity.x - ai.homeX) * PATROL_RANGE_PX;
      ai.facing = -ai.facing;
    }
  }
}

/** Ticks every pool entity that has an `.ai` record. Call once per frame from entityUpdateAll. */
export function tickAllAi(entities, player, collisionGrid, rng) {
  for (const entity of entities) {
    if (!entity.ai) continue;
    if (entity.ai.kind === 'gate') tickGate(entity, collisionGrid);
    else tickMovementAiEntity(entity, player, collisionGrid, rng);
  }
}
