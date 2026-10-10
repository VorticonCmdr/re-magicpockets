// 1000:45F8 Entity pair events: what happens when DFAC finds two entities' boxes overlapping. The
// pair-table value `cl` (row = first entity's kind, column = second's, table at 0xF36F) indexes a
// jump table; only the handlers the attract demo reaches are ported, the others record themselves
// in `ctx.unported`. Sound requests (1000:1CCF) write nothing this model compares yet and are
// skipped, marked where they occur.

'use strict';

import { pushSpawnEvent, pushEvent3, pushEvent5, pushEntityEvent } from './fire.js';
import { findByClass } from './ds-memory.js';
import { changeClass } from './script-runner.js';
import { crateGrab, freeSlot } from './entity-behavior.js';
import { levelListPointer, levelLoadEntities } from './spawn.js';
import { moveHorizontalByFlags, advanceAnimDir } from './enemy.js';
import { projectileRunsOut } from './ground-collision.js';

/** @returns {boolean} true when the original `pop ax; ret` abandons the whole interaction scan */
export function pairEvent(m, si, bx, cl, ctx) {
  const tag = `45F8 pair ${cl} class 0x${m.u16(si + 2).toString(16)}/0x${m.u16(bx + 2).toString(16)} kinds ${m.u16(si + 4)}/${m.u16(bx + 4)}`;
  if (cl === 2) { m.w8(si + 0x40, 0x19); return false; } // 5E18
  if (cl === 3) { m.w8(bx + 0x40, 0x19); return false; } // 5E1D
  if (cl === 10 || cl === 14) return false; // 57A2 is a RET
  if (cl === 11) { // 57A3
    if (m.u16(si + 2) === 6) { m.w16(bx + 0x14, m.u16(bx + 0x14) ^ 0xc); return false; }
    if (m.u8(bx + 0x39) !== 0x49) return false;
    if (m.u16(bx + 2) === 0x12) { m.w8(si + 0x40, 0xf6); m.w16(si + 0x2c, bx); return false; }
    if (m.u16(bx + 2) === 0x14) { m.w8(bx + 0x3d, 2); m.w8(si + 0x40, 0x19); return false; }
    m.w8(si + 0x40, 0x19);
    return false;
  }
  if (cl === 12 && m.u16(bx + 2) !== 0x25) m.w8(bx + 0x40, 0x19); // 462C falls into 4639
  if (cl === 1 || cl === 12) { if (!enemyTouchesPlayer(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  if (cl === 5) { if (!playerTouchesProjectile(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  if (cl === 7) { if (!playerTouchesProp(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  if (cl === 4) { if (!weaponHitsEnemy(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  ctx.unported.add(tag);
  return false;
}

/**
 * 1000:4D38 (world 2, class 0x33): a platform the hero can stand on. Carried or falling he is lifted onto it
 * (dx = 0x70 - its y, at most 0x10), otherwise it is remembered like a crate for the grab at 4CF6.
 * `si` is the hero, `bx` the platform.
 */
function platformTouched(m, si, bx) {
  const t = m.u8(0x8b98);
  if (t === 1) { // 4DCB
    const w = findByClass(m, 1);
    if (m.s8(w + 0x26) >= 0) return true;
    m.w8(0x8b98, 0);
  } else if (t !== 0x1a && t !== 0) return true;
  // 4D53
  if (m.s16(bx + 8) < 0x50) return true;
  const dx = (0x70 - m.s16(bx + 8)) | 0;
  if (dx > 0x10) return true;
  const world = findByClass(m, 1);
  if (m.u8(world + 1) !== 0) {
    if (m.s8(world + 0x26) < 0) { // 4D81: the rising world entity is set down on the platform
      m.w16(world + 8, m.u16(world + 8) + dx - m.s8(world + 0x26) - 2);
      m.w16(world + 0x26, 0); m.w8(world + 1, 0);
      m.w16(si + 0x10, 0x41); m.w16(si + 0x12, 0x48); m.w16(si + 0xa, 0x40);
      m.w16(0x8c38, 0); m.w8(si + 1, 0); m.w8(si + 0x3e, 0);
      m.w8(0x8beb, 0xff);
    }
  } else m.w8(0x8beb, 0xff); // 4DB5
  m.w16(0x8c01, bx);
  if (m.s8(si + 0x26) < 0) return true;
  return crateGrabTail(m, si); // 4CF6
}

/** 1000:4C01. @returns {boolean} handled */
function playerTouchesProjectile(m, si, bx, ctx) {
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  const cls = m.u16(bx + 2);
  if (world === 1) {
    if (cls === 0xd) return crateTouched(m, si, bx);
    if (cls === 0x10) return rewardTouched(m, si, bx, ctx);
    return true;
  }
  if (world === 2) { if (cls === 0x33) return platformTouched(m, si, bx); if (cls === 0x34) return rewardTouched(m, si, bx, ctx); return true; } // 4C20
  if (world === 3) { if (cls === 0x38) return crateTouched(m, si, bx); if (cls === 0x39) return rewardTouched(m, si, bx, ctx); return true; } // 4C68
  if (world === 4) {
    if (cls >= 0x3a && cls <= 0x3d) return stuckShotTouched(m, si, bx, ctx); // 4C78
    if (cls === 0x3e) return rewardTouched(m, si, bx, ctx); // 4C64
    return true;
  }
  return true;
}

/**
 * 1000:4C78 (world 4): the player walks into a shot that is stuck in the ground (state 0x9F): it takes the player's facing, is pushed
 * along while he walks into it (his side-blocked bits are set from its own) and, after a few ticks of that, either starts its
 * wobble states 0xA5-0xA7 (F15A) or runs out (EE60) once the count passes 4 x [8B90].
 */
function stuckShotTouched(m, si, bx, ctx) {
  if (m.u8(bx + 0x40) === 0x65 || m.u8(bx + 1) === 0x8d || m.u8(bx + 1) !== 0x9f) return true;
  m.w16(bx + 0x14, m.u16(si + 0x14));
  const ax = m.u16(bx + 0x24) & 0xc;
  m.w16(si + 0x24, m.u16(si + 0x24) | ax);
  if (ax !== 0) return true;
  moveHorizontalByFlags(m, bx, 4); // D5E2 with the shot as SI
  m.w8(bx + 0x3e, 0);
  advanceAnimDir(m, bx, 0);
  m.w16(bx + 0x2e, m.u16(bx + 0x2e) + 1);
  if (m.s16(bx + 0x2e) <= 5 || m.u8(bx + 1) === 0x8d) return true;
  if (m.u8(0x8b90) * 4 <= m.s16(bx + 0x2e)) { projectileRunsOut(m, bx, ctx); return true; }
  const to = { 0x3a: [0xa5, 0xd13b], 0x3b: [0xa6, 0xd142], 0x3c: [0xa7, 0xd149] }[m.u16(bx + 2)]; // F15A
  if (to && m.u8(bx + 1) !== to[0]) { m.w8(bx + 1, to[0]); m.w16(bx + 0xc, to[1]); m.w16(bx + 0x2e, 0); }
  return true;
}

/** 1000:4CE0: the player touches a pushable crate (class 0xD): remember it, then the gating checks. */
function crateTouched(m, si, bx) {
  m.w16(0x8c01, bx);
  if (m.u8(bx + 0x26) !== 0) return true;
  return crateGrabTail(m, si);
}

/** 1000:4CF6: the crate is grabbed by the world entity's script once the hero is on the ground and empty-handed. */
function crateGrabTail(m, si) {
  if (m.u8(si + 0x26) !== 0) return true;
  if (m.u8(0x8b98) !== 0) return true; // 1 and every other non-zero value return alike
  if (m.u8(si + 1) !== 0) return true;
  const world = findByClass(m, 1); // 4D1C: the crate is grabbed by the world entity's script
  if (m.u8(world + 1) === 0) crateGrab(m, world, findByClass(m, 3));
  return true;
}

const PICKUP_STAY = [0x15, 0x40, 0x41, 0x43, 0x1a, 0x24, 0x2a, 0x45, 0x22, 0x29];

/**
 * 1000:59B5: the hero stands in a world-1 doorway (frame 0x9E at the screen centre): the moving entities are cleared and the bonus
 * room's entity list (picked by the camera position) is loaded, the room's wall tiles opened. [STATIC: not yet checked against a capture]
 */
function bonusDoorway(m, ctx) {
  let di = 0x9090;
  for (;;) { // C961 removes every kind 2/4/5/6 entity (the array closes up behind each)
    const e = m.u16(di); di += 2;
    if (e === 0) break;
    const k = m.u16(e + 4);
    if (k === 2 || k === 6 || k === 4 || k === 5) { freeSlot(m, e); di -= 2; }
  }
  const cx = m.u16(0x8bbb), cy = m.u16(0x8bbd);
  let list, table;
  if (cx === 0xf800 && cy === 0xfc60) { list = 0xc; m.w16(0x8bb9, 0xa0); table = 0xf6ad; }
  else if (cx === 0xf190 && cy === 0xfc00) { list = 7; m.w8(0x7f47, 5); m.w8(0x7f48, 5); table = 0xf6c5; }
  else if (cx === 0xf8d0 && cy === 0xfa20) { list = 8; m.w8(0x61dc, 5); m.w8(0x625c, 5); table = 0xf6d7; }
  else if (cx === 0xfc20 && cy === 0xf970) { list = 9; table = 0xf6f5; }
  else if (cx === 0xfe30 && cy === 0xfb20) { list = 0xa; table = 0xf701; }
  else if (cx === 0xf930 && cy === 0xfb30) { list = 0xb; m.w8(0x6249, 5); m.w8(0x624a, 5); table = 0xf713; }
  else if (cx === 0xf740 && cy === 0xfe90) { list = 0xb; m.w16(0x8bb7, 0xfe10); m.w16(0x8bb9, 0x360); m.w8(0x6249, 5); m.w8(0x624a, 5); table = 0xf713; }
  else return;
  m.w16(0x8c63, table);
  levelLoadEntities(m, levelListPointer(m, list), ctx); // C1C0, C1E6
  for (let p = 0x9090; ; p += 2) { // CA2C: shift the moving entities by the scroll
    const e = m.u16(p);
    if (e === 0xffff) break;
    if (e === 0) continue;
    const k = m.u16(e + 4);
    if (k === 2 || k === 6 || k === 4 || k === 5) { m.w16(e + 6, m.u16(e + 6) + m.u16(0x8bb7)); m.w16(e + 8, m.u16(e + 8) + m.u16(0x8bb9)); }
  }
  if (m.u8(0x8b98) === 0x1a) m.w8(0x8b98, 0);
}

/** 1000:57D6: the player overlaps a kind-5 prop. @returns {boolean} handled */
function playerTouchesProp(m, si, bx, ctx) {
  const cls = m.u16(bx + 2);
  if (cls === 0xe) return crate(m, si, bx, ctx);
  if (cls === 0x26) return bonusItem(m, bx); // 5B26
  if (cls === 0x1b) return powerUp(m, si, bx, ctx);
  if (cls === 0x1c) return levelGoal(m, si, bx); // 5851
  if (cls === 6) { // 59A9: remember the prop's frame; the frame-0x9E doorway at the screen centre is not ported
    m.w8(0x8bb1, m.u16(bx + 0xa) & 0xff);
    if (m.u16(bx + 0xa) === 0x9e && m.u16(bx + 6) === 0x90 && m.u16(bx + 8) === 0x50) { bonusDoorway(m, ctx); return true; }
    return true;
  }
  if (cls === 0x56) { // 5B70: a clock pickup flips to its collected frame
    if (m.u16(bx + 0xa) === 0x99) return true;
    m.w16(bx + 0xa, 0x99); m.w8(bx + 1, 0x77); m.w16(bx + 0xc, 0xccc8);
    m.w8(0x8c0e, m.u8(0x8c0e) + 1);
    return true;
  }
  if (cls === 0x2e) { // 5B8B: time bonus (the seconds counter [8BAE] gains 15, 60 carry into the minutes [8BAF])
    m.w8(bx + 0x40, 0x19);
    m.w8(0x8bae, m.u8(0x8bae) + 0xf);
    if (m.s8(0x8bae) > 0x3c) { m.w8(0x8bae, m.u8(0x8bae) - 0x3c); m.w8(0x8baf, m.u8(0x8baf) + 1); }
    return true;
  }
  if (!PICKUP_STAY.includes(cls) && (m.u8(bx + 0x40) === 0xf6 || m.u8(bx + 0x3e) === 0)) return true; // 5850
  m.w16(0x8c01, bx); // 584C: remember the prop the player stands against
  return true;
}

/** 1000:58D5: the player hits a breakable crate (class 0xE). */
function crate(m, si, bx, ctx) {
  if (m.u8(bx + 0x3e) === 0) return true; // 596A
  if (m.u16(bx + 0x10) === 0x50) m.w16(bx + 0xa, 0x12);
  let ax = m.s16(bx + 0xa);
  if (ax >= 0x13) { // 58FE: smash it into pickups
    if (m.u8(bx + 1) === 1) return true;
    m.w8(bx + 1, 1);
    m.w16(bx + 0xc, 0xc45b);
    m.w16(0x8c29, 0xe); m.w16(0x8c1f, 0x12);
    m.w16(0x8c27, m.u16(bx + 6)); m.w16(0x8c25, m.u16(bx + 8));
    m.w16(0x8c23, m.u16(si + 0x14));
    for (const v of [0x15, 0x13, 0x14, 0x54]) {
      m.w16(0x8c21, v);
      m.w16(0x8c25, (m.u16(0x8c25) - 4) & 0xffff);
      pushSpawnEvent(m);
    }
    return true; // + sound 0xE
  }
  m.w16(0x8bf7, ax);
  ax = Math.floor(ax / 2);
  awardScore(m, bx, ax, ctx);
  return true;
}

/** 1000:596B: turn a touched pickup into a floating score of `ax` (sound ax+0x28 skipped). */
function awardScore(m, bx, ax, ctx) {
  if (m.u16(bx + 0x10) === 0x50) ax = 9;
  m.w16(bx + 0xa, ax);
  m.w16(bx + 0xa, m.u16(bx + 0xa) + 0x3c);
  ax += 1;
  const score = m.u16(0x8b75) + ax;
  m.w16(0x8b75, score);
  m.w16(bx + 4, 0);
  m.w8(bx + 0x3e, 0);
  m.w8(bx + 1, 0x87);
  m.w16(bx + 0xc, 0xcf21);
  // 599C: the generator's carry-in is the score addition's carry
  ctx.rng(m, score > 0xffff ? 1 : 0);
  m.w16(bx + 8, m.u16(bx + 8) - (m.u16(0x8b6b) & 7));
}

const byte = (v) => v & 0xff;
const kill = (m, e) => m.w8(e + 0x40, 0x19);

/** 1000:2F9E: set an entity's state byte and load the matching default script. */
function setScriptFromState(m, e, al) {
  m.w8(e + 1, al);
  const idx = al < 128 ? al : al - 0x80;
  m.w16(e + 0xc, m.u16((al < 128 ? 0xcd88 : 0xd996) + 2 * idx));
}

/** 1000:C192: the next record after `from` whose class is `cls` (0 when there is none). */
function findNextByClass(m, from, cls) {
  for (let bx = from + 0x42; bx < 0xb918; bx += 0x42) if (m.u16(bx + 2) === cls) return bx;
  return 0;
}

/** 1000:EE1F: a shot (class 0xD: a burst of debris; others: it turns into the class-0xF particle and keeps its speed). */
function shotBursts(m, shot) {
  if (m.u16(shot + 2) === 0xd) {
    m.w16(0x8c27, m.u16(shot + 6) + 8); m.w16(0x8c25, m.u16(shot + 8) + 8);
    particles(m); // 572A
    m.w8(shot + 0x40, 0x19);
    return;
  }
  if (m.s8(shot + 1) < 0) return;
  m.w16(0x8c1f, m.u16(shot + 0x26));
  changeClass(m, shot, 0xf);
  m.w16(shot + 0x26, m.u16(0x8c1f));
}

/** 1000:5033: a shot hits a class-0x2B object: it turns into the 0x29 state script with a score and debris. */
function breakBox(m, bx, ctx) {
  if (m.u16(0x8b89) === 4 && m.u16(0x8b8b) === 9) { ctx.unported.add('5033 -> 4FA3 world 4 sub-level 9'); return false; }
  m.w8(bx + 0x40, 0); m.w8(bx + 1, 0x29); m.w16(bx + 0xc, 0xc6ea);
  m.w16(0x8b75, m.u16(0x8b75) + 0x32);
  m.w16(0x8c27, m.u16(bx + 6) + 8); m.w16(0x8c25, m.u16(bx + 8) + 0x18);
  return particles(m); // 572A
}

/** 1000:4F27: a projectile (si, kind 7) hits an enemy (bx, kind 2). @returns {boolean} handled */
export function weaponHitsEnemy(m, si, bx, ctx) {
  if (m.u8(bx + 0x40) === 0x65 || m.u8(si + 0x40) === 0x65 || m.u8(bx + 0x40) === 0x19 || m.u8(si + 0x40) === 0x19) return true;
  const target = m.u16(bx + 2);
  if (target === 0x2c || target === 0x42) return true;
  const cls = m.u16(si + 2);
  const scoreOnly = () => { // 5092: a shot of another kind scores and takes one hit point
    m.w16(0x8b75, m.u16(0x8b75) + m.u8(bx + 0x36) + 1);
    kill(m, si);
    m.w8(bx + 0x3f, m.u8(bx + 0x3f) - 1);
    if (m.s8(bx + 0x3f) > 0) return hurt(m, bx, si, ctx, m.u8(bx + 0x36) + 1);
    return die(m, bx, ctx);
  };
  if (cls === 0x14 && m.u16(bx + 0xa) === 0xc) { // 5019 -> 5022
    if (m.u16(si + 4) !== 7) return true;
    shotBursts(m, si);
    return true;
  }
  if (cls !== 0x3f && m.u16(si + 4) !== 7) return scoreOnly();
  const score = () => { // 5003
    if (target === 0x2b) return breakBox(m, bx, ctx); // 5033
    m.w16(0x8b75, m.u16(0x8b75) + m.u8(bx + 0x36) + 1);
    return die(m, bx, ctx);
  };
  if (cls === 0x44 || cls === 0x3f) return score();
  if (cls === 0x27) { kill(m, si); return score(); } // 4FFF
  if (cls === 0x1d) { // 506F: the shot's own strength is spent on the enemy
    if (target === 0x2b) return breakBox(m, bx, ctx); // 506F -> 5033
    const al = (m.u8(si + 0x3f) + 1) & 0xff;
    const hp = byte(m.u8(bx + 0x3f) - al);
    m.w8(bx + 0x3f, hp);
    if ((hp & 0x80) === 0) return hurt(m, bx, si, ctx, al);
    return score();
  }
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  const base = { 1: 9, 2: 0x2f, 3: 0x34, 4: 0x39 }[world];
  if (base === undefined) return true;
  const dmg = (cls - base) & 0xffff;
  if (dmg === 5) return true;
  const hp = byte(m.u8(bx + 0x3f) - dmg);
  m.w8(bx + 0x3f, hp);
  if ((hp & 0x80) === 0) { kill(m, si); return hurt(m, bx, si, ctx, dmg); } // 4FC2 -> 50AE
  // 4FC9: the enemy's health ran out
  if (m.u8(bx + 0x39) === 0x41 || m.u8(bx + 0x40) === 0x40 || m.u8(bx + 0x39) === 0x15 || m.u8(bx + 0x40) === 0x43) return die(m, bx, ctx);
  if (target === 0x2b) return breakBox(m, bx, ctx); // 5033
  kill(m, si);
  if (dmg === 4) return strongHit(m, si, bx, ctx); // 52A0
  kill(m, si); // 4FFF
  m.w16(0x8b75, m.u16(0x8b75) + m.u8(bx + 0x36) + 1); // 5003: score
  return die(m, bx, ctx);
}

/** 1000:50AE: the enemy `bx` survives a hit from `si`. */
export function hurt(m, bx, si, ctx, ax = 0) {
  const cls = m.u16(bx + 2);
  if (cls === 0x2b) { m.w16(0x8c6b, (m.u16(0x8c6b) + ax * 5) & 0xffff); return true; } // 50E8: the damage is tallied (x5) in [8C6B]
  if (cls === 0x23) { // 51A6: the companion-bound enemy
    const link = m.u16(bx + 0x2c);
    if (m.u8(bx + 1) === 0x9a && link !== 0) { // the bound marker is released and the enemy takes the hit state
      m.w8(link + 0x40, 0x19); m.w16(bx + 0x2c, 0); m.w8(bx + 0x3e, 0);
      setScriptFromState(m, bx, 0x9b);
      return true;
    }
    if (m.u8(bx + 1) === 0x9b) return true; // 522A
    if (m.u8(bx + 1) !== 0) return spark(m, bx);
    setScriptFromState(m, bx, 0x9b);
    return true;
  }
  if (m.u16(bx + 0x2c) !== 0) return true; // 5263
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  let al;
  if (world === 1) {
    if (cls === 0x13) al = 0x8a;
    else if (cls === 0x12) al = 0x94;
    else if (cls === 0x20) { if (m.u8(bx + 0x39) === 0x15) return spark(m, bx); al = 0x98; }
    else if (cls === 0x14) al = 0x88;
    else return spark(m, bx); // 523E
  } else if (world === 2) { // 5122
    if (cls === 0x4b) { if (m.u8(bx + 0x40) === 0x67) return spark(m, bx); al = 0xcd; }
    else if (cls === 0x4a) al = 0xcf;
    else if (cls === 0x4c) al = 0xd3;
    else return spark(m, bx);
  } else if (world === 3) { // 5140
    const to = { 0x51: 0xe2, 0x50: 0xdb, 0x54: 0xe4 }[cls];
    if (to !== undefined) al = to;
    else if (cls === 0x4e || cls === 0x4f) { // 5264: a second spark event first
      al = cls === 0x4e ? 0xcf : 0xdf;
      m.w16(0x8c1f, 0x101); m.w16(0x8c21, 0x32); m.w16(0x8c23, 4); m.w16(0x8c29, 0x55);
      m.w16(0x8c25, (m.u16(bx + 8) + 8) & 0xffff); m.w16(0x8c27, (m.u16(bx + 6) + 8) & 0xffff);
      pushSpawnEvent(m); // + sound request 1CCF
    } else return spark(m, bx);
  } else { // 5170
    const to = { 0x57: 0xeb, 0x58: 0xee, 0x59: 0xe8, 0x5d: 0xf1, 0x5a: 0xfb }[cls];
    if (to === undefined) return spark(m, bx);
    al = to;
  }
  // 522A
  if (al === m.u8(bx + 1)) return true;
  if (m.u8(bx + 1) !== 0) return spark(m, bx);
  setScriptFromState(m, bx, al);
  return true;
}

/** 1000:523E: a hit spark event attached to the enemy (sound request skipped). */
function spark(m, enemy) {
  m.w16(0x8c29, 0x11);
  m.w16(0x8c27, m.u16(enemy + 6));
  m.w16(0x8c25, (m.u16(enemy + 8) - 8) & 0xffff);
  pushEntityEvent(m, enemy);
  return true;
}

/** 1000:549C: the enemy `bx` dies. */
function die(m, bx, ctx) {
  m.w8(0x8c06, m.u8(0x8c06) + 1);
  m.w8(0x8c05, m.u8(0x8c05) + 1);
  m.w8(bx + 1, 1); m.w16(bx + 0xc, 0xc45b);
  const link = m.u16(bx + 0x2c);
  if (link !== 0) { m.w8(link + 1, 1); m.w16(link + 0xc, 0xc45b); }
  // sound requests 1D4C(4) and 1D4C(0x45) write nothing this model compares yet
  const drop = m.u8(bx + 0x39) === 0x15 ? 0x15 : m.u8(bx + 0x40) === 0x40 ? 0x40 : m.u8(bx + 0x39) === 0x41 ? 0x41 : m.u8(bx + 0x40) === 0x43 ? 0x43 : 0;
  if (drop === 0 && m.u16(bx + 2) === 0x5b) { ctx.unported.add('549C class 0x5b drop (C0E6)'); return false; }
  if (drop !== 0) {
    m.w16(0x8c25, m.u16(bx + 8)); m.w16(0x8c27, m.u16(bx + 6)); m.w16(0x8c29, drop);
    pushEvent3(m);
  }
  m.w8(bx + 0x40, 0x65); // 54FA
  m.w16(0x8c27, m.u16(bx + 6) + 8); m.w16(0x8c25, m.u16(bx + 8) + 0x18);
  m.w16(0x8c29, 0xf); // 572A: four debris particles
  m.w16(0x8c21, 9);
  for (const [a, b] of [[9, 4], [9, 8], [8, 4], [8, 8]]) { m.w16(0x8c21, a); m.w16(0x8c23, b); pushEvent5(m); }
  // 5517: a random death sound (1CCF) is requested here
  if (m.u8(0x8b98) === 0x41) {
    m.w16(0x8c1f, 0x102); m.w16(0x8c21, 0x32); m.w16(0x8c23, 4); m.w16(0x8c29, 0x55);
    m.w16(0x8c25, m.u16(bx + 8) + 8); m.w16(0x8c27, m.u16(bx + 6) + 8);
    pushSpawnEvent(m);
  }
  return bonus(m, ctx);
}

/** 1000:5609: advance the kill-bonus meter shown in the HUD. */
export function bonus(m, ctx) {
  if (m.u16(0x8c6d) !== 0) return true;
  const queueOk = () => m.u16(0x8bb5) >= 0x926a;
  const setFrame = (bx) => { m.w16(bx + 0xa, m.u16(0x8c1f)); m.w8(bx + 0x3e, 0); };
  const next = (bx, from) => { const n = findNextByClass(m, from, 4); if (n !== 0) setFrame(n); };
  const s16 = (v) => ((v & 0xffff) >= 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);
  if (s16(m.u16(0x8b75) - m.u16(0x8b83)) >= 0x32) {
    m.w16(0x8c1f, (m.u8(0x8c05) % 10) + 0x14);
    const bx = findByClass(m, 0x19);
    if (m.u16(bx + 0xa) === 4) { // 56F6
      const hud = findByClass(m, 4);
      if (hud === 0) return true;
      if (m.u16(hud + 6) === 0x128) setFrame(hud); else next(hud, hud);
      return true;
    }
    for (const [a, v] of [[0x8c21, 0x79], [0x8c23, 0], [0x8c25, 0xa8], [0x8c27, 0x128], [0x8c29, 4]]) m.w16(a, v);
    pushSpawnEvent(m);
    if (queueOk()) m.w16(0x8c6d, 0xffff);
    return true;
  }
  let ax = m.u8(0x8c05) * 2 + (m.u16(0x8b8b) & 1);
  if (ax >= 0x12) ax = 0x56;
  m.w16(0x8c1f, ax);
  const target = findByClass(m, 0x18);
  if (m.u16(target + 6) === 0xffe0) { // 56D8
    const hud = findByClass(m, 4);
    if (hud === 0) return true;
    if (m.u16(hud + 6) === 8) setFrame(hud); else next(hud, hud);
    return true;
  }
  for (const [a, v] of [[0x8c21, 0x78], [0x8c23, 0], [0x8c25, 0xa8], [0x8c27, 8], [0x8c29, 4]]) m.w16(a, v);
  pushSpawnEvent(m);
  if (queueOk()) m.w16(0x8c6d, 0xffff);
  return true;
}

/** 1000:52A0: a damage-4 shot kills the enemy and turns itself into the reward object (class 0x10 in world 1). */
function strongHit(m, si, bx, ctx) {
  kill(m, bx);
  const link = m.u16(bx + 0x2c);
  if (link !== 0) kill(m, link);
  // sounds 1D4C(4), 1D4C(0x45) and 1CCF(0x25) are skipped
  m.w16(0x8c27, 0x100 | m.u8(0x8c05)); // AH is left at 1 by the sound request
  m.w16(0x8c23, m.u8(bx + 0x3c));
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  if (world < 1 || world > 4) { ctx.unported.add(`52A0 world ${world}`); return false; }
  m.w16(0x8c25, m.u16(si + 0x26));
  if (world === 3) m.w16(0x8c29, 0x39);
  changeClass(m, si, [0, 0x10, 0x34, 0x39, 0x3e][world]); // 52F2 / 52F7 / 5324 / 52FC: the shot becomes the world's reward object
  m.w16(si + 0x26, m.u16(0x8c25));
  m.w8(si + 0x3f, m.u16(0x8c27) & 0xff);
  m.w8(si + 0x3c, m.u16(0x8c23) & 0xff);
  if (world !== 3) { m.w16(si + 0xa, m.u16(si + 0x10)); return true; }
  const frame = { 0x4e: 0x33, 0x50: 0x35, 0x4f: 0x39, 0x51: 0x37, 0x54: 0x3b }[m.u16(bx + 2)]; // 5345..53A4: the frame depends on the enemy that died
  if (frame !== undefined) { m.w16(si + 0xa, frame); m.w16(si + 0x10, frame); m.w16(si + 0x12, frame); }
  return true;
}

const s16 = (v) => ((v & 0xffff) >= 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);

/** 1000:53A5: pop a score-style burst of events for the reward whose value is in [8C1F]. */
export function scoreBurst(m, si, ctx) {
  m.w16(0x8c29, 0xe);
  if (m.u16(0x8c1f) !== 0x12) m.w16(0x8c1f, m.u16(0x8c1f) + (m.u16(0x8b8b) & 1));
  ctx.rng(m, 0); // 11FC; CF is the compare/add carry, 0 here
  m.w16(0x8c27, m.u16(0x8c27) - (m.u16(0x8b6b) & 7));
  if (m.u8(0x8bb2) !== 0 && (m.u16(0x8c1f) === 0 || m.u16(0x8c1f) === 1)) { m.w16(0x8c29, 0x1b); m.w16(0x8c1f, 0x20); }
  const push = (a, b) => { m.w16(0x8c21, a); m.w16(0x8c23, b); pushSpawnEvent(m); };
  const tail = () => { push(0x15, 0); };
  const pair14 = () => { push(0x14, 4); push(0x14, 8); };
  if (m.u16(0x8c1d) === 0) { tail(); return; } // 5430
  push(0x13, 4); push(0x13, 8);
  const d = s16(m.u16(0x8c1d));
  if (d <= 0xe) return; // 545E
  if (d > 0x15) {
    if (d <= 0x1a) { pair14(); return; } // 5440 then 545E
    pair14();
  }
  if (m.u16(0x8c1f) === 0x10) { // 545F
    m.w16(0x8c29, 0x2c); m.w16(0x8c21, 0x15); m.w16(0x8c23, m.u16(si + 0x14));
    pushEvent5(m);
    return;
  }
  tail();
}

/** 1000:4DE2: the player touches a reward object (class 0x10, world 1 and 2). */
function rewardTouched(m, si, bx, ctx) {
  if (m.u8(bx + 0x40) === 0x65) return true;
  if (m.u16(0x8b89) === 3 || m.u16(0x8b89) === 4) { m.w8(bx + 1, 0x2b); m.w16(bx + 0xc, 0xc714); } // 4E19
  else {
    if (m.u16(bx + 2) === 0x3e && m.u8(bx + 1) !== 0x5c) return true;
    m.w8(bx + 1, 0xc9); m.w16(bx + 0xc, 0xd4c7);
  }
  m.w16(0x8c1f, m.s8(bx + 0x3f) & 0xffff);
  m.w8(bx + 0x40, 0x65);
  // 4E24: a random pickup sound (1CCF) is requested here
  m.w8(0x8c05, 0);
  m.w8(0x8c07, m.u8(0x8c07) + 1);
  m.w8(0x8c08, m.u8(0x8c08) + (m.u16(0x8c1f) & 0xff));
  m.w16(0x8c27, m.u16(bx + 6) + 8);
  m.w16(0x8c25, m.u16(bx + 8));
  if (m.u8(bx + 0x3c) !== 0) { // 4E95
    const al = Math.min(m.u8(bx + 0x3c), 10);
    m.w16(0x8c29, 0x1b); m.w16(0x8c1f, 0x13 + al);
    m.w16(0x8c21, 0x15); m.w16(0x8c23, 0);
    pushSpawnEvent(m);
    return particles(m);
  }
  const world = findByClass(m, 1);
  const sp = m.s8(world + 0x28);
  m.w16(0x8c1d, sp < 0 ? -sp : sp);
  if (s16(m.u16(0x8b75) - m.u16(0x8b83)) < 0x32) { // 4EC4
    if (s16(m.u16(0x8c1f)) >= 0xa) m.w16(0x8c1f, 9);
    m.w16(0x8c1f, (m.u16(0x8c1f) << 1) & 0x1e);
    scoreBurst(m, si, ctx);
    if (m.u8(0x8b98) === 0x41) {
      m.w16(0x8c1f, 0xff); m.w16(0x8c21, 0x32); m.w16(0x8c23, 4); m.w16(0x8c29, 0x55);
      pushSpawnEvent(m);
    }
    return true;
  }
  m.w16(0x8b83, m.u16(0x8b83) + 0x32); // 4F07
  let dx = m.u16(0x8c1f);
  if (s16(dx) >= 0xa) dx = m.u16(0x8c1f) % 10;
  m.w16(0x8c1f, (dx * 2) & 0x1e);
  // 5475: the value halved (DIV DL leaves the remainder in AH), then the particles
  const ax = m.u16(0x8c1f);
  m.w16(0x8c29, 0x1b);
  m.w16(0x8c1f, (((ax % 2) << 8) | Math.floor(ax / 2)) + 0x14);
  m.w16(0x8c21, 0x15); m.w16(0x8c23, 0);
  pushSpawnEvent(m);
  return particles(m);
}

/** 1000:572A: four debris particles at the position in 8C25/8C27. */
function particles(m) {
  m.w16(0x8c29, 0xf);
  for (const [a, b] of [[9, 4], [9, 8], [8, 4], [8, 8]]) { m.w16(0x8c21, a); m.w16(0x8c23, b); pushEvent5(m); }
  return true;
}

/** 1000:5BAD: the player touches a class-0x1B power-up; its frame says which one (sounds skipped). */
function powerUp(m, si, bx, ctx) {
  if (m.u8(bx + 0x3e) === 0) return true;
  const frame = m.u16(bx + 0xa);
  if (frame === 0x16) { // 5C23
    if (m.u8(0x8c04) !== 0) return true;
    m.w8(bx + 0x40, 0x19); m.w8(0x8c04, 0xe);
    return true;
  }
  const maxed = () => { awardScore(m, bx, m.u16(bx + 0xa) - 0x14, ctx); return true; }; // 5D6A
  if (frame === 0x1b) { // 5C5E
    if (m.u8(0x8bb2) === 3) return maxed();
    m.w8(0x8bb2, m.u8(0x8bb2) + 1); m.w8(bx + 0x40, 0x19);
    return true;
  }
  if (frame === 0x1a) { // 5C74
    if (m.u16(0x8b89) !== 3 && m.u8(0x8c03) !== 0) return maxed();
    m.w8(0x8c03, m.u8(0x8c03) + 5); m.w8(bx + 0x40, 0x19);
    return true;
  }
  if (frame === 0x19) { // 5D47
    if (m.u8(0x8b93) === 3) return maxed();
    m.w8(0x8b93, 3); m.w8(bx + 0x40, 0x19);
    return true;
  }
  if (frame === 0x18) { // 5D30
    if (m.u8(0x8b90) === 2) return maxed();
    m.w8(0x8b90, 2); m.w8(bx + 0x40, 0x19);
    return true;
  }
  if (frame === 0x14) { // 5C36
    if (m.u16(0x8bff) === 6) return maxed();
    m.w16(0x8bff, m.u16(0x8bff) + 1);
    m.w8(bx + 0x40, 0x19);
    return true;
  }
  if (frame === 0x20) { m.w16(bx + 0xa, m.u16(0x8b6b) & 0xf); return crate(m, si, bx, ctx); } // 5D5E -> 58D5
  if (frame === 0x1d) { // 5C4C
    if (m.u8(bx + 1) !== 0x28) { m.w8(bx + 1, 0x28); m.w16(bx + 0xc, 0xc6e5); }
    return true;
  }
  if (frame === 0x15 || frame === 0x1c) { // 5CC6 / 5CAC: a life icon
    const icon = findByClass(m, 0x18);
    if (m.u16(icon + 0xa) === 0x7f) return maxed();
    m.w16(icon + 0xa, frame === 0x15 ? m.u16(icon + 0xa) + 1 : 0x7f);
    m.w8(bx + 0x40, 0x19);
    return true;
  }
  if (frame === 0x17) { // 5CE3: the bonus meter reward
    m.w8(bx + 0x40, 0x19);
    const units = m.u8(0x8c05) % 10;
    m.w8(0x8c05, 0);
    m.w16(0x8c1f, units * 2);
    if (m.u8(0x8bb2) !== 0) m.w16(0x8c1f, 0xfffe + (m.u16(0x8b8b) & 1));
    m.w16(0x8c21, 0); m.w16(0x8c29, 0xe);
    return burst5DBA(m, bx, ctx);
  }
  if (frame === 0x1f) { // 5C96
    if (m.u8(0x8c04) !== 0) return true;
    m.w8(0x8c04, 0x1b); m.w8(bx + 0x40, 0x19); m.w8(0x8c0a, m.u8(0x8c0a) + 1);
    return true;
  }
  if (frame === 0x66) { m.w8(0x8c0b, m.u8(0x8c0b) + 1); m.w8(bx + 0x40, 0x19); return true; } // 5D73: an extra continue
  if (frame === 0x1e) { m.w16(0x8c5f, 0x90); m.w16(0x8c61, 0x50); m.w8(bx + 0x40, 0x19); return true; } // 5D84
  if (frame === 0x67) { m.w8(0x8ba4, 1); m.w8(bx + 0x40, 0x19); return true; } // 5D9C
  return true; // 5C22: any other frame does nothing
}

/** 1000:5DBA: scan the 10 tiles above the player and push a spawn event for each empty one (the reward shower). */
function burst5DBA(m, bx, ctx) {
  // 5DBA: ten reward events down the screen column left of the scroll, one per open cell (the clamp bit of the tile class is 0)
  const table = m.u16(0xef23);
  let di = (m.u16(0x8c13) - 1) & 0xffff;
  m.w16(0x8c23, 0);
  m.w16(0x8c25, (m.u16(0x8c17) - 0x10) & 0xffff);
  m.w16(0x8c27, (m.u16(0x8c15) + 8) & 0xffff);
  for (let cx = 0; cx < 10; cx++) {
    if ((m.u8(table + m.u8(di)) & 1) === 0) {
      if (m.u8(0x8bb2) !== 0 && m.u16(0x8c29) === 0xe) m.w16(0x8c1f, m.u16(0x8c1f) + 2);
      pushSpawnEvent(m);
    }
    m.w16(0x8c27, (m.u16(0x8c27) + 0x20) & 0xffff);
    di = (di + 0x80) & 0xffff;
  }
  return true;
}

/**
 * 1000:4A8D: the last heart is gone. The hero drops to its dying frame, the clock entity (class 7) starts
 * its game-over script, a life is used up and a message is queued. The sound call (1D4C) touches only
 * the sound driver's own state.
 */
export function gameOverBody(m) {
  const hero = findByClass(m, 3);
  m.w16(hero + 0xa, 0x4d); m.w16(0x8c38, 0); m.w16(hero + 0x24, 0); m.w8(hero + 1, 0);
  m.w8(0x8b5f, 1); m.w8(0x8b98, 0xff);
  const clock = findByClass(m, 7);
  if (m.u8(clock + 1) === 0x43) return; // 4AC1: already running
  m.w8(clock + 0x3e, 0); m.w8(clock + 1, 0x43); m.w16(clock + 0xc, 0xc8dd);
  m.w8(0x8c0b, (m.u8(0x8c0b) - 1) & 0xff);
  if (m.u8(0x8c0b) === 0) return; // 4B56: no lives left
  // 4BD1: the lives counter digit, then a message chosen from the player's record
  m.w8(0xe24d, (m.u8(0x8c0b) + 0xbc) & 0xff);
  const put = (a, b, c, d, e, f) => { m.w16(0x8c1f, a); m.w16(0x8c21, b); m.w16(0x8c23, c); m.w16(0x8c25, d); m.w16(0x8c27, e); m.w16(0x8c29, f); pushSpawnEvent(m); };
  put(0x2d, 0x52, 4, 0x88, 0x28, 0x2d);
  const s8 = (v) => (v & 0x80 ? (v & 0xff) - 0x100 : v & 0xff), s16 = (v) => (v & 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);
  const world = m.u16(0x8b89);
  let msg;
  const byScoreThenHearts = () => (m.u16(0x8b75) > 0xc8 ? 0x38 : (s8(m.u8(0x8c05)) > 0x1e ? 0x39 : 0x37)); // 4B1F
  const generic = () => { // 4B38
    if (s8(m.u8(0x8c09)) >= 1) return 0x3f;
    if (s8(m.u8(0x8bb2)) >= 1) return 0x36;
    if (s16(m.u16(0x8bff)) >= 2) return 0x35;
    return s8(m.u8(0x8c05)) > 0x1e ? 0x39 : 0x37;
  };
  if (world === 1) {
    if (s8(m.u8(0x8bb3)) <= 3) msg = 0x3a;
    else if (s8(m.u8(0x8c07)) > 0xa) msg = 0x3b;
    else if (s8(m.u8(0x8c07)) <= 3) msg = 0x3d;
    else {
      const q = Math.floor(m.u8(0x8c07) / m.u8(0x8c08)), r = m.u8(0x8c07) % m.u8(0x8c08);
      msg = ((r << 8) | q) < 3 ? 0x3c : byScoreThenHearts();
    }
  } else if (world === 2) msg = m.u16(0x8b75) > 0x190 ? 0x38 : generic();
  else msg = generic();
  put(msg, 0x66, 4, 0x20, 0x155, 0x2d);
}

/** 1000:4A50: the hero is hit while already in a reaction: a spark, and one heart-bar frame is used up. */
export function heroLosesHeart(m, si, ctx) {
  m.w16(0x8c29, 0x11);
  m.w16(0x8c27, m.u16(si + 6));
  m.w16(0x8c25, (m.u16(si + 8) - 8) & 0xffff);
  pushEntityEvent(m, si);
  m.w8(0x8bb4, m.u8(0x8bb4) + 1);
  m.w8(0x8b96, 0x32);
  const bar = findByClass(m, 0x18);
  if (m.u16(bar + 0xa) === 0x7b) { gameOverBody(m); return true; } // 4A8C
  m.w16(bar + 0xa, m.u16(bar + 0xa) - 1);
  return true;
}

/** 1000:49A8: the hero touches a class-0x2B object: he is whisked back to the centre of the screen in state 0x2F and the counters reset. */
function levelPortal(m, si, bx, ctx) {
  if (m.u8(si + 1) === 0x2f || m.u8(si + 1) !== 0) return true;
  const t = m.u8(0x8b98);
  if (t === 0x43 || t === 0x21) return true;
  const world = findByClass(m, 1);
  if (m.u8(world + 1) !== 0) return true;
  m.w16(world + 0x24, 0x8f);
  if (m.u16(0x8b89) === 4 && m.u16(0x8b8b) === 9) { ctx.unported.add('49A8 -> 4A8D world 4 sub-level 9'); return false; }
  m.w8(bx + 1, 0); m.w16(bx + 6, 0x90); m.w16(bx + 8, 0x50); m.w16(bx + 0xa, 0); m.w16(bx + 0x10, 0); m.w16(bx + 0x12, 0);
  m.w8(0x8b96, 0x28);
  m.w8(si + 1, 0x2f); m.w16(si + 0xc, 0xc79f);
  m.w8(0x8c03, 0); m.w16(0x8bf1, 0); m.w16(0x8bff, 0); m.w8(0x8bb2, 0); m.w8(0x8b93, 1); m.w8(0x8b90, 6);
  return true;
}

/** 1000:4639: an enemy (bx, kind 2) overlaps the player (si). @returns {boolean} handled */
function enemyTouchesPlayer(m, si, bx, ctx) {
  if (m.u8(bx + 0x40) === 0x65) return true;
  const cls = m.u16(bx + 2);
  if (cls === 0x2c) { // 47B2: a coin-like pickup bursts into a reward
    if (m.u8(bx + 1) !== 0) return true;
    m.w16(0x8c1f, 0x12); m.w16(0x8c1d, 0x20); m.w8(bx + 0x40, 0x19);
    m.w16(0x8c27, m.u16(bx + 6)); m.w16(0x8c25, m.u16(bx + 8));
    scoreBurst(m, si, ctx); // 53A5 (+ sound 1CCF(0x52))
    return true;
  }
  if (cls === 0x2b) return levelPortal(m, si, bx, ctx); // 49A8
  if (m.u8(0x8c04) === 0x40) return false;
  if (cls === 0x53 && m.u16(bx + 0xa) === 0x104) return false;
  if (m.u8(0x8b96) !== 0 || m.u16(si + 0xa) === 0x4c) return true;
  const t = m.u8(0x8b98);
  if (t === 0xff) return true;
  if (t === 0x21 || t === 0x41) return heroLosesHeart(m, si, ctx); // 4A50
  if (t === 0x15 || t === 0x43 || t === 0x1a) return false;
  if (t === 1 || t === 3) { // 4725: carrying a crate or in the hit state, the player kills what he touches
    if (cls === 0x2b || cls === 0x42 || m.u16(bx + 4) === 6 || m.u8(bx + 0x40) === 0x19) return true;
    m.w16(0x8b75, m.u16(0x8b75) + m.u8(bx + 0x36) + 1);
    return die(m, bx, ctx);
  }
  // 46B6: the player is hurt; the world entity and the player enter their knock-back states
  const world = findByClass(m, 1);
  if ((m.u8(world + 1) !== 0 || m.u8(si + 1) !== 0) && m.u8(si + 1) !== 0x5d) return heroLosesHeart(m, si, ctx); // 471B -> 4A50
  m.w16(si + 0x14, m.u16(bx + 0x14));
  if (m.u16(bx + 4) !== 6 && m.u16(bx + 2) !== 0x42) m.w16(si + 0x14, m.u16(si + 0x14) ^ 0xc);
  m.w8(world + 1, 0x44); m.w16(world + 0xc, 0xc92c);
  m.w8(0x8b96, 0x3c); m.w8(0x8b98, 3);
  m.w8(si + 1, 0x45); m.w16(si + 0xc, 0xc94d);
  m.w16(si + 0x30, 0); m.w16(world + 0x30, 0);
  m.w8(world + 0x3e, 0); m.w8(si + 0x3e, 0);
  m.w16(si + 0x10, 0x41); m.w16(si + 0x12, 0x48);
  return true;
}

/** 1000:5B26: a floating-point bonus (frames 0xB8, 0xB9, 0xBA = 50, 100, 200 points). */
function bonusItem(m, bx) {
  if (m.u8(bx + 1) !== 0) return true;
  const f = m.u16(bx + 0xa);
  const award = (pts, state, script) => { m.w16(0x8b75, m.u16(0x8b75) + pts); m.w8(bx + 1, state); m.w16(bx + 0xc, script); };
  if (f === 0xb8) award(0x32, 0x29, 0xc6ea);
  else if (f === 0xb9) award(0x64, 0x21, 0xc6a0);
  else if (f === 0xba) award(0xc8, 0x5e, 0xcb09);
  return true;
}

/** 1000:5851: the player reaches the level's goal prop (class 0x1C): freeze the level and start the finale. */
function levelGoal(m, si, bx) {
  m.w8(bx + 0x3e, 0x1d);
  if (m.u8(si + 1) !== 0) return true;
  if (m.u16(si + 8) !== m.u16(bx + 8)) return true;
  let ax = m.u16(si + 6);
  const hit = ax === m.u16(bx + 6) || ((ax - 4) & 0xffff) === m.u16(bx + 6) || ((ax - 8) & 0xffff) === m.u16(bx + 6) ||
    (m.u8(0x8b98) === 0x15 && (((ax - 8 + 0xc) & 0xffff) === m.u16(bx + 6) || ((ax - 8 + 0x10) & 0xffff) === m.u16(bx + 6)));
  if (!hit) return true;
  m.w8(0x8b5f, 1);
  m.w8(si + 0x3e, 0);
  m.w8(si + 0x40, 0x65); m.w8(bx + 0x40, 0x65);
  m.w8(si + 1, 0x47); m.w16(si + 0xc, 0xc967);
  m.w16(0x8c2f, m.u16(0x8c2d));
  m.w8(findByClass(m, 1) + 1, 0);
  const flag = findByClass(m, 0x2b);
  if (flag !== 0) { m.w8(flag + 0x40, 0x19); m.w16(flag + 4, 0); }
  return true;
}
