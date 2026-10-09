// 1000:45F8 Entity pair events: what happens when DFAC finds two entities' boxes overlapping. The
// pair-table value `cl` (row = first entity's kind, column = second's, table at 0xF36F) indexes a
// jump table; only the handlers the attract demo reaches are ported, the others record themselves
// in `ctx.unported`. Sound requests (1000:1CCF) write nothing this model compares yet and are
// skipped, marked where they occur.

'use strict';

import { pushSpawnEvent, pushEvent3, pushEvent5, pushEntityEvent } from './fire.js';
import { findByClass } from './ds-memory.js';

/** @returns {boolean} true when the original `pop ax; ret` abandons the whole interaction scan */
export function pairEvent(m, si, bx, cl, ctx) {
  const tag = `45F8 pair ${cl} class 0x${m.u16(si + 2).toString(16)}/0x${m.u16(bx + 2).toString(16)} kinds ${m.u16(si + 4)}/${m.u16(bx + 4)}`;
  if (cl === 5) { if (!playerTouchesProjectile(m, si, bx)) ctx.unported.add(tag); return false; }
  if (cl === 7) { if (!playerTouchesProp(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  if (cl === 4) { if (!weaponHitsEnemy(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  ctx.unported.add(tag);
  return false;
}

/** 1000:4C01. @returns {boolean} handled */
function playerTouchesProjectile(m, si, bx) {
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  const cls = m.u16(bx + 2);
  if (world === 1) return cls !== 0xd && cls !== 0x10; // 4C33: only classes 0xD and 0x10 do anything
  if (world === 2) return cls !== 0x33 && cls !== 0x34;
  if (world === 3) return cls !== 0x38 && cls !== 0x39;
  if (world === 4) return !(cls >= 0x3a && cls <= 0x3e);
  return true;
}

const PICKUP_STAY = [0x15, 0x40, 0x41, 0x43, 0x1a, 0x24, 0x2a, 0x45, 0x22, 0x29];

/** 1000:57D6: the player overlaps a kind-5 prop. @returns {boolean} handled */
function playerTouchesProp(m, si, bx, ctx) {
  const cls = m.u16(bx + 2);
  if (cls === 0xe) return crate(m, si, bx, ctx);
  if (cls === 0x1c || cls === 6 || cls === 0x1b || cls === 0x26 || cls === 0x56 || cls === 0x2e) return false;
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
  ax = Math.floor(ax / 2); // 596B: sound (ax + 0x28)
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
  return true;
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

/** 1000:4F27: a projectile (si, kind 7) hits an enemy (bx, kind 2). @returns {boolean} handled */
function weaponHitsEnemy(m, si, bx, ctx) {
  if (m.u8(bx + 0x40) === 0x65 || m.u8(si + 0x40) === 0x65 || m.u8(bx + 0x40) === 0x19 || m.u8(si + 0x40) === 0x19) return true;
  const target = m.u16(bx + 2);
  if (target === 0x2c || target === 0x42) return true;
  const cls = m.u16(si + 2);
  if (cls === 0x3f || cls === 0x14 || m.u16(si + 4) !== 7) return false;
  if (cls === 0x1d || cls === 0x27 || cls === 0x44) return false;
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  const base = { 1: 9, 2: 0x2f, 3: 0x34, 4: 0x39 }[world];
  if (base === undefined) return true;
  const dmg = (cls - base) & 0xffff;
  if (dmg === 5) return true;
  const hp = byte(m.u8(bx + 0x3f) - dmg);
  m.w8(bx + 0x3f, hp);
  if ((hp & 0x80) === 0) { kill(m, si); return hurt(m, bx, si, ctx); } // 4FC2 -> 50AE
  // 4FC9: the enemy's health ran out
  if (m.u8(bx + 0x39) === 0x41 || m.u8(bx + 0x40) === 0x40 || m.u8(bx + 0x39) === 0x15 || m.u8(bx + 0x40) === 0x43) return die(m, bx, ctx);
  if (target === 0x2b) return false; // 5033
  kill(m, si);
  if (dmg === 4) return false; // 52A0
  kill(m, si); // 4FFF
  m.w16(0x8b75, m.u16(0x8b75) + m.u8(bx + 0x36) + 1); // 5003: score
  return die(m, bx, ctx);
}

/** 1000:50AE: the enemy `bx` survives a hit from `si`. */
function hurt(m, bx, si, ctx) {
  const cls = m.u16(bx + 2);
  if (cls === 0x2b || cls === 0x23) return false;
  if (m.u16(bx + 0x2c) !== 0) return true; // 5263
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  if (world !== 1) return false;
  let al;
  if (cls === 0x13) al = 0x8a;
  else if (cls === 0x12) al = 0x94;
  else if (cls === 0x20) { if (m.u8(bx + 0x39) === 0x15) return spark(m, bx); al = 0x98; }
  else if (cls === 0x14) al = 0x88;
  else return spark(m, bx); // 523E
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
function bonus(m, ctx) {
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
