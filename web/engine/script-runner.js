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
    default:
      ctx.unported.add(`opcode ${op}`);
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
