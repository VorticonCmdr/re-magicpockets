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
      if (set === 0xa && cls !== 0x2c && set !== 5) { // 6558: look for a crate (class 0xE) to pick up
        const r = aiScanCrates(m, si, di, ctx);
        if (r === 'end') return;
        continue; // 6320
      }
      if (cls === 0x14 && set === 0 && cls !== 0x2c) { // 65A8: notice the hero
        const bx = findByClass(m, 3);
        if (bx === 0) continue;
        const flags = targetDistance(m, si, bx);
        m.w16(0x8c2b, flags);
        const stance = () => { m.w8(si + 1, 0x86); m.w16(si + 0xc, 0xcf15); }; // 6C6B
        if (flags === 0) { stance(); return; }
        if ((flags & m.u16(si + 0x14)) === 0) continue;
        let cl = m.u8(si + 0x37);
        if (m.s16(0x8c1b) > cl) { m.w16(0x8c2b, m.u16(0x8c2b) & 3); continue; } // 6632
        cl >>= 1;
        if (m.s16(0x8c1d) > cl) { m.w16(0x8c2b, m.u16(0x8c2b) & 0xc); continue; } // 663A
        rollRandom(m, si, ctx);
        if (m.u16(0x8be5) === 0) { stance(); return; }
        rollRandom(m, si, ctx); // 65E2
        if (m.u16(0x8be5) === 0) continue;
        aiTurn(m, si, di, ctx);
        return;
      }
      if (set === 5 && cls !== 0x2c) { // 64C2 (set 5 or not, but only the set-5 world-1 case is ported)
        const r = aiNoticeHero(m, si, di, ctx);
        if (r === 'end') return;
        continue;
      }
      if (cls === 0x2c) { ctx.unported.add(`AI opcode 's' class 0x${cls.toString(16)} set ${set}`); return; }
      continue; // 6555 -> 6320
    }
    if (op === 0x70) { // 6379: look down for a ledge to jump to
      const r = aiOpP(m, si, ctx);
      if (r === 'end') return;
      continue;
    }
    if (op === 0x71) { // 63CE: look along the floor for a gap to jump over
      const r = aiOpQ(m, si, ctx);
      if (r === 'end') return;
      continue;
    }
    if (op === 0x72) { // 643C: a gap ahead decides a turn
      let d = m.u16(0x8bd7);
      d = (m.u16(si + 0x14) === 4 ? d - 0x80 : d + 0x80) & 0xffff; // 7319
      if (tileOf(m, m.u8((d - 1) & 0xffff)) !== 0) continue;
      rollRandom(m, si, ctx);
      if (m.u16(0x8be5) === 0) continue;
      const set = m.u8(si + 0x39);
      if (set === 0xa) { aiTurn(m, si, di, ctx); return; }
      if (set !== 5) return; // 69C9
      rollRandom(m, si, ctx);
      if (m.u16(0x8be5) === 0) continue;
      if ((m.u16(0x8c2b) & 2) !== 0) return;
      continue;
    }
    if (op === 0x74) { // 66BC: look for a ledge in the rows ahead and jump to it
      const r = aiOpT(m, si, ctx);
      if (r === 'end') return;
      continue;
    }
    return; // any other byte (0x6F, ...) ends the decision
  }
}

/** 1000:7227: direction flags (bit 1 down, 8 right, 1 up, 4 left) and distances in cells to `bx`. */
export function targetDistance(m, si, bx) {
  let flags = 0;
  if (m.s16(si + 8) < m.s16(bx + 8)) flags |= 2;
  if (m.s16(si + 6) < m.s16(bx + 6)) flags |= 8;
  if (m.s16(bx + 8) < m.s16(si + 8)) flags |= 1;
  if (m.s16(bx + 6) < m.s16(si + 6)) flags |= 4;
  const ax = Math.abs(m.s16(si + 6) - m.s16(bx + 6)), bxd = Math.abs(m.s16(si + 8) - m.s16(bx + 8));
  m.w16(0x8c29, flags);
  m.w16(0x8c1b, Math.floor(ax / 0x20));
  m.w16(0x8c1d, Math.floor(bxd / 0x10));
  return flags; // CX = 0x10 and DX = |dy| % 16 also survive the call (opcode 58 reads them)
}

/** 1000:6558 (the 's' opcode, animation set 0xA): walk towards a crate and pick it up. @returns 'end' when the decision ends */
function aiScanCrates(m, si, di, ctx) {
  let bx = 0x9398;
  for (;;) {
    bx = nextByClass(m, bx, 0xe);
    if (bx === 0) return 'next';
    const flags = targetDistance(m, si, bx);
    if (m.u8(bx + 0x3e) === 0 || (m.u8(bx) & 0x80) !== 0) continue;
    if (m.s16(0x8c1b) > m.u8(si + 0x37)) continue;
    if (m.u16(0x8c1d) !== 1) { m.w16(0x8c2b, m.u16(0x8c2b) & 0xc); return 'next'; } // 663A
    if (flags === 0 || m.u16(si + 6) === m.u16(bx + 6) || (flags & m.u16(si + 0x14)) !== 0) return pickUp(m, si, bx, ctx); // 6AA7
    aiTurn(m, si, di, ctx); // 6B13
    return 'end';
  }
}

/** 1000:6AA7: the AI entity picks up (destroys) the crate `bx`. */
function pickUp(m, si, bx, ctx) {
  if (m.u16(0x8c1b) !== 0) return 'next';
  const cls = m.u16(si + 2);
  if (cls === 0x4c || cls === 0x50) { ctx.unported.add(`AI 6AA7 class 0x${cls.toString(16)}`); return 'end'; }
  if (cls === 0x14) m.w8(si + 0x3d, 0);
  m.w8(bx + 0x40, 0x19);
  m.w8(si + 0x3c, m.u8(si + 0x3c) + 1);
  m.w8(0x8c09, m.u8(0x8c09) + 1); // + sound 1CCF
  return 'end';
}

/** 1000:C192: the next record after `from` whose class is `cls`. */
function nextByClass(m, from, cls) {
  for (let bx = from + 0x42; bx < 0xb918; bx += 0x42) if (m.u16(bx + 2) === cls) return bx;
  return 0;
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
    if (cls === 0x12) { thinkClass12(m, si, ctx); return; } // 6EC5
  }
  if (w === 2 && cls === 0x4a) { thinkClass13(m, si, ctx); return; } // 5EA0 -> 5F56, shared with world 1's class 0x13
  // Classes the dispatcher at 5E22 knows per world; anything else does nothing (a plain RET).
  const handled = { 1: [], 2: [0x48, 0x49, 0x4b, 0x4c, 0x42, 0x2c], 3: [0x4f, 0x54, 0x50, 0x51, 0x2c], 4: [0x57, 0x58, 0x5a, 0x59, 0x5d, 0x2c] }[w];
  if (handled && (w === 1 ? cls === 0x2c : handled.includes(cls))) ctx.unported.add(`think world ${w} class 0x${cls.toString(16)}`);
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
  if (m.u8(si + 0x40) === 0xf6) { followParent(m, si, ctx); return; } // D04F
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

const moveDownBy = (m, si, ax) => { if ((m.u16(si + 0x24) & 2) === 0) m.w16(si + 8, m.u16(si + 8) + ax); }; // D5FD
const moveUpBy = (m, si, ax) => { if ((m.u16(si + 0x24) & 1) === 0) m.w16(si + 8, m.u16(si + 8) - ax); }; // D609

/** 1000:CC93 kind 4 (small scenery and hazards); only the classes the demo uses are ported. */
export function behaviorKind4(m, si, ctx) {
  const cls = m.u16(si + 2);
  const c0c = m.u8(0x8c0c);
  const common = () => { // CCE6
    terrainCollision(m, findByClass(m, 1), si, ctx); // D584
    thinkByWorld(m, si, ctx); // 5E22
  };
  if (cls === 0x2b) { // CCF6
    const al = m.u8(si + 0x3d);
    if (al & 0x80) return; // CCEC is the RET after CCE6's two calls
    advanceAnim(m, si, al);
    return;
  }
  if (c0c === 8 || c0c === 0xe || c0c === 0x14) { ctx.unported.add(`kind 4 global event ${c0c}`); return; }
  if (cls !== 0x12) {
    if ([0x48, 0x49, 0x54, 0x5d, 0x4e, 0x4f].includes(cls)) { ctx.unported.add(`kind 4 class 0x${cls.toString(16)}`); return; }
    common();
    return;
  }
  if (m.u8(si + 1) === 0x36) { common(); return; } // CD03
  moveHorizontalByFlags(m, si, 2);
  const st = m.u8(si + 0x40);
  if (st === 0xd) { // CD32: rising
    m.w8(si + 0x26, 0xff);
    m.w8(si + 0x27, m.u8(si + 0x27) - m.u8(si + 0x28));
    const al = m.s8(si + 0x27);
    if (al < 0) { m.w8(si + 0x40, 0); m.w16(si + 0x27, 0); m.w16(si + 0x28, 0); }
    else { moveDownBy(m, si, al); m.w8(si + 0x28, m.u8(si + 0x28) + 1); }
  } else if (st === 0xb) { // CD5D: falling back
    moveUpBy(m, si, m.s8(si + 0x28));
    m.w8(si + 0x28, m.u8(si + 0x28) - 1);
    if (m.u8(si + 0x28) === 0) {
      m.w8(si + 0x40, 0); m.w8(si + 0x26, 1); m.w16(si + 0x27, 0); m.w16(si + 0x28, 0);
    }
  } else { // CD1B: hovering
    m.w8(si + 0x26, 0xff);
    if (m.u8(si + 0x27) !== 0xf) m.w8(si + 0x27, m.u8(si + 0x27) + 1);
    moveDownBy(m, si, m.s8(si + 0x27));
  }
  if (m.u8(si + 1) === 0) advanceAnim(m, si, m.u8(si + 0x3d)); // CD7C
  common();
}

/** 1000:D04F: a kind 5 entity in state 0xF6 rides the entity at [+0x2C] (the player, for carried items). */
function followParent(m, si, ctx) {
  const cls = m.u16(si + 2);
  const bx = m.u16(si + 0x2c);
  m.w16(si + 6, m.u16(bx + 6));
  m.w16(si + 8, m.u16(bx + 8));
  if (cls === 0x1a || cls === 0x41) { carriedItem(m, si, bx, ctx); return; } // D14A
  if (cls === 0x40) { ctx.unported.add('D08D class 0x40 follower'); return; }
}

/** 1000:D14A: the item the player carries: stays in his hands, follows the walk cycle. */
function carriedItem(m, si, bx, ctx) {
  if (m.u16(bx + 2) !== 3) return; // D182
  if (m.s8(0x8ba2) < 0 || m.u8(si + 1) === 0x33) return;
  const drop = () => { // D1AB: the item is spent
    m.w8(si + 0x40, 0x19); m.w8(si + 1, 0); m.w8(si + 0x3e, 0);
    m.w8(0x8b98, 0); m.w8(0x8c04, 0); // + sound 1CCF(0x43)
  };
  const hold = () => { m.w16(si + 6, 0x90); m.w16(si + 8, 0xffe0); }; // D1C9
  if (m.u8(bx + 1) === 0x2f) { hold(); return; }
  const t = m.u8(0x8b98);
  if (t !== 0x1a && t !== 0x41) { // D171: the carrying mode ended
    m.w8(si + 0x40, 0); m.w8(si + 1, 0); m.w8(si + 0x3e, 0); m.w8(0x8c04, 0);
    return;
  }
  const frame = m.u16(si + 0xa);
  let follow = false; // D1DA
  if (m.u8(si + 1) !== 0) { if (m.u16(si + 0x2a) === 0) { drop(); return; } follow = true; }
  else if (frame === 0xe4 || frame === 0xe5) follow = true;
  else if (frame === 0xe2 || frame === 0xe3) { hold(); return; }
  else if (m.u16(si + 0x2a) !== 0) follow = true;
  else { drop(); return; }
  if (!follow) return;
  let ax = m.s16(bx + 0xa);
  if (ax > 0x6a) ax = 0x1f;
  const di = 0xf457 + 2 * (ax - 0x1f);
  m.w8(si + 8, m.u8(bx + 8) + m.u8(di + 1)); // ADD AL only: the high byte of Y keeps the parent's
  m.w8(si + 9, m.u8(bx + 9));
  let cx = m.u8(di);
  m.w16(si + 0x14, m.u16(bx + 0x14));
  m.w16(si + 0xa, m.u16(si + 0xa) & 0xfffe);
  const dx = m.u16(si + 0xa);
  if (m.u16(si + 0x14) !== 8) { m.w16(si + 0xa, m.u16(si + 0xa) | 1); cx = -cx; }
  m.w16(si + 6, m.u16(si + 6) + cx);
  const faceRight = m.u16(si + 0x14) === 4;
  const stepX = (v) => m.w16(si + 6, m.u16(si + 6) + (faceRight ? v : -v));
  if (dx === 0xe4) { stepX(2); m.w16(si + 8, m.u16(si + 8) - 0xc); return; } // D2B8
  if (dx === 0xe6) { stepX(2); return; } // D2A6
  if (dx === 0xe8) { stepX(2); return; } // D27F
  if (dx === 0xea) { m.w8(0x8b96, 1); stepX(5); return; } // D28F
  if (dx === 0xe2) return;
  m.w8(0x8c04, 0x1d); stepX(2); // D268
}

/**
 * 1000:7084 (animation set 5): a hovering enemy that is above the hero, facing him and within range dives (class 0x12
 * state 0x96, 0x54 state 0xE3, 0x5D state 0xF0). Returns true when the decision is finished.
 */
function diveAtHero(m, si, ctx) {
  const hero = findByClass(m, 3);
  const flags = hero === 0 ? 3 : targetDistance(m, si, hero);
  m.w16(0x8c27, flags);
  if ((flags & 2) === 0 || (flags & m.u16(si + 0x14)) === 0) return false;
  if (m.s16(0x8c1d) > ((m.u8(si + 0x37) << 1) & 0xff)) return false;
  if (m.s16(0x8c1b) > 2) return false;
  const scan = tileScan(m, 'right', m.u16(0x8bd7), 1, m.u16(0x8c1b));
  if (scan.dh !== 0) return false;
  if (m.u8(0x8b96) !== 0) return false;
  rollRandom(m, si, ctx);
  if (m.u16(0x8be5) === 0) return false;
  const cls = m.u16(si + 2);
  const start = (state, script) => { m.w8(si + 1, state); m.w16(si + 0xc, script); m.w8(si + 0x26, 0xff); };
  if (cls === 0x12) start(0x96, 0xd059);
  else if (cls === 0x54) start(0xe3, 0xd7cd);
  else if (cls === 0x5d) start(0xf0, 0xd89f);
  return true;
}

/** 1000:6EC5 (world 1, class 0x12): the hovering enemy rolls to dive (state 0x36) or to bob (0xB/0xD). */
function thinkClass12(m, si, ctx) {
  const frameTarget = 0x86;
  m.w16(0x8c25, frameTarget);
  if (m.u8(0x8bc9) !== 0 && m.u16(0x8bc7) === 0) {
    rollRandom(m, si, ctx);
    if (m.u16(0x8be5) !== 0) {
      if (m.u8(si + 1) !== 0x36) { m.w8(si + 1, 0x36); m.w16(si + 0xc, 0xc80e); }
      return;
    }
  }
  if (m.u8(si + 0x40) === 0) { // 7014
    const set = m.u8(si + 0x39);
    if (set === 0xa || set === 0xf) { ctx.unported.add(`think class 0x12 set ${set}`); return; }
    if (set === 5 && diveAtHero(m, si, ctx)) return; // 7084
    if (m.u16(si + 0xa) !== frameTarget) return;
    rollRandom(m, si, ctx);
    if (m.u16(0x8be5) !== 0) {
      m.w8(si + 0x40, 0xb); m.w8(si + 0x26, 1);
      const al = m.u8(si + 0x36);
      m.w8(si + 0x28, al);
      m.w8(si + 0x3d, m.u8(0xecfe + al));
      return;
    }
  }
  const st = m.u8(si + 0x40); // 7064
  if (st === 0xd) m.w8(si + 0x3d, 0);
  else if (st !== 0xb) m.w8(si + 0x3d, 2);
}

const tileOf = (m, v) => m.u8(m.u16(0xef23) + (((v & 0xff) << 24) >> 24)); // the world table is indexed by a signed byte

/**
 * 1000:728B/72B6 (vertical: face 4 looks up, else down), 72D9 (left) and 72F9 (right): walk the map
 * from `di` until the tile class equals `dl` or `cx` runs out. Returns the class, the cursor and the
 * remaining count the original leaves in DH, DI and CX.
 */
function tileScan(m, kind, di, dl, cx) {
  cx &= 0xff;
  let dh;
  for (;;) {
    if (kind === 'up') di = (di - 0x80) & 0xffff;
    else if (kind === 'down') di = (di + 0x80) & 0xffff;
    const al = m.u8(di);
    if (kind === 'left') di = (di - 1) & 0xffff; else if (kind === 'right') di = (di + 1) & 0xffff;
    dh = tileOf(m, al);
    if (dh === dl) break;
    cx = (cx - 1) & 0xffff;
    if (cx & 0x8000) break;
  }
  return { dh, di, cx };
}

/** 1000:682F: start a jump of height class `cx` (the vertical speed comes from a table at 0xED3A). */
function startJump(m, si, cx, ctx) {
  m.w8(si + 0x26, m.u8(0xed3a + (cx & 0xff)));
  m.w8(si + 0x27, 4);
  const cls = m.u16(si + 2);
  const set = (state, script) => { m.w8(si + 1, state); m.w16(si + 0xc, script); };
  if (cls === 0x2c) { set(0x15, 0xc625); return 'end'; }
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  if (world !== 1) { ctx.unported.add(`AI jump 682F world ${world}`); return 'end'; }
  if (cls === 0x14) return 'next'; // 686B: back into the opcode loop
  if (cls === 0x13) set(0x83, 0xced5);
  else if (cls === 0x23) set(0x99, 0xd08d);
  else if (cls === 0x20) set(0x97, 0xd062);
  return 'end';
}

/** 1000:68EC: start a jump described by `dx` (direction/steps) and `cx` (table index at 0xED30). */
function startAimedJump(m, si, dx, cx, ctx) {
  dx &= 0xff; cx &= 0xff;
  m.w16(0x8c27, dx);
  const speed = m.u8(0xed30 + cx);
  m.w8(si + 0x26, speed);
  m.w16(0x8c29, speed);
  let v = speed === 0 ? 0 : (Math.floor((0x20 * dx) / speed) >> 1) & 0xff;
  if (dx === 2) v = (-v) & 0xff;
  m.w8(si + 0x27, v);
  const cls = m.u16(si + 2);
  const set = (state, script) => { m.w8(si + 1, state); m.w16(si + 0xc, script); };
  if (cls === 0x2c) { set(0x15, 0xc625); return 'end'; }
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  if (world !== 1) { ctx.unported.add(`AI jump 68EC world ${world}`); return 'end'; }
  if (cls === 0x14) return 'next';
  if (cls === 0x13) set(0x83, 0xced5);
  else if (cls === 0x23) set(0x99, 0xd08d);
  else if (cls === 0x20) set(0x97, 0xd062);
  return 'end';
}

/** AI opcode 't' (1000:66BC). */
function aiOpT(m, si, ctx) {
  const reach = m.u8(si + 0x37);
  let di = (m.u16(0x8bd7) - 1) & 0xffff;
  m.w16(0x8c25, reach);
  for (;;) {
    const row = di;
    const scan = tileScan(m, 'left', row, 1, reach);
    if (scan.dh === 0) { // 6728: try the next row
      di = (m.u16(si + 0x14) === 4 ? row - 0x80 : row + 0x80) & 0xffff;
      const n = (m.u16(0x8c25) - 1) & 0xffff;
      m.w16(0x8c25, n);
      if (n === 0) return 'next';
      continue;
    }
    const cl0 = scan.cx & 0xff;
    const r25 = m.u16(0x8c25);
    if ((r25 & 0xff) === reach) { // 675A: the hero's own row
      if (m.u16(si + 2) !== 0x4b) return 'next';
      rollRandom(m, si, ctx);
      if (m.u16(0x8be5) === 0) return 'next';
      const c = (reach - cl0) & 0xff;
      m.w16(0x8c29, c);
      return startAimedJump(m, si, 2, c, ctx);
    }
    if (m.u8(m.u16(0xef23) + m.u8((scan.di - 1) & 0xffff)) !== 0) return 'next';
    rollRandom(m, si, ctx);
    if (m.u16(0x8be5) === 0) return 'next';
    let dl = (reach - (r25 & 0xff)) & 0xff;
    let cl = (reach - cl0) & 0xff;
    if (dl === 0 || cl === 0) return 'next';
    const al = m.s8(si + 0x36);
    if (al < ((cl << 24) >> 24) || al < ((dl << 24) >> 24)) return 'next';
    return startAimedJump(m, si, (dl + 1) & 0xff, (cl + 1) & 0xff, ctx);
  }
}

/**
 * 1000:6642 (world 1): an enemy of class 0x20 whose three tuning bytes add up to 0x1B walks to the prize (class 0x15):
 * when it stands on the prize's column it picks it up (animation set 0x15 and a new random delay).
 */
function aiSeekPrize(m, si, di, ctx) {
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  if (world !== 1) { ctx.unported.add(`AI 6642 world ${world}`); return 'end'; }
  const prize = findByClass(m, 0x15); // 6685: 721F
  if (prize === 0) return 'next';
  let flags = targetDistance(m, si, prize);
  if (((m.u16(prize + 8) - 0x10) & 0xffff) === m.u16(si + 8)) flags &= 0xd;
  m.w16(0x8c2b, flags);
  if (m.s16(0x8c1d) > 1) return 'next';
  if (flags !== 0 && (flags & m.u16(si + 0x14)) === 0) { aiTurn(m, si, di, ctx); return 'end'; } // 6B13
  const cls = m.u16(si + 2); // 6A82
  if (cls !== 0x20) { if (cls === 0x4b || cls === 0x51 || cls === 0x57) ctx.unported.add(`AI 6A82 class 0x${cls.toString(16)}`); return 'end'; }
  // 6BD0
  let dx = (m.u16(prize + 6) - m.u16(si + 6)) | 0;
  if (dx < 0) dx = -dx;
  if ((dx & 0xffe0) !== 0) return 'next';
  m.w16(si + 0x10, 0xbc); m.w16(si + 0x12, 0xbf); m.w16(si + 0xa, 0xbc);
  m.w8(si + 0x39, 0x15);
  m.w8(prize + 0x40, 0x19);
  m.w8(si + 0x38, ((m.u16(0x8b6b) & 3) + 6) & 0xff);
  m.w16(si + 0x2a, 0);
  m.w8(si, 0);
  return 'end';
}

/** AI opcode 'q' (1000:63CE). */
function aiOpQ(m, si, ctx) {
  const set = m.u8(si + 0x39), f = m.u16(0x8c2b);
  if (set === 5 && (f & 1) === 0 && (f & m.u16(si + 0x14)) === 0) return 'next';
  let di = m.u16(0x8bd7);
  di = (m.u16(si + 0x14) === 4 ? di - 0x80 : di + 0x80) & 0xffff; // 7319
  di = (di - 2) & 0xffff;
  const reach = m.u8(si + 0x37);
  const a = tileScan(m, 'left', di, 0, (reach - 1) & 0xff);
  if (a.dh !== 0) return 'next';
  let cl = (reach - (a.cx & 0xff)) & 0xff;
  const b = tileScan(m, 'left', (m.u16(0x8bd7) - 1) & 0xffff, 1, (cl + 1) & 0xff);
  if (b.dh !== 0) return 'next';
  rollRandom(m, si, ctx);
  if (m.u16(0x8be5) === 0) return 'next';
  const al = m.s8(si + 0x36);
  if (al === 0) return 'next';
  const cx = al >= ((cl << 24) >> 24) ? cl : al & 0xff;
  return startJump(m, si, cx, ctx);
}

/** AI opcode 'p' (1000:6379). */
function aiOpP(m, si, ctx) {
  const set = m.u8(si + 0x39);
  if (set === 5 && (m.u16(0x8c2b) & 2) !== 0) return 'next';
  const reach = m.u8(si + 0x37);
  const a = tileScan(m, m.u16(si + 0x14) === 4 ? 'up' : 'down', m.u16(0x8bd7), 1, reach);
  if (a.dh === 0) return 'next';
  rollRandom(m, si, ctx);
  if (m.u16(0x8be5) === 0) return 'next';
  const dl = (reach - (a.cx & 0xff)) & 0xff;
  if (tileOf(m, m.u8((a.di - 1) & 0xffff)) !== 0) return 'next';
  if (m.u8(si + 0x36) === 0) return 'next';
  startAction(m, si, dl, ctx);
  return 'end';
}

/** 1000:64C2..6555 + 69CA: an enemy of animation set 5 looks for the hero and attacks. */
function aiNoticeHero(m, si, di, ctx) {
  const cls = m.u16(si + 2);
  if ((cls === 0x20 || cls === 0x4b || cls === 0x51 || cls === 0x57) && ((m.u8(si + 0x36) + m.u8(si + 0x37) + m.u8(si + 0x38)) & 0xff) === 0x1b) {
    return aiSeekPrize(m, si, di, ctx); // 6642
  }
  const bx = findByClass(m, 3);
  if (bx === 0) return 'next';
  const flags = targetDistance(m, si, bx);
  m.w16(0x8c2b, flags);
  const attack = () => { // 69CA, world 1, set 5
    if (cls === 0x42) { ctx.unported.add('AI 6CD4'); return 'end'; }
    if (m.u8(0x8b96) !== 0) return 'next';
    const world = m.u16(0x8b89) || m.u16(0x8b8b);
    if (world !== 1) { ctx.unported.add(`AI attack world ${world}`); return 'end'; }
    if (m.u8(si + 0x39) !== 5) return 'next';
    const set = (state, script) => { m.w8(si + 1, state); m.w16(si + 0xc, script); };
    if (cls === 0x13) { // 6BAA
      if (m.u8(si + 0x39) !== 0) { m.w8(si + 0x32, m.u16(0x8c1b) & 0xff); set(0x8b, 0xcf7c); }
      return 'end';
    }
    if (cls === 0x20) { m.w8(si + 0x32, m.u16(0x8c1b) & 0xff); set(0x8c, 0xcfb4); return 'end'; } // 6BC0
    if (cls === 0x23) { // 6C14
      if (m.s16(0x8c1b) > 4) return 'next';
      if (m.u8(si + 0x39) !== 0) set(0x9a, 0xd09c);
      return 'end';
    }
    if (cls === 0x14) { const al = (m.u8(si + 0x3d) - 1) & 0xff; if ((al & 0x80) === 0) m.w8(si + 0x3d, al); return 'end'; } // 6C75
    return 'next';
  };
  if (flags === 0) return attack();
  const reach = m.u8(si + 0x37);
  if (m.s16(0x8c1b) > reach) { m.w16(0x8c2b, m.u16(0x8c2b) & 3); return 'next'; }
  if (m.s16(0x8c1d) > (reach >> 1)) { m.w16(0x8c2b, m.u16(0x8c2b) & 0xc); return 'next'; }
  rollRandom(m, si, ctx);
  if (m.u16(0x8be5) === 0) return 'next';
  const facing = m.u16(0x8c2b) & m.u16(si + 0x14);
  if (facing === 0) { // 65E2
    rollRandom(m, si, ctx);
    if (m.u16(0x8be5) === 0) return 'next';
    aiTurn(m, si, di, ctx);
    return 'end';
  }
  if (m.u8(si + 0x38) === 9 || cls === 0x42) return attack();
  const scan = tileScan(m, m.u16(si + 0x14) === 4 ? 'up' : 'down', (m.u16(0x8bd7) - 2) & 0xffff, 1, facing & 0xff);
  if (scan.dh !== 0) return 'next';
  return attack();
}
