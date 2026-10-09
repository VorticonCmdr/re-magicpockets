// Entity_RunScript (1000:22DA) and the script opcodes ported so far, over a DsMemory image.
//
// This is a transliteration of the disassembly, not of docs/entity-script-vm.md's prose (the doc
// was wrong about opcode 9, see its 2026-10-09 corrections). Register names follow the original:
// `si` is the entity pointer, `di` the script cursor. Handlers either return normally (the run
// loop then stores `di` back to `[si+0xC]`) or return ABORT, which models the original's
// `pop ax; ret` (jumps 2663/265D/2665): leave RunScript without writing the cursor back.
//
// Opcodes that are not ported yet record themselves in `ctx.unported` and abort, so the
// conformance harness shows exactly which ones the demo needs.

'use strict';

import { findByClass } from './ds-memory.js';
import { pushEvent5 } from './fire.js';

const ABORT = Symbol('abort');

// Table bases in DS (Ghidra: 6de3:xxxx).
const STATE_SCRIPTS = 0xcd88; // positive states: word per state, absolute script pointer
const NEG_STATE_SCRIPTS = 0xd996; // negative states, see below

const NOPS = new Set([0, 4, 16, 18, 20, 23, 24, 27, 32, 41, 42, 44, 48, 56, 72]);

// Collision-gated movement helpers (1000:D5FD, D609, D615, D627). Bits of the flag word at +0x24:
// 1 = blocked up, 2 = blocked down, 4 = blocked left, 8 = blocked right.
function moveDown(m, si, ax) { if ((m.u16(si + 0x24) & 2) === 0) m.w16(si + 8, m.u16(si + 8) + ax); }

function moveUp(m, si, ax) { if ((m.u16(si + 0x24) & 1) === 0) m.w16(si + 8, m.u16(si + 8) - ax); }

/** 1000:D615. Kind 3 takes a separate path (D65B) that is not ported. */
function moveLeft(m, si, ax, ctx) {
  if ((m.u16(si + 0x24) & 4) !== 0) return;
  if (m.u16(si + 4) === 3) { ctx.unported.add('D65B kind-3 horizontal step'); return; }
  m.w16(si + 6, m.u16(si + 6) - ax);
}

/** 1000:D627. Kind 3 takes a separate path (D639) that is not ported. */
function moveRight(m, si, ax, ctx) {
  if ((m.u16(si + 0x24) & 8) !== 0) return;
  if (m.u16(si + 4) === 3) { ctx.unported.add('D639 kind-3 horizontal step'); return; }
  m.w16(si + 6, m.u16(si + 6) + ax);
}

const sx8 = (v) => (v > 127 ? v - 256 : v);

/**
 * @param {import('./ds-memory.js').DsMemory} m
 * @param {number} si entity pointer
 * @param {{unported:Set<string>, events:any[]}} ctx
 */
export function runScript(m, si, ctx) {
  const cls = m.u16(si + 2);
  const frz = m.u8(0x8ba1);
  // 1000:22DA-2322: which entities are skipped while the AI-freeze byte [8BA1] is set.
  const bypass = (c) => c === 0x2d || c === 8 || c === 3 || c === 1 || c === 0x29 || c === 7;
  if (cls !== 0x2d) {
    if (frz === 0x32) return;
    if (!bypass(cls)) {
      if (frz === 0x66) return;
      if (cls !== 0x1f && cls !== 0xf) {
        if (frz === 0x45) return;
        if (frz > 127) return; // `js`
      }
    }
  }
  if (m.u16(si + 0xc) === 0) {
    m.w8(si + 1, 0);
    m.w16(si + 0xc, m.u16(STATE_SCRIPTS)); // state 0
  }
  let guard = 0;
  for (;;) {
    if (++guard > 1000) throw new Error('script ran away');
    let di = m.u16(si + 0xc);
    const op = m.u8(di);
    di += 1;
    if (op === 0xff) return;
    if (op === 0xfc) { m.w16(si + 0xc, di); return; } // yield: cursor advances past the FC byte
    if (op === 0xae) return;
    const r = handler(m, si, di, op, ctx);
    if (r === ABORT) return;
    m.w16(si + 0xc, r);
  }
}

/** Run one opcode with the cursor `di` just past the opcode byte; returns the new cursor or ABORT. */
function handler(m, si, di, op, ctx) {
  if (NOPS.has(op)) return di;
  switch (op) {
    case 1: m.w8(si + 0xa, m.u8(di)); return di + 1; // SetAnimFrame (byte store)
    case 2: { // WaitFrames
      const n = m.u8(di);
      if (n === m.u8(si + 0x3e)) { m.w8(si + 0x3e, 0); return di + 1; }
      m.w8(si + 0x3e, m.u8(si + 0x3e) + 1);
      return ABORT;
    }
    case 3: return di - m.s8(di); // JumpBack
    case 5: { // SetHitboxSizeOrRandomize
      const a = m.u8(di); di += 1;
      if (a > 127) m.w16(si + 0x14, m.u8(0x8b6b) > 0x77 ? 4 : 8);
      else if (a === 0x12) m.w16(si + 0x14, m.u16(si + 0x14) ^ 0xc);
      else m.w16(si + 0x14, a);
      return di;
    }
    case 6: m.w8(si + 0x40, 0x19); return ABORT; // Kill
    case 9: return animTable(m, si, di, ctx); // PlayDirectionalAnimTable
    case 11: { // CallStateScript (type 0x42 special case not ported)
      if (m.u16(si + 2) === 0x42) { ctx.unported.add('op11 on type 0x42'); return ABORT; }
      const a = m.s8(di); di += 1;
      m.w16(si + 0x2a, di);
      return m.u16(NEG_STATE_SCRIPTS + 2 * a);
    }
    case 12: { // Return
      const ret = m.u16(si + 0x2a);
      if (ret === 0) { m.w16(si + 0xc, 0); m.w8(si + 1, 0); return ABORT; }
      m.w16(si + 0x2a, 0);
      return ret;
    }
    case 13: return spawnEffect(m, si, di, ctx); // SpawnEffectByTypeCode
    case 14: { // GotoStateScript
      const a = m.u8(di); di += 1;
      return a < 128 ? m.u16(STATE_SCRIPTS + 2 * a) : m.u16(NEG_STATE_SCRIPTS + 2 * (a & 0x7f));
    }
    case 15: ctx.events.push({ op: 'sound', id: m.u8(di) }); return di + 1; // PlaySound
    case 17: { // WaitOrLoopBack
      const n = m.u8(di); di += 1;
      if (n === m.u8(si + 0x3e)) { m.w8(si + 0x3e, 0); return di + 1; }
      m.w8(si + 0x3e, m.u8(si + 0x3e) + 1);
      return di - m.s8(di);
    }
    case 22: m.w8(si + m.u8(di + 1), m.u8(di)); return di + 2; // PokeByteValueThenOffset
    case 29: m.w16(si + 0x24, m.s8(di) & 0xffff); return di + 1; // SetCollFlags (sign-extended word)
    case 31: { // SetAnimRange
      const a = m.u8(di); di += 1;
      if (a === 0xff) { m.w16(si + 0xa, m.u16(si + 0x10)); return di; }
      m.w16(si + 0x10, a);
      m.w16(si + 0x12, m.u8(di));
      return di + 1;
    }
    case 35: m.w8(si + m.u8(di), m.u8(di + 1)); return di + 2; // PokeByteOffsetThenValue
    case 36: // AddToPosition
      m.w16(si + 6, m.u16(si + 6) + m.s8(di));
      m.w16(si + 8, m.u16(si + 8) + m.s8(di + 1));
      return di + 2;
    case 39: { // AdvanceAnimWithDelay
      const n = m.s8(di); di += 1;
      if (n > m.s8(si + 0x3b)) { m.w8(si + 0x3b, m.u8(si + 0x3b) + 1); return ABORT; }
      m.w8(si + 0x3b, 0);
      m.w16(si + 0xa, m.u16(si + 0xa) === m.u16(si + 0x12) ? m.u16(si + 0x10) : m.u16(si + 0xa) + 1);
      return di;
    }
    case 40: m.w8(si + 0x40, m.u8(di)); return di + 1; // SetState40
    case 50: m.w16(0x8b75, m.u16(0x8b75) + m.s8(di)); return di + 1; // AddSignedByteToScore
    case 54: m.w16(si + 0xc, 0); m.w8(si + 1, 0); return ABORT; // ResetScript
    case 55: // DispatchSpeedTickByKind
      if (m.u16(si + 4) === 1) { tickKind1(m, si, di); return ABORT; }
      if (m.u16(si + 4) === 2) { tickKind2(m, si, di, ctx); return ABORT; }
      ctx.unported.add(`opcode 55 kind ${m.u16(si + 4)}`);
      return ABORT;
    case 21: { // WaitUntilSyncTriple
      const a = m.u8(di), b = m.u8(di + 1), c = m.u8(di + 2); di += 3;
      if (a !== m.u8(0x8bb0) || b !== m.u8(0x8baf) || c !== m.u8(0x8bae)) return ABORT;
      return di;
    }
    case 30: return m.u8(0x8ba1) !== 0 ? ABORT : di; // WaitUnlessAiActive
    case 33: m.w8(0x8bb0, m.u8(di)); m.w8(0x8baf, m.u8(di + 1)); m.w8(0x8bae, m.u8(di + 2)); return di + 3; // SetSyncTriple
    case 34: // SetAnimSetAndChargeFields
      m.w8(si + 0x39, m.u8(di)); m.w8(si + 0x36, m.u8(di + 1)); m.w8(si + 0x37, m.u8(di + 2)); m.w8(si + 0x38, m.u8(di + 3));
      return di + 4;
    case 57: m.w8(si + 0x16, m.u8(di)); return di + 1; // SetSpriteShapeOverride
    case 59: m.w16(0x8c34, m.u8(di)); return di + 1; // SetScrollWidthRegister
    case 60: m.w8(0x8b98, m.u8(di)); return di + 1; // set the tracked-target byte
    case 61: m.w8(0x8ba1, m.u8(di)); return di + 1; // SetAiFreezeFlag
    case 63: { // 1000:2A75 (sets the +0x1c extent from a sprite code)
      const a = m.u8(di); di += 1;
      if (a === 0) {
        const v = (m.u16(si + 0xa) - 0x20) & 0xffff;
        m.w16(si + 0xa, v);
        if (v === 0x48) m.w16(si + 0xa, v - 7);
        return di;
      }
      let ax = sx8(a);
      if (ax === 0x6b) {
        m.w16(0x8c38, ax & 0xffff);
        m.w16(si + 0x1c, m.u16(si + 0x14) === 4 ? 0xfff6 : 0x12);
        return di;
      }
      if (ax === 0x4b && m.u8(0x8b98) === 0x1a) ax = 0x4a;
      m.w16(0x8c38, ax & 0xffff);
      m.w16(si + 0x1c, 4);
      return di;
    }
    case 64: m.w8(0x8ba2, m.u8(di)); return di + 1; // SetPaletteFadeState
    case 65: { // AddSignedDeltaAtOffset: word at si+bl += (int8) cl
      const off = m.u8(di), delta = sx8(m.u8(di + 1));
      m.w16(si + off, m.u16(si + off) + delta);
      return di + 2;
    }
    case 67: m.w8(si + 0x3d, m.u8(di)); return di + 1; // SetAnimLockFlag
    case 71: m.w8(0x8c0c, m.u8(di)); return di + 1; // SetGlobalEventTrigger
    case 76: m.w8(0x8c0e, 0); return di; // clears [8C0E]
    default:
      ctx.unported.add(`opcode ${op} operand 0x${m.u8(di).toString(16)}`);
      return ABORT;
  }
}

/** Opcode 9 at 1000:3C9B. Pairs are (horizontal, vertical); [si+0x30] is the byte offset into them. */
function animTable(m, si, di, ctx) {
  let idx = m.u16(si + 0x30);
  const vert = sx8(m.u8(di + idx + 1));
  if (vert >= 0) moveDown(m, si, vert); else moveUp(m, si, -vert);
  const horiz = sx8(m.u8(di + idx));
  const face = m.u16(si + 0x14);
  if (face !== 0) { if (face === 8) moveLeft(m, si, horiz, ctx); else moveRight(m, si, horiz, ctx); }
  m.w16(si + 0x30, m.u16(si + 0x30) + 2);
  idx += 2;
  if (m.u8(di + idx) !== 0xae) return ABORT; // park on this opcode until the terminator
  m.w16(si + 0x30, 0);
  return di + idx + 1;
}

/** 1000:DD1A Entity_TickKind1SpeedDecay: the world entity's vertical speed tick (always parks). */
function tickKind1(m, si, di) {
  let al = m.u8(di); di += 1;
  if (m.u8(si + 0x27) === 0) { // first tick: load vertical and horizontal speed
    m.w8(si + 0x26, al);
    al = m.u8(di); di += 1;
    m.w8(si + 0x27, al);
    m.w8(si + 0x28, 0);
  }
  let ax = sx8(m.u8(si + 0x26));
  m.w16(si + 8, m.u16(si + 8) + ax);
  m.w8(si + 0x28, m.u8(si + 0x28) + 1);
  if (m.s8(si + 0x28) >= 10) {
    if (m.u8(si + 1) === 0x11 || m.s8(si + 0x28) >= 0x10) {
      if (m.u8(0x8b98) === 0) { // the player starts falling too
        const bx = findByClass(m, 3);
        m.w8(0x8b98, 1);
        m.w16(bx + 0x10, 0x90); m.w16(bx + 0x12, 0x93); m.w16(bx + 0xa, 0x90);
        m.w8(bx + 1, 0);
        m.w16(0x8c38, 0);
        m.w8(0x8b96, 0);
      }
    }
  }
  if (ax >= -13) { ax -= 2; m.w8(si + 0x26, ax & 0xff); }
  const h = m.s8(si + 0x27);
  if (h < 0) return;
  const face = m.u16(si + 0x14);
  if (face === 0) return;
  if ((face & m.u16(si + 0x24)) !== 0) return;
  if (face === 8) m.w16(si + 6, m.u16(si + 6) - h); else m.w16(si + 6, m.u16(si + 6) + h);
}

/** Opcode 13 at 1000:334E. Only type 0xA (the weapon projectile, 1000:3802) is ported. */
function spawnEffect(m, si, di, ctx) {
  for (const a of [0x8c1b, 0x8c1d, 0x8c1f, 0x8c21, 0x8c23, 0x8c25, 0x8c27, 0x8c29]) m.w16(a, 0);
  const type = m.u8(di); di += 1;
  m.w16(0x8c29, type);
  if (type !== 0x0a) { ctx.unported.add(`opcode 13 type 0x${type.toString(16)}`); return ABORT; }
  m.w16(0x8c21, m.u16(si + 0x24) & 0x80);
  if (m.u16(0x8c21) !== 0) return di; // 36CC: the player is flagged, nothing is spawned
  m.w16(0x8c21, m.u16(0x8bf3));
  m.w16(0x8bf3, 0x17);
  m.w16(0x8c23, m.u16(si + 0x14));
  m.w16(0x8c25, m.u16(si + 8));
  m.w16(0x8c27, m.u16(si + 6));
  const id = m.u16(0x8c69);
  m.w16(0x8c29, id);
  if (id === 0xe || id === 0x1b || id === 0x27) { ctx.unported.add(`opcode 13 weapon ${id}`); return ABORT; }
  let w = m.u16(0x8b89);
  m.w16(0x8c1d, w);
  if (w === 0) { w = m.u16(0x8b8b); m.w16(0x8c1d, w); }
  const base = { 1: 0xa, 2: 0x30, 3: 0x35 }[w];
  if (base === undefined) { if (w !== 4) return di; ctx.unported.add('opcode 13 world 4 weapon'); return ABORT; }
  const v = id - base;
  if (v < 0 || v > 3) return di;
  const left = m.u16(0x8c23) === 4;
  const dy = [8, 4, 2, 0][v];
  const dxl = [-6, -6, -10, -0x12][v], dxr = [0x1a, 0x1a, 0x16, 0xe][v];
  m.w16(0x8c25, m.u16(0x8c25) + dy);
  m.w16(0x8c27, m.u16(0x8c27) + (left ? dxl : dxr));
  pushEvent5(m);
  return di;
}

/** 1000:DBC2 Entity_TickKind2VerticalBounce (always parks). */
function tickKind2(m, si, di, ctx) {
  if (m.u16(si + 0x26) === 0) { m.w8(si + 0x26, m.u8(di)); m.w8(si + 0x27, m.u8(di + 1)); di += 2; }
  let ax = sx8(m.u8(si + 0x26));
  let skipVertical = false;
  if (ax < 0) { moveDown(m, si, -ax); ax = -ax === 0 ? 0 : ax; }
  else if (ax !== 0) moveUp(m, si, ax);
  else {
    m.w8(si + 0x27, (-m.s8(si + 0x27)) & 0xff);
    if (m.s8(si + 0x27) >= 0) moveDown(m, si, 0);
    else { ax = -sx8(m.u8(si + 0x27)); skipVertical = true; }
  }
  if (!skipVertical) {
    if (ax <= -15) return; // jg DBFF fails: park
    m.w8(si + 0x26, m.u8(si + 0x26) - 1);
    if (m.s8(si + 0x27) < 0) return;
    ax = m.s8(si + 0x27);
  }
  if (m.u16(si + 0x14) === 0) return;
  moveHorizontalByFlagsRunner(m, si, ax);
}

/** 1000:D5E2 */
function moveHorizontalByFlagsRunner(m, si, ax) {
  const dx = m.u16(si + 0x24);
  if (m.u16(si + 0x14) === 4) { if ((dx & 4) === 0) m.w16(si + 6, m.u16(si + 6) - ax); return; }
  if ((dx & 8) === 0) m.w16(si + 6, m.u16(si + 6) + ax);
}
