// Minimal player entity: horizontal movement + gravity + jump against the tile collider
// (collision.js), a placeholder "break the block ahead" action on the fire button, and (Phase 5)
// health/damage/respawn + score. This is NOT a port of the original's player-specific ground
// response (Entity_ApplyComplexGroundResponse, docs/enemies.md -- a state machine keyed on
// scratch globals set by subsystems this port hasn't built: boss triggers, checkpoint states,
// carried-item tracking) or the real breakable-tile mechanic (Entity_BreakTileOrBounce) -- both
// still undecoded/unconfirmed at the byte level, or dependent on unported systems. Movement/
// damage/respawn constants below are placeholder feel-tuned values, not extracted from the
// disassembly.

'use strict';

import { moveAndCollide } from './collision.js';
import { TILE_WIDTH, TILE_HEIGHT } from './camera.js';
import { GRID_SIZE } from '../core/pap.js';

const GRAVITY = 0.5; // px/frame^2, placeholder
const MOVE_SPEED = 2.2; // px/frame, placeholder
const JUMP_VELOCITY = -7.5; // px/frame, placeholder
const MAX_FALL_SPEED = 8; // px/frame, placeholder
const MAX_HEALTH = 3;
const INVULN_FRAMES = 90; // ~1.5s at 60fps, placeholder
const KNOCKBACK_VX = 4;
const KNOCKBACK_VY = -5;

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

    this.spawnX = x;
    this.spawnY = y;
    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.invulnFrames = 0;
    this.score = 0;
    this.pickupsCollected = 0;
    this.deaths = 0;
    this.reachedExit = false;
  }

  update(input, pap) {
    this.lastBreak = null;
    if (this.invulnFrames > 0) this.invulnFrames--;

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

  /** Returns true if damage was actually applied (false during invulnerability). */
  takeDamage(fromX) {
    if (this.invulnFrames > 0 || this.reachedExit) return false;
    this.health--;
    this.invulnFrames = INVULN_FRAMES;
    const knockDir = this.x >= fromX ? 1 : -1;
    this.vx = knockDir * KNOCKBACK_VX;
    this.vy = KNOCKBACK_VY;
    if (this.health <= 0) this.respawn();
    return true;
  }

  respawn() {
    this.deaths++;
    this.health = this.maxHealth;
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.vx = 0;
    this.vy = 0;
    this.invulnFrames = INVULN_FRAMES;
  }

  collectPickup(value = 50) {
    this.score += value;
    this.pickupsCollected++;
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
      this.score += 10;
      this.lastBreak = { col, row };
    }
  }
}
