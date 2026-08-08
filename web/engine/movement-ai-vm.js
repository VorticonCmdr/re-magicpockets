// Entity_RunMovementAiScript (1000:6320) equivalent -- the 6-opcode movement-AI interpreter
// documented in docs/enemies.md. The three per-animation-set script tables below are transcribed
// byte-exact from that doc's live-memory dump (0xec68/0xec7c/0xec90, 20 chars each, indexed by
// entity animation-set +0x39); 'o' stands in for any byte outside `n p q r s t` (the interpreter's
// own implicit stop/no-op, per docs/enemies.md).
//
// Opcode *semantics* are "characterized, not decoded line-by-line" per that doc (~150 dense
// decompiled lines the project's own effort/payoff bar left for a future pass) -- so the handlers
// below are a faithful STRUCTURAL port (same opcode roles: turn-around, scan-then-maybe-react,
// acquire-target-and-decide, approach-and-strike) using this port's own collision/entity
// primitives, not a byte-exact transliteration of undecoded code. Where the real function names a
// specific mechanism this port doesn't have yet (Entity_DispatchHitReactionByKind's actual hit
// effects, Entity_RollRandomBehaviorIndex's real 0xeca4 probability table selection by +0x38),
// a documented, labeled simplification stands in.
//
// Entity_ThinkPatrolAI's 3-tile lookahead (docs/enemies.md) selects which table to read from:
// both of the "-1"/"-2" flags set -> Blocked; the "0" flag clear -> Clear; else -> Default. That
// selection, plus the actual per-frame move application (Entity_MoveHorizontalByFlags, applied
// by the class-2/4 post-dispatch step per docs/enemies.md, not inside the think function itself),
// lives in engine/entity-ai.js -- this module is just the opcode table + per-opcode reaction.

'use strict';

import { TILE_WIDTH } from './camera.js';
import { isSolidTile } from './collision.js';
import { GRID_SIZE } from '../core/pap.js';

// Transcribed verbatim from docs/enemies.md's "three per-animation-set script tables" dump
// (0xec68/0xec7c/0xec90), one character per animation-set index 0-19.
const CLEAR = ['n','o','o','o','o','s','p','r','n','o','s','r','n','o','o','t','p','r','n','o'];
const BLOCKED = ['n','o','o','o','o','s','q','n','o','o','s','n','o','o','o','q','n','o','o','o'];
const DEFAULT = ['s','o','o','o','o','s','o','o','o','o','s','o','o','o','o','t','o','o','o','o'];

/**
 * Entity_ThinkPatrolAI's 3-tile lookahead, adapted: the real version samples 3 ground/wall flags
 * from the level-map buffer via the swappable [0xef23] table (docs/enemies.md) to distinguish
 * "wall ahead" (Blocked) from "no floor ahead, about to walk off a ledge" (Clear) from "open
 * floor, keep going" (Default). This port's placeholder collision grid is far too sparse to
 * answer "is there floor here" for entities scattered across the real level's full (x,y) range
 * (docs/engine.md's `[0xef23]` note) -- feeding it directly into that 3-way split made every
 * animSet-0 entity (whose table row is 'n'/Blocked AND 'n'/Clear -- see the docs quote above)
 * flip direction almost every single frame in open space, netting near-zero visible movement.
 * So "blocked" here is primarily the entity's own patrol-window edge (entity-ai.js's
 * `ai.nearPatrolEdge`, a placeholder stand-in for real ground-extent detection) OR a genuine wall
 * hit within the authored placeholder geometry; this never reports "clear" (no ledge concept
 * without gravity for non-player entities in this port), so animSet-0 entities spend most of
 * their time in "Default" -> 's' (re-sense/chase), walking smoothly until an edge or wall, which
 * is what actually produces visible back-and-forth patrol motion.
 */
function sampleLookahead(ai, collisionGrid) {
  const row = Math.max(0, Math.min(GRID_SIZE - 1, Math.round(ai.y / 16)));
  const curCol = Math.floor(ai.x / TILE_WIDTH);
  const aheadCol = curCol + ai.facing;
  const wallAhead = isSolidTile(collisionGrid, aheadCol, row);
  if (wallAhead || ai.nearPatrolEdge) return 'blocked';
  return 'default';
}

function pickOpcode(ai, situation) {
  const table = situation === 'blocked' ? BLOCKED : situation === 'clear' ? CLEAR : DEFAULT;
  return table[ai.animSet] ?? 'o';
}

/** Documented as a per-entity-aggression 10-60% escalating chance table (0xeca4); no per-type aggression field ported yet, so this uses a fixed placeholder row (30%). */
function rollChance(rng) {
  return rng.next() % 10 < 3;
}

/**
 * Runs one movement-AI opcode for `ai` (an { x, y, facing, animSet, state, homeX, rangePx }
 * object -- see entity-ai.js) against the player's position and the (placeholder) collision
 * grid. Mutates `ai.facing`/`ai.state`; does NOT move `ai.x`/`ai.y` -- that's the separate
 * per-frame move-application step (mirroring the original's post-dispatch
 * Entity_MoveHorizontalByFlags call), done by entity-ai.js.
 */
export function tickMovementAi(ai, player, collisionGrid, rng) {
  const situation = sampleLookahead(ai, collisionGrid);
  const opcode = pickOpcode(ai, situation);
  ai.lastOpcode = opcode;

  switch (opcode) {
    case 'n': // turn-around/retreat
      ai.facing = -ai.facing;
      ai.state = 'patrol';
      break;
    case 'p': // scan ahead, maybe react
    case 'r': // lighter single-tile check-then-turn
      if (rollChance(rng)) ai.facing = -ai.facing;
      ai.state = 'patrol';
      break;
    case 'q': // scan behind, maybe react
      if (rollChance(rng)) ai.facing = -ai.facing;
      ai.state = 'patrol';
      break;
    case 's': { // acquire target and decide -- the chase/flee/patrol decision point
      const dx = player.x - ai.x;
      const dy = player.y - ai.y;
      const dist = Math.hypot(dx, dy);
      if (dist < ai.chaseRangePx) {
        ai.state = 'chase';
        ai.facing = dx >= 0 ? 1 : -1;
      } else {
        ai.state = 'patrol';
      }
      break;
    }
    case 't': { // approach and strike
      const dx = player.x - ai.x;
      const dist = Math.abs(dx);
      if (dist < ai.strikeRangePx) {
        ai.state = dist < ai.strikeRangePx / 3 ? 'strike' : 'chase';
        ai.facing = dx >= 0 ? 1 : -1;
      } else {
        ai.state = 'patrol';
      }
      break;
    }
    case 'o':
    default:
      break; // no-op / unrecognized -- stays on current facing/state
  }

  return { situation, opcode };
}
