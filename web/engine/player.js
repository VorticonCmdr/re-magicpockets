// Minimal player entity: horizontal movement + gravity + jump against the tile collider
// (collision.js), plus a placeholder "break the block ahead" action on the fire button. This is
// NOT a port of the original's player-specific ground response
// (Entity_ApplyComplexGroundResponse) or the real breakable-tile mechanic
// (Entity_BreakTileOrBounce, which negates a '<'-marked byte in the runtime column-major map
// buffer -- docs/enemies.md/docs/engine.md) -- both are still undecoded/unconfirmed at the byte
// level. Movement constants below are placeholder feel-tuned values, not extracted from the
// disassembly. Real player physics land in Phase 5 (docs/port-plan.md); this phase's job is only
// to prove the collision+break loop works end to end.

'use strict';

import { moveAndCollide } from './collision.js';
import { TILE_WIDTH, TILE_HEIGHT } from './camera.js';
import { GRID_SIZE } from '../core/pap.js';

const GRAVITY = 0.5; // px/frame^2, placeholder
const MOVE_SPEED = 2.2; // px/frame, placeholder
const JUMP_VELOCITY = -7.5; // px/frame, placeholder
const MAX_FALL_SPEED = 8; // px/frame, placeholder

export class Player {
  constructor(x, y, w = 20, h = 30) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.vx = 0;
    this.vy = 0;
    this.onGround = false;
    this.facing = 1; // +1 right, -1 left
    this.brokenCount = 0;
    this.lastBreak = null; // {col, row} the frame a block was broken, else null
    this._firePrev = false;
  }

  update(input, pap) {
    this.lastBreak = null;

    this.vx = input.left ? -MOVE_SPEED : input.right ? MOVE_SPEED : 0;
    if (this.vx !== 0) this.facing = Math.sign(this.vx);

    this.vy = Math.min(this.vy + GRAVITY, MAX_FALL_SPEED);
    if (input.up && this.onGround) this.vy = JUMP_VELOCITY;

    const flags = moveAndCollide(this, this.vx, this.vy, pap);
    this.onGround = flags.onGround;
    if (flags.onGround || flags.hitCeiling) this.vy = 0;
    if (flags.hitWall) this.vx = 0;

    const fireEdge = input.fire && !this._firePrev;
    this._firePrev = input.fire;
    if (fireEdge) this._tryBreakBlock(pap);
  }

  /** Placeholder block-break: removes the solid tile directly ahead, at chest height, if any. */
  _tryBreakBlock(pap) {
    const cx = this.x + this.w / 2 + this.facing * (this.w / 2 + TILE_WIDTH / 2);
    const cy = this.y + this.h / 2;
    const col = Math.floor(cx / TILE_WIDTH);
    const row = Math.floor(cy / TILE_HEIGHT);
    if (col < 0 || col >= GRID_SIZE || row < 0 || row >= GRID_SIZE) return;
    const idx = row * GRID_SIZE + col;
    if (pap.grid[idx] !== 0) {
      pap.grid[idx] = 0;
      this.brokenCount++;
      this.lastBreak = { col, row };
    }
  }
}
