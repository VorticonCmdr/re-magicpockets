// 1000:45F8 Entity pair events: what happens when DFAC finds two entities' boxes overlapping. The
// pair-table value `cl` (row = first entity's kind, column = second's, table at 0xF36F) indexes a
// jump table; only the handlers the attract demo reaches are ported, the others record themselves
// in `ctx.unported`. Sound requests (1000:1CCF) write nothing this model compares yet and are
// skipped, marked where they occur.

'use strict';

import { pushSpawnEvent, pushEvent3, pushEvent5, pushEntityEvent } from './fire.js';
import { findByClass } from './ds-memory.js';
import { changeClass } from './script-runner.js';

/** @returns {boolean} true when the original `pop ax; ret` abandons the whole interaction scan */
export function pairEvent(m, si, bx, cl, ctx) {
  const tag = `45F8 pair ${cl} class 0x${m.u16(si + 2).toString(16)}/0x${m.u16(bx + 2).toString(16)} kinds ${m.u16(si + 4)}/${m.u16(bx + 4)}`;
  if (cl === 5) { if (!playerTouchesProjectile(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  if (cl === 7) { if (!playerTouchesProp(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  if (cl === 4) { if (!weaponHitsEnemy(m, si, bx, ctx)) ctx.unported.add(tag); return false; }
  ctx.unported.add(tag);
  return false;
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
  if (world === 2) return cls !== 0x33 && cls !== 0x34;
  if (world === 3) return cls !== 0x38 && cls !== 0x39;
  if (world === 4) return !(cls >= 0x3a && cls <= 0x3e);
  return true;
}

/** 1000:4CE0: the player touches a pushable crate (class 0xD): remember it, then the gating checks. */
function crateTouched(m, si, bx) {
  m.w16(0x8c01, bx);
  if (m.u8(bx + 0x26) !== 0 || m.u8(si + 0x26) !== 0) return true;
  if (m.u8(0x8b98) !== 0) return true; // 1 and every other non-zero value return alike
  if (m.u8(si + 1) !== 0) return true;
  return false; // 4D1C (the crate is pushed into the world entity) is not ported
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
export function weaponHitsEnemy(m, si, bx, ctx) {
  if (globalThis.process?.env?.MP_TRACE) console.error('HIT weapon', si.toString(16), 'cls', m.u16(si + 2), 'enemy', bx.toString(16), 'cls', m.u16(bx + 2), 'kind', m.u16(bx + 4), '+39', m.u8(bx + 0x39).toString(16), '+3f', m.u8(bx + 0x3f), '+40', m.u8(bx + 0x40).toString(16), 'wst40', m.u8(si + 0x40).toString(16));
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
  if (dmg === 4) return strongHit(m, si, bx, ctx); // 52A0
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
  if (world !== 1) { ctx.unported.add(`52A0 world ${world}`); return false; }
  m.w16(0x8c25, m.u16(si + 0x26));
  changeClass(m, si, 0x10);
  m.w16(si + 0x26, m.u16(0x8c25));
  m.w8(si + 0x3f, m.u16(0x8c27) & 0xff);
  m.w8(si + 0x3c, m.u16(0x8c23) & 0xff);
  m.w16(si + 0xa, m.u16(si + 0x10));
  return true;
}

const s16 = (v) => ((v & 0xffff) >= 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);

/** 1000:53A5: pop a score-style burst of events for the reward whose value is in [8C1F]. */
function scoreBurst(m, si, ctx) {
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
  if (m.u16(0x8b89) === 3 || m.u16(0x8b89) === 4) return false;
  if (m.u16(bx + 2) === 0x3e && m.u8(bx + 1) !== 0x5c) return true;
  m.w8(bx + 1, 0xc9); m.w16(bx + 0xc, 0xd4c7);
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
