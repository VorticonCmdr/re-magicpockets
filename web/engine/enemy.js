// Kind-2 enemy behavior (Entity_UpdateBehavior's branch at 1000:CE0B) and the movement-AI core it
// calls, transliterated over a DsMemory image. Only class 0x13 in world 1 is ported so far; every
// other branch records itself in `ctx.unported`.
//
// The AI picks one of three per-animation-set opcode tables (0xEC68 floor ahead, 0xEC7C wall
// ahead, 0xEC90 no floor ahead), indexed by the entity's animation set [+0x39], and interprets
// opcode bytes 0x6E..0x74 ('n', 'p'..'t'); most of the code is the handlers of those opcodes.

'use strict';

import { findByClass } from './ds-memory.js';
import { terrainCollision } from './ground-collision.js';
import { interactions } from './entity-behavior.js';

const AI_TABLES = { floor: 0xec68, wall: 0xec7c, ledge: 0xec90 };

function moveHorizontalByFlags(m, si, ax) { // 1000:D5E2
  const dx = m.u16(si + 0x24);
  if (m.u16(si + 0x14) === 4) { if ((dx & 4) === 0) m.w16(si + 6, m.u16(si + 6) - ax); return; }
  if ((dx & 8) === 0) m.w16(si + 6, m.u16(si + 6) + ax);
}

function advanceAnim(m, si, al) { // 1000:3178
  if (m.s8(si + 0x3b) < al) { m.w8(si + 0x3b, m.u8(si + 0x3b) + 1); return; }
  m.w8(si + 0x3b, 0);
  m.w16(si + 0xa, m.u16(si + 0xa) === m.u16(si + 0x12) ? m.u16(si + 0x10) : m.u16(si + 0xa) + 1);
}

/** 1000:677C: start an action (a hop with horizontal speed) chosen by class; `dx` is the caller's DX. */
function startAction(m, si, dx, ctx) {
  m.w8(si + 0x27, ((dx & 0xff) + 1) * 2);
  m.w8(si + 0x26, 7);
  const cls = m.u16(si + 2);
  const set = (state, script) => { m.w8(si + 1, state); m.w16(si + 0xc, script); };
  if (cls === 0x2c) { set(0x15, 0xc625); return; } // 6C4C
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  if (world !== 1) { ctx.unported.add(`AI action 677C world ${world}`); return; }
  if (cls === 0x13) set(0x83, 0xced5); // 6C2E
  else if (cls === 0x23) set(0x99, 0xd08d); // 6C42
  else if (cls === 0x20) set(0x97, 0xd062); // 6C38
  else if (cls === 0x14) ctx.unported.add('AI action 677C class 0x14 (jumps into the opcode loop)');
}

/** 1000:71D5 Entity_RollRandomBehaviorIndex. The generator is called with CF = 0 here. */
export function rollRandom(m, si, ctx) {
  if (m.u8(0x8ba4) !== 0 || m.u8(0x8ba3) !== 0) { m.w16(0x8be5, 1); return; }
  ctx.rng(m, 0); // call 11FC
  const bl = m.u8(si + 0x38);
  const prod = 9 * bl;
  let b = prod & 0xff;
  b = (b + (m.u8(0x8b6b) & 7)) & 0xff;
  b = (b + (m.u8(0x8b6c) & 1)) & 0xff;
  m.w16(0x8be5, (((prod >> 8) & 0xff) << 8) | m.u8(0xeca4 + b));
}

/** 1000:6C56: reverse direction and mark that side as blocked. */
function turnAround(m, si) {
  m.w16(si + 0x14, m.u16(si + 0x14) ^ 0xc);
  m.w16(si + 0x24, m.u16(si + 0x24) | m.u16(si + 0x14));
}

/** 1000:6B13: the AI wants to turn (hit a ledge or wall, or rolled to). */
function aiTurn(m, si, di, ctx) {
  const e9 = m.u8(0x8be9);
  if (e9 === 0) {
    if (m.u8(di - 2) !== 0x71) {
      if (m.u16(si + 2) === 0x42) { turnAround(m, si); return; }
      if (m.u8(si + 0x39) === 5 && (m.u16(0x8c2b) & 2) !== 0) { ctx.unported.add('AI 6B5F'); return; }
    }
    const cls = m.u16(si + 2);
    if (cls === 0x2c) { ctx.unported.add('AI 6C80 class 0x2c'); return; }
    let w = m.u16(0x8b89);
    if (w === 0) w = m.u16(0x8b8b);
    if (w === 1 && cls === 0x14) { m.w8(si + 1, 0x85); m.w16(si + 0xc, 0xcf07); return; } // 6C61
    if (w >= 1 && w <= 4) turnAround(m, si);
    return;
  }
  if (e9 < 128) { m.w16(si + 0x24, m.u16(si + 0x24) & (m.u16(si + 0x14) ^ 0xffff)); return; } // 6B9D
  const set = m.u8(si + 0x39);
  if (set === 5 || set === 0xf) ctx.unported.add('AI 6B90 set 5/0xf');
}

/** 1000:5F14 (the decision core) up to the opcode loop at 6320. */
function aiDecide(m, si, ctx) {
  let di = m.u16(0x8bd7);
  di = (m.u16(si + 0x14) === 4 ? di - 0x80 : di + 0x80) & 0xffff; // 7319
  const ef = m.u16(0xef23);
  const set = m.u8(si + 0x39);
  let table;
  if (m.u8(ef + m.u8(di - 1)) !== 0 || m.u8(ef + m.u8(di - 2)) !== 0) table = AI_TABLES.wall;
  else if (m.u8(ef + m.u8(di)) === 0) table = AI_TABLES.floor;
  else table = AI_TABLES.ledge;
  m.w16(0x8c77, (table + set) & 0xffff);
  aiOpcodes(m, si, ctx);
}

/** 1000:6320: run AI opcodes through the pointer in [8C77] until one ends the decision. */
function aiOpcodes(m, si, ctx) {
  for (let guard = 0; guard < 32; guard++) {
    let di = m.u16(0x8c77);
    const op = m.u8(di);
    di += 1;
    m.w16(0x8c77, di);
    if (op === 0x6e) { // 6350
      const set = m.u8(si + 0x39);
      if (set === 0 || set === 0xa || m.u8(di - 2) === 0x71) { aiTurn(m, si, di, ctx); return; }
      rollRandom(m, si, ctx);
      if (m.u16(0x8be5) !== 0) aiTurn(m, si, di, ctx);
      return;
    }
    if (op === 0x73) { // 648E: scan-then-react
      m.w16(0x8c2b, 0);
      const cls = m.u16(si + 2), set = m.u8(si + 0x39);
      if (cls === 0x2c || set === 5 || set === 0xa || (cls === 0x14 && set === 0)) { ctx.unported.add(`AI opcode 's' class 0x${cls.toString(16)} set ${set}`); return; }
      continue; // 6555 -> 6320
    }
    const names = { 0x70: 'p', 0x71: 'q', 0x72: 'r', 0x74: 't' };
    if (names[op]) ctx.unported.add(`AI opcode '${names[op]}'`); // any other byte (0x6F, ...) ends the decision
    return;
  }
}

/** 1000:5F56 world 1, class 0x13. */
function thinkClass13(m, si, ctx) {
  if (m.u16(0x8bc7) !== 0 || m.u8(si + 1) !== 0) return;
  aiDecide(m, si, ctx);
}

/** 1000:6027: the class-0x20 step with a ramping speed [+0x2A]. */
function rampedStep(m, si, ax) {
  if (ax === 0) return;
  const cx = m.u16(si + 0x24) ^ 0xff;
  if ((m.u16(si + 0x14) & cx) === 0) { m.w16(si + 0x2a, 0); return; } // 605F
  if (m.u16(si + 0x14) === 4) m.w16(si + 6, m.u16(si + 6) - ax); else m.w16(si + 6, m.u16(si + 6) + ax);
  if (m.u8(si + 1) !== 0) return;
  const al = -(ax - 0xc);
  advanceAnim(m, si, Math.floor((al & 0xffff) / 4));
}

/** 1000:5F66 world 1, class 0x14. */
function thinkClass14(m, si, ctx) {
  if (m.u8(si + 1) === 0) { if (m.u16(0x8bc7) === 0) aiDecide(m, si, ctx); return; }
  if (m.u16(si + 0xa) !== 0xc) return;
  m.w8(si + 0x2e, m.u8(si + 0x2e) + 1);
  if (m.u8(si + 0x2e) !== 0xa) return;
  m.w16(si + 0x2e, 0);
  rollRandom(m, si, ctx);
  if (m.u16(0x8be5) === 0) return;
  m.w8(si + 1, 0x89); m.w16(si + 0xc, 0xcf58);
}

/** 1000:5FA9 world 1, class 0x20. */
function thinkClass20(m, si, ctx) {
  if (m.u8(si + 0x39) !== 0x15) {
    if (m.u16(0x8bc7) === 0 && m.u8(si + 1) === 0) aiDecide(m, si, ctx);
    return;
  }
  let di = m.u16(0x8bd7);
  di = (m.u16(si + 0x14) === 4 ? di - 0x80 : di + 0x80) & 0xffff;
  rollRandom(m, si, ctx);
  if (m.u16(0x8be5) !== 0) { if (m.u16(si + 0x2a) !== 0xc) m.w16(si + 0x2a, m.u16(si + 0x2a) + 2); }
  else if (m.u16(si + 0x2a) !== 0) m.w16(si + 0x2a, m.u16(si + 0x2a) - 2);
  rampedStep(m, si, m.u16(si + 0x2a));
  const ef = m.u16(0xef23);
  if (m.u8(ef + m.u8(di)) !== 0) {
    if (m.u8(ef + m.u8(di - 1)) === 0) return; // 5FBF
    if (m.u16(0x8b8b) === 6 && m.u16(si + 0x14) !== 4) { m.w16(0x8c2d, m.u16(0x8c2d) + 1); m.w8(si + 0x40, 0x19); return; }
  }
  m.w16(si + 0x14, m.u16(si + 0x14) ^ 0xc);
}

/** 1000:5E22 Entity_DispatchUpdateByKind (world 1 only for now). */
function thinkByWorld(m, si, ctx) {
  let w = m.u16(0x8b89);
  if (w === 0) w = m.u16(0x8b8b);
  const cls = m.u16(si + 2);
  if (w === 1) {
    if (cls === 0x13) { thinkClass13(m, si, ctx); return; }
    if (cls === 0x14) { thinkClass14(m, si, ctx); return; }
    if (cls === 0x20) { thinkClass20(m, si, ctx); return; }
    if (cls === 0x23) { if (m.u8(si + 1) === 0) aiDecide(m, si, ctx); return; }
  }
  if (w >= 1 && w <= 4) ctx.unported.add(`think world ${w} class 0x${cls.toString(16)}`);
}

/** 1000:CE0B: kind 2 behavior. */
export function behaviorKind2(m, si, ctx) {
  const c0c = m.u8(0x8c0c);
  if (c0c === 8 || c0c === 0xe || c0c === 0x14) { ctx.unported.add(`kind 2 global event ${c0c}`); return; }
  const cls = m.u16(si + 2);
  if (cls === 0x5b) return;
  terrainCollision(m, findByClass(m, 1), si, ctx); // D584: collision against the world entity
  thinkByWorld(m, si, ctx); // 5E22
  if (cls === 0x4b) { ctx.unported.add('kind 2 class 0x4b'); return; }
  if (m.u8(si + 1) !== 0 || cls === 0x42) return;
  const ce87 = () => { moveHorizontalByFlags(m, si, 4); advanceAnim(m, si, 0); };
  const ce93 = () => { moveHorizontalByFlags(m, si, (m.u8(si + 0x3d) & 3) ^ 3); advanceAnim(m, si, m.s8(si + 0x3d)); };
  const ceac = () => { // CEAC: a random roll may start an action
    rollRandom(m, si, ctx);
    if (m.u16(0x8be5) === 0) return;
    startAction(m, si, 0, ctx);
  };
  if (cls === 0x23) { ceac(); return; }
  if (cls === 0x51) { if (m.u8(si + 0x39) === 0x41) return; ceac(); return; }
  if (cls === 0x2c || cls === 0x5a) { ce87(); return; }
  if (cls === 0x13 || cls === 0x14) { ce93(); return; }
  if (cls === 0x57) { if (m.u8(si + 0x40) === 0x43) { ceac(); return; } }
  else if (cls !== 0x4a) {
    // default classes (CE73): set 5 and set 0xf use the plain step, set 0x15 does nothing
    if (m.u8(si + 0x39) === 5) { ce87(); return; }
  }
  if (m.u8(si + 0x39) === 0xf) { ce87(); return; }
  if (m.u8(si + 0x39) === 0x15) return;
  ce93();
}

/** 1000:D023 kind 5 (props and pickups). */
export function behaviorKind5(m, si, ctx) {
  const cls = m.u16(si + 2);
  if (cls === 0x17) return;
  if (m.u8(si + 0x40) === 0xf6) { ctx.unported.add(`kind 5 tracking entity class 0x${cls.toString(16)}`); return; }
  terrainCollision(m, findByClass(m, 1), si, ctx); // D584
  if (cls !== 0xe) return;
  const f = m.s16(si + 0xa);
  if (f === 0x12) { // D077: switch to the idle loop 0x50..0x5b
    if (m.s8(si + 0x3d) < 0) return;
    m.w16(si + 0x10, 0x50); m.w16(si + 0x12, 0x5b); m.w16(si + 0xa, 0x50);
    return;
  }
  if (f < 0x50) return;
  const al = m.u8(si + 0x3d);
  if (al & 0x80) return;
  advanceAnim(m, si, al);
}

/** 1000:CFBA kind 6 (scenery that falls and animates). */
export function behaviorKind6(m, si, ctx) {
  if (m.u8(si + 0x40) === 0xf6) { // CFD1: ride the scroll
    m.w16(si + 6, m.u16(si + 6) + m.u16(0x8bb7));
    m.w16(si + 8, m.u16(si + 8) + m.u16(0x8bb9));
    return;
  }
  terrainCollision(m, findByClass(m, 1), si, ctx); // D584
  const al = m.u8(si + 0x3d);
  if (al & 0x80) return;
  advanceAnim(m, si, al);
}

/** 1000:CFDE kind 7 (the hero's projectiles). */
export function behaviorKind7(m, si, ctx) {
  const st = m.u8(si + 0x40);
  if (st === 0xf6) { // D006: follow the hero's weapon-hand offset
    const hero = findByClass(m, 3);
    const idx = (m.u16(hero + 0xa) - 0x1f) & 0xffff;
    m.w16(si + 8, m.u16(hero + 8) + m.u16(0xf4f9 + 2 * idx + 1));
    return;
  }
  if (st !== 0x65) interactions(m, si, ctx); // DF5A
  let ax = m.s8(si + 0x3d);
  if (ax < 0) return;
  if (m.u8(0x8b98) === 0x41) ax += 1;
  advanceAnim(m, si, ax);
}
