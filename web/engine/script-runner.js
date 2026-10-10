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
import { resetExtendedFields } from './entity-behavior.js';
import { pushEvent3, pushEvent4, pushEvent5, pushSpawnEvent, pushEntityEvent } from './fire.js';
import { setupLineMotion, insertByGroup } from './spawn.js';
import { gameOverBody } from './hit.js';
import { projectileRunsOut } from './ground-collision.js';
import { rollRandom } from './enemy.js';

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
  ctx.swapTo = 0;
  const cls = m.u16(si + 2);
  const frz = m.u8(0x8ba1);
  // 1000:22DA-2322: which entities are skipped while the AI-freeze byte [8BA1] is set.
  const bypass = (c) => c === 0x2d || c === 8 || c === 3 || c === 1 || c === 0x29 || c === 7;
  if (cls !== 0x2d) {
    if (frz === 0x32) return si;
    if (!bypass(cls)) {
      if (frz === 0x66) return si;
      if (cls !== 0x1f && cls !== 0xf) {
        if (frz === 0x45) return si;
        if (frz > 127) return si; // `js`
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
    if (op === 0xff) return si;
    if (op === 0xfc) { m.w16(si + 0xc, di); return si; } // yield: cursor advances past the FC byte
    if (op === 0xae) return si;
    const r = handler(m, si, di, op, ctx);
    if (r === ABORT) return si;
    if (ctx.swapTo) { si = ctx.swapTo; ctx.swapTo = 0; } // opcode 45: the register pair was exchanged
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
      if (m.u16(si + 2) === 0x42 && m.u8(0x8b96) === 0) return di + 1; // 3A16: with the hurt timer at zero the call is skipped
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
    case 74: projectileRunsOut(m, si, ctx); return ABORT; // 2685: the shot's run-out handler (EE60) on this entity
    case 55: // DispatchSpeedTickByKind
      if (m.u16(si + 4) === 1) { tickKind1(m, si, di); return ABORT; }
      if (m.u16(si + 4) === 2) { tickKind2(m, si, di, ctx); return ABORT; }
      if (m.u16(si + 4) === 7) return tickKind7(m, si, di, ctx); // DDBA
      if (m.u16(si + 4) === 4) return tickKind4(m, si, di, ctx); // DC1E
      return genericTick(m, si, di); // 2C90
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
    case 7: { // 3BBC SetPaletteBank: bank index -> 16-word palette at 8AE7 (the vsync wait and the hardware upload are not state)
      let ax = m.u8(di);
      m.w8(0x8c0d, ax);
      if (ax === 7) {
        const world = m.u16(0x8b89);
        ax = world === 1 ? 7 : world === 2 ? 0x13 : world === 3 ? 0x14 : world === 4 ? 0x15 : 7;
      }
      const src = m.u16(0xde56 + 2 * ax);
      for (let i = 0; i < 16; i++) m.w16(0x8ae7 + 2 * i, m.u16(src + 2 * i));
      return di + 1;
    }
    case 58: aimGlow(m, si); return di; // 2AE1
    case 68: return levelEvent(m, si, di, ctx); // 2755
    case 47: { // 2EC0: step towards the point (x, y) given by the two operands, keeping the slope
      let cx = m.u8(di), dx = m.u8(di + 1); di += 2;
      m.w16(0x8c1d, cx); m.w16(0x8c1f, dx);
      if (m.u16(si + 2) === 0x2b && m.u16(0x8c6b) !== 0) { m.w16(0x8c6b, m.u16(0x8c6b) - 1); return di; }
      const s16 = (v) => ((v & 0xffff) >= 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);
      cx = (cx - m.u16(si + 6)) & 0xffff;
      let sx, sy;
      let xZero = cx === 0;
      if (!xZero && s16(cx) < 0) cx = (-cx) & 0xffff;
      dx = (dx - m.u16(si + 8)) & 0xffff;
      const yZero = dx === 0;
      if (!yZero && s16(dx) < 0) dx = (-dx) & 0xffff;
      if (xZero) { sx = 1; sy = 8; }
      else if (yZero) { sx = 8; sy = 1; }
      else if (s16(cx) > s16(dx)) { sx = Math.floor(cx / dx); if (sx > 8) sx = 8; sy = 1; }
      else { sy = Math.floor(dx / cx); if (sy > 8) sy = 8; sx = 1; }
      const tx = m.u16(0x8c1d), ty = m.u16(0x8c1f);
      if (s16(tx) < s16(m.u16(si + 6))) m.w16(si + 6, m.u16(si + 6) - sx);
      else if (s16(tx) > s16(m.u16(si + 6))) m.w16(si + 6, m.u16(si + 6) + sx);
      if (s16(ty) < s16(m.u16(si + 8))) m.w16(si + 8, m.u16(si + 8) - sy);
      else if (s16(ty) > s16(m.u16(si + 8))) m.w16(si + 8, m.u16(si + 8) + sy);
      return di;
    }
    case 62: { // 2AC5: the player loses a life (the HUD icon steps down)
      const icon = findByClass(m, 0x18);
      if (m.u16(icon + 0xa) === 0x7b) { gameOverBody(m); return ABORT; } // 2AD1 -> 4A8D, then 2663
      m.w16(icon + 0xa, m.u16(icon + 0xa) - 1);
      m.w8(0x8bb4, m.u8(0x8bb4) + 1);
      return di;
    }
    case 43: { // 3031: walk along a line (Bresenham-style) towards an offset in 16-pixel cells
      const cl = m.u8(di); di += 1;
      m.w16(0x8c1f, sx8(m.u8(di)) & 0xffff); di += 1;
      m.w16(0x8c21, sx8(m.u8(di)) & 0xffff); di += 1;
      if (m.u16(si + 0x26) === 0) setupLineMotion(m, si, cl);
      const s16 = (v) => ((v & 0xffff) >= 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);
      for (let cx = m.u8(si + 0x3c); cx > 0; cx--) {
        let ax = (m.u16(si + 0x34) + m.u16(si + 0x28)) & 0xffff, dx, dy;
        if (s16(ax) < s16(m.u16(si + 0x32))) { m.w16(si + 0x28, ax); dx = m.u16(si + 0x2a); dy = m.u16(si + 0x2c); }
        else { ax = (ax - m.u16(si + 0x32)) & 0xffff; m.w16(si + 0x28, ax); dx = m.u16(si + 0x2e); dy = m.u16(si + 0x30); }
        m.w16(si + 6, m.u16(si + 6) + dx); m.w16(si + 8, m.u16(si + 8) + dy);
        m.w16(si + 0x26, m.u16(si + 0x26) - 1);
        if (m.u16(si + 0x26) === 0) { // 3086: arrived
          for (const o of [0x26, 0x28, 0x2a, 0x2c, 0x2e, 0x30, 0x32, 0x34]) m.w16(si + o, 0);
          m.w8(si + 0x3c, 0);
          return di;
        }
      }
      return ABORT;
    }
    case 8: { // 3A32: place the entity at (x, y) cells of the level (positive operands only)
      const x = m.s8(di);
      if (x < 0) return teleportViaTable(m, si, di + 1, ctx); // 3A5B
      if (x === 0) { // 3AF0: come back from the bonus room
        const hero = findByClass(m, 3);
        const bx = m.u16(0x8c5f), by = m.u16(0x8c61);
        m.w16(0x8c5f, 0); m.w16(0x8c61, 0);
        m.w16(si + 6, bx); m.w16(si + 8, by);
        if (m.u8(hero + 1) === 0x37) return di + 1;
        m.w16(si + 0x26, 0); m.w8(si + 1, 0); m.w8(0x8c0c, 0);
        m.w16(hero + 0x24, m.u16(hero + 0x24) | 2);
        m.w8(hero + 0x3e, 0); m.w8(hero + 1, 0);
        m.w16(hero + 0x10, 0x41); m.w16(hero + 0x12, 0x48); m.w16(hero + 0xa, 0x40);
        m.w16(0x8c38, 0);
        if (m.u8(0x8b98) === 1) m.w8(0x8b98, 0);
        return di + 1;
      }
      const y = m.s8(di + 1);
      m.w16(si + 6, (-(x * 0x20)) & 0xffff);
      m.w16(si + 8, (-(y * 0x10)) & 0xffff);
      return di + 2;
    }
    case 49: { // 2DA7: operand != 0 turns this entity into another class (C8C0)
      const cls = m.u8(di); di += 1;
      if (cls === 0) return carryItem(m, si, di, ctx); // 2DB5
      changeClass(m, si, cls);
      return di;
    }
    case 25: { // 39BD: the HUD kill-meter frame for this slot
      m.w16(0x8c6d, 0);
      if (m.u16(si + 6) === 0x128) m.w16(si + 0xa, (m.s8(0x8c05) & 0xffff) % 10 + 0x14);
      else if (m.u16(si + 6) === 8) {
        let ax = ((m.s8(0x8c05) * 2) << 24 >> 24) + (m.u16(0x8b8b) & 1);
        if (ax >= 0x12) ax = 0x56;
        m.w16(si + 0xa, ax);
      }
      return di;
    }
    case 45: { // 2FEF: run the rest of this script on another entity (the pair swaps registers)
      const target = findByClass(m, m.u8(di)); di += 1;
      m.w16(si + 0xc, m.u16(target + 0xc));
      m.w16(target + 0xc, di);
      ctx.partner = si; // BX keeps the original entity until opcode 46 swaps back
      ctx.swapTo = target;
      return di;
    }
    case 46: { // 3004: give the script back to the entity that started it
      const orig = ctx.partner;
      m.w16(si + 0xc, m.u16(orig + 0xc));
      m.w16(orig + 0xc, di);
      ctx.swapTo = orig;
      ctx.partner = si;
      return di;
    }
    case 77: { // 26B1: a random spark above or beside the clock (the operand is the spawn code in [8C1F])
      ctx.rng(m, 0);
      m.w16(0x8c1f, m.u8(di)); di += 1;
      m.w16(0x8c27, 0x90); m.w16(0x8c25, 0x48); m.w16(0x8c29, 0xf);
      const rnd = m.u16(0x8b6b);
      m.w16(0x8c21, rnd & 1);
      if ((rnd & 1) !== 0) {
        m.w16(0x8c25, 0x58);
        m.w16(0x8c21, m.u8(0xee36 + (m.u16(0x8b6b) & 0xf)));
        m.w16(0x8c23, 4);
      } else {
        m.w16(0x8c27, 0xa0); m.w16(0x8c25, 0x58);
        m.w16(0x8c21, m.u8(0xee36 + (m.u16(0x8b6b) & 0xf)));
        m.w16(0x8c23, 8);
      }
      pushSpawnEvent(m);
      return di;
    }
    case 37: { // 31F5: change level. A negative operand replays the current one (the player continued after losing).
      if (m.u16(0x8b89) === 0) { ctx.unported.add('opcode 37 outside a world (3253)'); return ABORT; }
      const al = m.s8(di); di += 1;
      if (al > 0) { ctx.unported.add(`opcode 37 operand ${al}`); return ABORT; }
      if (al < 0) { // 3221
        m.w16(0x8c11, 0);
        m.w16(0x8b8b, m.u16(0x8b8b) - 1);
        m.w16(0x8b75, m.u16(0x8b7b)); m.w16(0x8b7f, m.u16(0x8b7d)); m.w16(0x8b83, 0);
      }
      ctx.levelStart = { world: m.u16(0x8b89), sub: m.u16(0x8b8b) + 1 }; // 323E -> 03FF: [8C27] + 1
      return ABORT;
    }
    case 26: { // 2741: cut the link between this entity and the one it is bound to ([si+0x2c] on both sides)
      const other = m.u16(si + 0x2c);
      m.w16(si + 0x2c, 0);
      m.w16(other + 0x2c, 0);
      return di; // the sound call (1D4C) touches only the sound driver's own state
    }
    case 52: { // 2CEA: the CONTINUE? screen waits for the fire key, counting [8C57] up in steps of 0x80
      if (m.u16(0x8b8b) === 0) { ctx.unported.add('opcode 52 sub-level 0 (2D8D)'); return ABORT; }
      m.w16(0x8c57, (m.u16(0x8c57) + 0x80) & 0xffff);
      if (m.u16(0x8c57) === 0) { ctx.gameRestart = 'demo'; return ABORT; } // 2D20: CONTINUE? timed out; the game starts over with the attract demo (jmp 0089)
      if ((m.u8(0x8b5d) & 0x80) === 0) return ABORT; // 2663: try again next iteration
      m.w16(0x8c57, 0); // 2D0B: the player accepted CONTINUE?; the sound request (1CCF) is graphics-side
      if (m.u8(0x8c0b) === 0) { ctx.gameRestart = 'newgame'; return ABORT; } // 2D4F: no continues left: GAME OVER, then a new game starts at world 1 level 1 (B56B, jmp 00C1)
      return di;
    }
    case 10: { // 2F8B: puppet another entity (operand 1: its class) once it is idle: operand 2 is its new state
      const bx = findByClass(m, m.s8(di));
      di += 1;
      if (m.u8(bx + 1) !== 0) return ABORT; // 2663: wait
      const st = m.s8(di); di += 1;
      m.w8(bx + 1, st & 0xff);
      m.w16(bx + 0xc, st >= 0 ? m.u16(0xcd88 + 2 * st) : m.u16(0xd996 + 2 * (st + 0x80)));
      return di;
    }
    case 69: // 268E: the type-0x42 enemy's hit box depends on its frame
      if (m.u16(si + 2) === 0x42) { if (m.u16(si + 0xa) === 0x5c) { m.w16(si + 0x1c, 0); m.w16(si + 0x20, 0x40); } else { m.w16(si + 0x1c, 0x10); m.w16(si + 0x20, 0x20); } }
      return di;
    case 73: { // 272D: the entity tracked in [+0x2e] is killed and the link cleared (+ sound 1CCF(0x2b))
      m.w8(m.u16(si + 0x2e) + 0x40, 0x19); m.w16(si + 0x2e, 0);
      return di;
    }
    case 70: // 3C4B: the horizontal speed word follows the frame (no operand)
      if (m.u16(si + 0xa) !== 0x77) m.w16(si + 0x1c, 4);
      else m.w16(si + 0x1c, m.u16(si + 0x14) === 4 ? 0x12 : 0xfff6);
      return di;
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
  m.w16(si + 0xc, di + idx + 1); // 3CE2: the cursor moves past the terminator, then the tick ends
  return ABORT;
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
  if (type !== 0x0a) return spawnOtherEffect(m, si, di, type, ctx);
  m.w16(0x8c21, m.u16(si + 0x24) & 0x80);
  if (m.u16(0x8c21) !== 0) return di; // 36CC: the player is flagged, nothing is spawned
  m.w16(0x8c21, m.u16(0x8bf3));
  m.w16(0x8bf3, 0x17);
  m.w16(0x8c23, m.u16(si + 0x14));
  m.w16(0x8c25, m.u16(si + 8));
  m.w16(0x8c27, m.u16(si + 6));
  const id = m.u16(0x8c69);
  m.w16(0x8c29, id);
  if (id === 0xe || id === 0x1b) { specialWeapon(m); return di; } // 35CE
  if (id === 0x27) { // 3670: a fan of up to four shots, 0x17..0x1a, as many as [8BF7] allows
    const n = m.u16(0x8bf7);
    m.w16(0x8c1f, n);
    m.w16(0x8c25, m.u16(0x8c25) + 8);
    m.w16(0x8c27, m.u16(0x8c27) + (m.u16(0x8c23) === 4 ? -6 : 0x1a));
    for (let k = 0; k < 4; k++) {
      m.w16(0x8c21, 0x17 + k);
      pushEvent5(m);
      if (n === k) break;
    }
    return di;
  }
  let w = m.u16(0x8b89);
  m.w16(0x8c1d, w);
  if (w === 0) { w = m.u16(0x8b8b); m.w16(0x8c1d, w); }
  const base = { 1: 0xa, 2: 0x30, 3: 0x35, 4: 0x3a }[w];
  if (base === undefined) return di;
  const spawn = () => { // 3943 / 3964 / 3985 / 39A6: the four shot strengths sit at different offsets from the player
    const v = id - base;
    if (v < 0 || v > 3) return;
    const left = m.u16(0x8c23) === 4;
    m.w16(0x8c25, m.u16(0x8c25) + [8, 4, 2, 0][v]);
    m.w16(0x8c27, m.u16(0x8c27) + (left ? [-6, -6, -10, -0x12][v] : [0x1a, 0x1a, 0x16, 0xe][v]));
    pushEvent5(m);
  };
  if (w === 4 && m.u8(0x8c03) !== 0) { // 38FA: with the double-shot flag a second shot follows (its sprite word is one higher)
    const y = m.u16(0x8c25), x = m.u16(0x8c27);
    spawn();
    m.w16(0x8c27, x); m.w16(0x8c25, y);
    m.w16(0x8c21, m.u16(0x8c21) + 1);
    if (m.u16(0x8c21) === 0x1b) m.w16(0x8c21, 0x17);
  }
  spawn();
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

/** 1000:DDBA opcode 55 for kind 7 (projectiles): the vertical arc and horizontal drift, per world. */
function tickKind7(m, si, di, ctx) {
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  if (world === 2) return tickKind7World2(m, si, di, ctx);
  if (world !== 1 && world !== 3 && world !== 4) return di; // DDDB
  if (m.u16(si + 0x26) === 0) { // load the vertical and horizontal speeds
    m.w8(si + 0x26, m.u8(di)); di += 1;
    m.w8(si + 0x27, m.u8(di)); di += 1;
  }
  let ax = sx8(m.u8(si + 0x26));
  if (ax < 0) moveDown(m, si, -ax); else moveUp(m, si, ax);
  if (ax > -15) m.w8(si + 0x26, m.u8(si + 0x26) - 1);
  const h = sx8(m.u8(si + 0x27));
  if (h < 0 || m.u16(si + 0x14) === 0) return ABORT;
  moveHorizontalByFlagsRunner(m, si, h);
  return ABORT;
}

/**
 * 1000:DC1E opcode 55 for kind 4 (scenery that patrols): [+0x26] is the current vertical speed, [+0x27] the target, [+0x28] the
 * step (+1 or -1) between them; at the target it reverses (and may turn round) and reloads the speed from the operand.
 */
function tickKind4(m, si, di, ctx) {
  if (m.u8(si + 0x28) === 0) { // first tick: load both speeds
    m.w8(si + 0x26, m.u8(di)); di += 1;
    m.w8(si + 0x27, m.u8(di)); di += 1;
    m.w8(si + 0x28, m.s8(si + 0x26) >= 0 ? 0xff : 1);
  }
  const v = m.s8(si + 0x26);
  if (v < 0) moveDown(m, si, -v); else moveUp(m, si, v);
  if (m.u16(si + 0x14) === 0) return ABORT;
  moveHorizontalByFlagsRunner(m, si, m.s8(si + 0x29));
  let al = m.s8(si + 0x26);
  if (al !== m.s8(si + 0x27)) { m.w8(si + 0x26, al + m.s8(si + 0x28)); return ABORT; }
  const step = m.s8(si + 0x28);
  const atEnd = al !== 0 && (al < 0 ? step < 0 : step >= 0); // DC8B: the speed has run out in the direction of the step
  const turnIf = (roll, want) => { rollRandom(m, si, ctx); if ((m.u16(0x8be5) !== 0) === want) m.w16(si + 0x14, m.u16(si + 0x14) ^ 0xc); };
  if (atEnd) {
    if (m.u8(si + 0x39) === 0xf) { // DCAC
      m.w8(si + 0x28, -step); m.w8(si + 0x26, al); m.w8(si + 0x27, 0);
      turnIf(null, true);
    } else {
      m.w8(si + 0x26, -al); m.w8(si + 0x27, 0);
      turnIf(null, false);
    }
    return ABORT;
  }
  const operand = m.u8(di); // DCCA
  if (m.u8(si + 0x39) !== 0xf) { m.w8(si + 0x26, 0); m.w8(si + 0x27, -operand); m.w8(si + 0x28, 0xff); return ABORT; }
  m.w8(si + 0x26, 0); // DCE2
  rollRandom(m, si, ctx);
  const rolled = m.u16(0x8be5) !== 0;
  const neg = m.s8(si + 0x28) < 0;
  if (rolled !== neg) { m.w8(si + 0x27, m.u8(di)); m.w8(si + 0x28, 1); } // DD0E
  else { m.w8(si + 0x27, -operand); m.w8(si + 0x28, 0xff); } // DD00
  return ABORT;
}

/** 1000:DE74 opcode 55 for kind 7 in world 2: world 1's arc, plus the [+0x29] mode that ends in the shot running out. */
function tickKind7World2(m, si, di, ctx) {
  if (m.u16(si + 0x26) === 0) { // load the vertical and horizontal speeds
    m.w8(si + 0x26, m.u8(di)); di += 1;
    m.w8(si + 0x27, m.u8(di)); di += 1;
  }
  let ax = sx8(m.u8(si + 0x26));
  const mode = m.u8(si + 0x29) !== 0;
  if (!(mode && ax === 0)) { // DE90: in that mode a zero speed skips the move and the decay
    if (ax < 0) moveDown(m, si, -ax); else moveUp(m, si, ax);
    if (ax > -15) m.w8(si + 0x26, (ax - 1) & 0xff);
  }
  if (!mode) { // DF27
    const h = sx8(m.u8(si + 0x27));
    if (h < 0 || m.u16(si + 0x14) === 0) return ABORT;
    moveHorizontalByFlagsRunner(m, si, h);
    return ABORT;
  }
  if (m.u16(si + 0x14) === 0) return ABORT; // DEB7
  moveHorizontalByFlagsRunner(m, si, sx8(m.u8(si + 0x27))); // DEC0
  if (m.u8(si + 0x26) !== 0) return ABORT;
  m.w8(si + 0x27, m.u8(si + 0x27) - 2);
  const left = m.s8(si + 0x27);
  if (left > 0) return ABORT; // jz/js DEDB: only a zero or negative value goes on
  if (m.u16(si + 2) === 0x33) { // DEDB
    m.w16(si + 0x14, 0); m.w16(si + 0x26, 0);
    if (m.u8(0x8c03) === 0) { m.w8(si + 1, 0xa8); m.w16(si + 0xc, 0xd150); } else { m.w8(si + 1, 0x67); m.w16(si + 0xc, 0xcbea); }
    return ABORT;
  }
  projectileRunsOut(m, si, ctx); // DF1C: xchg si,bx / call EE60
  return ABORT;
}

/** 1000:2C90 opcode 55 for the remaining kinds (kind 5 props among them): vertical arc, then drift. */
function genericTick(m, si, di) {
  if (m.u16(si + 0x26) === 0) {
    m.w8(si + 0x26, m.u8(di)); di += 1;
    m.w8(si + 0x27, m.u8(di)); di += 1;
  }
  let ax = sx8(m.u8(si + 0x26));
  if (ax < 0) moveDown(m, si, -ax); else moveUp(m, si, ax);
  if (ax <= -15) return ABORT;
  ax -= 1;
  if (m.u16(si + 4) === 5) ax -= 1;
  m.w8(si + 0x26, ax & 0xff);
  const h = sx8(m.u8(si + 0x27));
  if (h < 0 || m.u16(si + 0x14) === 0) return ABORT;
  moveHorizontalByFlagsRunner(m, si, h);
  return ABORT;
}

/**
 * 1000:2AE1 opcode 58: the aiming glow. Finds the world's target entity (class 0x15/0x40/0x41/0x43
 * by world, else class 0x1C), and shows the sprite frame pointing from this entity towards it.
 */
function aimGlow(m, si) {
  const kill = () => m.w8(si + 0x40, 0x19);
  if (m.u16(0x8c5f) !== 0 || (m.u16(0x8b89) === 4 && m.u16(0x8b8b) === 9)) { kill(); return; }
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  const cls = { 1: 0x15, 2: 0x40, 3: 0x41, 4: 0x43 }[world];
  if (cls === undefined) return;
  let bx = findByClass(m, cls);
  if (bx === 0 || m.u8(bx + 0x40) === 0xf6) { // 2B2E
    bx = findByClass(m, 0x1c);
    if (bx === 0) { kill(); return; }
  }
  // 1000:7227: direction flags and distances (in 32x16 cells) from this entity to the target
  const tx = m.u16(bx + 6), ty = m.u16(bx + 8), sx = m.u16(si + 6), sy = m.u16(si + 8);
  let flags = 0;
  if (m.s16(si + 8) < m.s16(bx + 8)) flags |= 2;
  if (m.s16(si + 6) < m.s16(bx + 6)) flags |= 8;
  if (m.s16(bx + 8) < m.s16(si + 8)) flags |= 1;
  if (m.s16(bx + 6) < m.s16(si + 6)) flags |= 4;
  const ax = Math.abs(m.s16(si + 6) - m.s16(bx + 6)), bxd = Math.abs(m.s16(si + 8) - m.s16(bx + 8)); // signed 16-bit differences
  m.w16(0x8c29, flags);
  m.w16(0x8c1b, Math.floor(ax / 0x20));
  m.w16(0x8c1d, Math.floor(bxd / 0x10));
  m.w16(0x8b9a, 0x10 + (bxd % 0x10)); // cx = 0x10 and dx = the last remainder survive the call
  m.w16(0x8c25, flags);
  const hero = findByClass(m, 3);
  let keep = false;
  if (hero !== 0 && m.u16(hero + 0x2c) !== 0) {
    const marker = m.u16(hero + 0x2c);
    keep = m.u16(marker + 2) === 0x11 && m.u8(marker + 0x40) === 0xf6;
  }
  if (!keep) m.w8(si + 0x3d, 0xff);
  const cx = m.s16(0x8c1b), cy = m.s16(0x8c1d);
  const far = cx > 6 && cy > 6;
  const vertBigger = cy > cx;
  const frame = {
    1: 0xa6, 2: 0xaa, 4: 0xac, 8: 0xa8,
    5: far ? 0xad : (vertBigger ? 0xa6 : 0xac),
    9: far ? 0xa7 : (vertBigger ? 0xa6 : 0xa8),
    6: far ? 0xab : (vertBigger ? 0xaa : 0xac),
    10: far ? 0xa9 : (vertBigger ? 0xaa : 0xa8),
  }[flags];
  if (frame !== undefined) m.w16(si + 0xa, frame);
}

/** 1000:C8C0: re-initialise an entity from class `cls`'s template (the spawn code's copy, minus placement). */
export function changeClass(m, si, cls) {
  const tpl = m.u16(0xc39a + 2 * cls);
  m.w8(si + 0x16, m.u8(tpl + 8));
  m.w8(si + 0x3d, m.u8(tpl + 0x10));
  m.w16(si + 4, m.u16(tpl + 0x18));
  m.w16(si + 0x10, m.u16(tpl + 2));
  m.w16(si + 0x12, m.u16(tpl + 4));
  m.w16(si + 0xa, m.u16(si + 0x10));
  resetExtendedFields(m, si);
  const hb = 0xf3af + m.u16(tpl + 0x1a);
  for (let i = 0; i < 6; i++) m.w16(si + 0x18 + 2 * i, m.u16(hb + 2 * i));
  m.w16(si + 2, cls);
}

/** 1000:35CE: the special weapon (ids 0xE and 0x1B): a fan of sprites whose count grows with the level. */
function specialWeapon(m) {
  m.w16(0x8c1f, m.u16(0x8bf7));
  m.w16(0x8c1d, m.u16(0x8bf9));
  m.w16(0x8c25, m.u16(0x8c25) + 8);
  m.w16(0x8c27, m.u16(0x8c27) + (m.u16(0x8c23) === 4 ? -6 : 0x1a));
  const push = (v) => { m.w16(0x8c21, v); pushSpawnEvent(m); };
  const tier = m.s8(0x8bb2);
  const lvl = m.u16(0x8c1d);
  if (lvl >= 3 || (lvl !== 0 && lvl !== 1 && lvl !== 2)) { push(0x13); if (tier !== 0) push(0x55); }
  if (lvl === 2 || lvl >= 3) { push(0x54); if (tier > 2) push(0x56); }
  if (lvl === 1 || lvl === 2 || lvl >= 3) { push(0x15); if (tier > 3) push(0x57); }
  push(0x14); if (tier > 4) push(0x58);
}

/** 1000:334E..35CB: the remaining opcode-13 effect types. @returns the next cursor or ABORT */
function spawnOtherEffect(m, si, di, type, ctx) {
  const sb = (o) => sx8(m.u8(o));
  if (type === 0x44) { // 3577
    m.w16(0x8c27, m.u16(si + 6) + 0x10);
    m.w16(0x8c25, m.u16(si + 8));
    m.w16(0x8c23, 4);
    if (m.u8(0x8b6b) & 1) m.w16(0x8c23, 8);
    m.w16(0x8c21, 0x3b);
    pushEvent5(m);
    return di;
  }
  if (type === 0x11 || type === 0x25 || type === 0x1d) { pushEntityEvent(m, si); return di; } // 35A4-35AA: C0AE
  if (type === 0x2d || type === 0x47) { // 35AD
    m.w16(0x8c27, m.u8(di)); m.w16(0x8c25, m.u8(di + 1)); m.w16(0x8c1f, m.u8(di + 2));
    m.w16(0x8c23, m.u16(si + 0x14));
    m.w16(0x8c21, m.u8(di + 3));
    pushSpawnEvent(m);
    return di + 4;
  }
  if (type === 0x1f) { // 3521: positioned by two signed offsets, with two unsigned parameters
    m.w16(0x8c27, (sb(di) + m.u16(si + 6)) & 0xffff);
    m.w16(0x8c25, (sb(di + 1) + m.u16(si + 8)) & 0xffff);
    m.w16(0x8c1f, m.u8(di + 2)); m.w16(0x8c21, m.u8(di + 3));
    m.w16(0x8c23, 0);
    pushSpawnEvent(m);
    return di + 4;
  }
  if (type === 0xf) { // 3550: a debris event at the entity, two parameters
    m.w16(0x8c27, m.u16(si + 6)); m.w16(0x8c25, m.u16(si + 8));
    m.w16(0x8c1f, 0x46);
    m.w16(0x8c23, m.u8(di)); m.w16(0x8c21, m.u8(di + 1));
    pushSpawnEvent(m);
    return di + 2;
  }
  if (type === 0x2b) { // 3454: tell the level where the world entity stands relative to the goal
    if (m.u8(0x8b97) > 4) di += 2;
    m.w16(0x8c29, m.u16(0x8b8b));
    const swap = (v) => ((v & 0xff) << 8) | (v >> 8 & 0xff);
    m.w16(0x8c27, swap(m.u16(0x8c65)));
    m.w16(0x8c25, swap(m.u16(0x8c67)));
    const world = findByClass(m, 1);
    m.w16(0x8c27, m.u16(0x8c27) - m.u16(world + 6));
    m.w16(0x8c25, m.u16(0x8c25) - m.u16(world + 8));
    m.w16(0x8c27, ((-m.u16(0x8c27)) & 0xffff) + 0x90);
    m.w16(0x8c25, ((-m.u16(0x8c25)) & 0xffff) + 0x50);
    m.w16(0x8c29, 0x2b);
    pushEvent3(m);
    return di;
  }
  if (type === 0x16) { // 372C: a projectile at the entity's side, parameter from the table at EEF1 indexed by +0x32
    m.w16(0x8c21, m.u8(0xeef1 + m.u8(si + 0x32)));
    m.w16(0x8c23, m.u16(si + 0x14));
    m.w16(0x8c27, m.u16(si + 6));
    m.w16(0x8c25, m.u16(si + 8) + 4);
    m.w16(0x8c27, m.u16(0x8c27) - 5);
    if (m.u16(0x8c23) !== 4) m.w16(0x8c27, m.u16(0x8c27) + 0x20);
    pushEvent5(m);
    return di;
  }
  if (type === 0x53) { // 3767: a 0x53 effect (the spitter's shot) from the entity's side; with item 0x41 held a random facing at the head
    if (m.u8(si + 0x39) !== 0x41) {
      m.w16(0x8c1f, (m.u8(0x8b6b) & 0xf) !== 0 ? 0x108 : 0x104);
      m.w16(0x8c21, m.u8(0xeef1 + m.u8(si + 0x32)));
      m.w16(0x8c23, m.u16(si + 0x14));
      m.w16(0x8c27, (m.u16(si + 6) - 5) & 0xffff); m.w16(0x8c25, (m.u16(si + 8) + 4) & 0xffff);
      if (m.u16(0x8c23) !== 4) m.w16(0x8c27, (m.u16(0x8c27) + 0x20) & 0xffff);
    } else { // 37BB
      const r = m.u8(0x8b6b) & 0xc;
      m.w16(0x8c23, r === 0 ? 4 : r === 0xc ? 8 : r);
      m.w16(0x8c1f, 0x108); m.w16(0x8c21, 0);
      m.w16(0x8c27, (m.u16(si + 6) + 8) & 0xffff); m.w16(0x8c25, (m.u16(si + 8) - 0x10) & 0xffff);
    }
    pushSpawnEvent(m); // C035
    return di;
  }
  if (type === 0x21) { // 34AE: like the generic effect but with unsigned offsets; a left-facing one sits 0x10 further left
    m.w16(0x8c27, (m.u8(di) + m.u16(si + 6)) & 0xffff);
    m.w16(0x8c25, (m.u8(di + 1) + m.u16(si + 8)) & 0xffff);
    m.w16(0x8c23, m.u16(si + 0x14));
    if (m.u16(0x8c23) === 4) m.w16(0x8c27, (m.u16(0x8c27) - 0x10) & 0xffff);
    pushEvent4(m);
    return di + 2;
  }
  if (type === 0x30) { // 342B: a five-word event from four unsigned bytes (x, y offsets, then two parameters)
    m.w16(0x8c27, (m.u8(di) + m.u16(si + 6)) & 0xffff);
    m.w16(0x8c25, (m.u8(di + 1) + m.u16(si + 8)) & 0xffff);
    m.w16(0x8c23, m.u8(di + 2)); m.w16(0x8c21, m.u8(di + 3));
    pushEvent5(m);
    return di + 4;
  }
  if (type === 0x4d) { // 36CD
    m.w16(0x8c23, m.u16(si + 0x14)); m.w16(0x8c27, m.u16(si + 6) - 5); m.w16(0x8c25, m.u16(si + 8) + 4);
    if (m.u16(0x8c23) !== 4) m.w16(0x8c27, m.u16(0x8c27) + 0x20);
    pushEvent4(m);
    return di;
  }
  if (type === 0x28 || type === 0x5f) { // 36FB
    m.w16(0x8c21, m.u8(0xeef1 + m.u8(si + 0x32)));
    m.w16(0x8c23, m.u16(si + 0x14)); m.w16(0x8c27, m.u16(si + 6)); m.w16(0x8c25, m.u16(si + 8));
    if (m.u16(0x8c23) !== 8) m.w16(0x8c27, m.u16(0x8c27) + 0x10);
    pushEvent5(m);
    return di;
  }
  if (type === 0xe || type === 0x1b) { // 34E0: a spark at the entity's corner; the random byte is rotated left once (it is a 16-bit rol of [8B6B])
    m.w16(0x8c27, m.u16(si + 6) + 8); m.w16(0x8c25, m.u16(si + 8) - 8);
    const r = m.u16(0x8b6b), rol = ((r << 1) | (r >> 15)) & 0xffff;
    m.w16(0x8b6b, rol);
    m.w16(0x8c1f, (rol & 0xf) + (rol & 3));
    m.w16(0x8c23, m.u8(di)); m.w16(0x8c21, m.u8(di + 1));
    pushSpawnEvent(m);
    return di + 2;
  }
  const special = [];
  if (special.includes(type)) { ctx.unported.add(`opcode 13 type 0x${type.toString(16)}`); return ABORT; }
  // 3406: the generic effect: two signed offsets from the entity, facing as the entity
  m.w16(0x8c27, (sb(di) + m.u16(si + 6)) & 0xffff);
  m.w16(0x8c25, (sb(di + 1) + m.u16(si + 8)) & 0xffff);
  m.w16(0x8c23, m.u16(si + 0x14));
  pushEvent4(m);
  return di + 2;
}

/** 1000:2DB5: opcode 49 with operand 0: the power-up the player picked becomes the item he carries. */
function carryItem(m, si, di, ctx) {
  m.w16(si + 6, m.u16(si + 6) - 8);
  const idx = m.u16(0x8bff);
  m.w16(0x8bff, 0);
  const al = m.u8(0xeeea + idx);
  if (al === 0x2a) { m.w16(si + 8, m.u16(si + 8) - 0x10); changeClass(m, si, al); return di; } // 2E0A
  if (al === 0x22) { m.w16(si + 6, m.u16(si + 6) - 8); changeClass(m, si, al); return di; } // 2E11
  if (al === 0x45) { m.w16(si + 8, m.u16(si + 8) - 0x10); changeClass(m, si, al); return di; } // 2E18
  if (m.u8(0x8b98) === 0x41) { ctx.unported.add(`opcode 49 item 0x${al.toString(16)} in mode 0x41`); return ABORT; }
  m.w16(0x8c1f, al);
  changeClass(m, si, 0x1a);
  m.w16(si + 0xa, al);
  let d = 0x9090; // C15F: find the entity's slot, close the gap, then C807 re-inserts it after the hero sprite
  while (m.u16(d) !== si && d < 0x91a8) d += 2;
  for (; ; d += 2) { const nx = m.u16(d + 2); m.w16(d, nx); if (nx === 0) break; }
  insertByGroup(m, 4, si, 0x9090);
  return di;
}

/** 1000:3A5B (opcode 8 with a negative operand): jump to the next waypoint of the level's table at [8C63]. */
function teleportViaTable(m, si, di, ctx) {
  if (m.u16(0x8c5f) !== 0) { // 3B55: already in the bonus room: freeze the hero and start the level transition
    const hero = findByClass(m, 3);
    m.w8(hero + 1, 0x47); m.w16(hero + 0xc, 0xc967);
    m.w8(0x8bee, 0xff);
    const t = findByClass(m, 7);
    m.w8(t + 1, 0xf9); m.w16(t + 0xc, 0xd922);
    return di;
  }
  let bx = m.u16(0x8c63);
  m.w16(0x8c29, m.u16(bx)); bx += 2;
  m.w16(0x8c27, m.u16(bx)); bx += 2;
  m.w16(0x8c25, m.u16(bx)); bx += 2;
  if (m.u16(0x8c29) === 0) { // 3B7A: no more waypoints: scroll back so the goal prop is on screen
    const goal = findByClass(m, 0x1c);
    if (goal === 0) return di;
    m.w16(si + 6, m.u16(si + 6) - (m.u16(goal + 6) - 0x90)); m.w16(si + 8, m.u16(si + 8) - (m.u16(goal + 8) - 0x50));
    m.w16(0x8c5f, 0); m.w16(0x8c61, 0);
    const t = findByClass(m, 7);
    m.w8(t + 1, 0xf9); m.w16(t + 0xc, 0xd922);
    m.w8(0x8bee, 1);
    return di;
  }
  m.w16(0x8c1d, m.u16(si + 6)); m.w16(0x8c1f, m.u16(si + 8));
  m.w16(si + 6, m.u16(0x8c29)); m.w16(si + 8, m.u16(0x8c27));
  m.w16(0x8c63, bx);
  if (m.u16(0x8c25) !== 0) {
    m.w16(0x8c5f, m.u16(0x8c1d)); m.w16(0x8c61, m.u16(0x8c1f));
    const t = findByClass(m, 7);
    m.w8(t + 1, m.u16(0x8c25) & 0xff);
    m.w16(t + 0xc, m.u16(0xd996 + 2 * m.u16(0x8c25)));
  } else {
    const flag = findByClass(m, 0x2b);
    m.w8(flag + 0x40, 0x19); // a missing flag writes into DS:0x0040, which the game never reads
  }
  return di;
}

/**
 * Opcode 68 (1000:2755), the level-event trigger every script can reach. A non-hero entity turns a pending
 * bonus request [8BB2] into a spawn event. The hero (class 3) runs the end-of-level / bonus-sequence
 * selector at 27DF: it parks its own script pointer in [si+0x2a] and starts one of the shared sequences.
 */
function levelEvent(m, si, di, ctx) {
  if (m.u16(si + 2) !== 3) {
    if (m.u8(0x8ba4) !== 0) { ctx.unported.add('opcode 68 C6E (difficulty counter)'); return ABORT; }
    const dl = m.u8(0x8bb2);
    if (dl === 0) return di; // 27DE
    m.w8(0x8bb2, 0);
    m.w16(0x8c1f, 0xb7 + dl); m.w16(0x8c21, 0); m.w16(0x8c23, 4);
    const world = m.u16(0x8b89);
    const table = world === 1 ? 0xee46 : world === 2 ? 0xee66 : world === 3 ? 0xee86 : 0xeec2;
    const at = table + 4 * m.u16(0x8b8b);
    m.w16(0x8c25, m.u16(at + 2));
    m.w16(0x8c27, m.u16(at));
    m.w16(0x8c25, m.u16(0x8c25) + 0x50);
    m.w16(0x8c27, m.u16(0x8c27) + 0x90);
    m.w16(0x8c29, 0x26);
    pushSpawnEvent(m);
    return di;
  }
  const world = m.u16(0x8b89), sub = m.u16(0x8b8b);
  const bossSequence = (script) => { m.w16(si + 0x2a, m.u16(si + 0xc)); m.w16(si + 0xc, script); return ABORT; };
  if (world === 1 && sub === 6) { // 2890: the boss' defeat step picks the ending sequence
    const step = m.s16(0x8c2f);
    const script = step === 0 ? 0xcd03 : step === 1 ? 0xcd1b : step === 2 ? 0xcd33 : 0;
    if (!script) return di;
    m.w16(0x8c2f, 0xffff);
    return bossSequence(script);
  }
  if (world === 2 && sub === 7) { // 28EB: the time bonus of the last level
    if (m.s8(0x8baf) < 0) return di;
    m.w8(0x8baf, 0xff);
    m.w8(si + 0x3e, (-(m.s8(0x8bae) - 0xc8)) & 0xff);
    return bossSequence(0xd2b0);
  }
  if (world === 3 && sub >= 8) { // 2914
    const n = m.u8(0x8c0e);
    if (n === 0) return di;
    m.w8(0x8c0e, 0);
    m.w8(si + 0x3e, (-(n - 0xc8)) & 0xff);
    m.w8(si + 0x27, m.u8(di));
    return bossSequence(0xd381);
  }
  if (world === 4 && sub === 9) { // 281A is reachable by no jump in the disassembly, so world 4 takes the generic path
    ctx.unported.add('opcode 68 hero event, world 4 sub 9 (generic path assumed)');
  }
  const marker = findByClass(m, 0x2d); // 2824
  if (marker !== 0) m.w8(marker + 0x40, 0x19);
  const startSequence = (script) => { m.w16(si + 0x2a, m.u16(si + 0xc)); m.w16(si + 0xc, script); return ABORT; };
  const c04 = m.u8(0x8c04), mode = m.u8(0x8b98);
  if (c04 === 0x40 || c04 === 0x15 || mode === 0x43 || mode === 0x41) { // 2941
    m.w8(0x8b98, 0); m.w8(0x8c04, 0); m.w16(si + 0x2c, 0);
    return startSequence(0xd280);
  }
  if (mode === 0x1a) { m.w8(0x8b98, 0); m.w16(si + 0x2c, 0); return startSequence(0xd298); } // 295E
  if (m.u16(0x8bff) !== 0) { // 29D8
    m.w8(si + 0x3e, (-(m.u16(0x8bff) - 0x14)) & 0xff);
    m.w16(0x8bff, 0);
    return startSequence(0xd306);
  }
  if (m.s8(0x8bb4) >= 0) { // 29FA: the clock's last count decides the time bonus
    const count = m.u8(0x8bb4);
    m.w8(0x8bb4, 0xff);
    if (count === 0) return startSequence(0xd31f); // the sound (1CCF) is graphics-side
    const ax = count + 0xf;
    if (ax >= 0x14) return ABORT;
    m.w8(si + 0x3e, ax);
    return startSequence(0xd31f);
  }
  if (m.u8(0x8c06) !== 0) { // 2976: the kill count decides a second bonus
    let found = false;
    for (let bx = 0x9398; bx < 0xb918; bx += 0x42) if (m.u16(bx + 2) !== 0 && (m.u16(bx + 4) === 2 || m.u16(bx + 4) === 4)) { found = true; break; }
    if (!found) m.w8(0x8c06, 0x64);
    m.w8(si + 0x3e, (-(m.u8(0x8c06) - 0xc8)) & 0xff);
    m.w8(0x8c06, 0);
    return startSequence(0xd2cf);
  }
  if (m.s8(0x8bee) < 0) { // 29B9
    m.w8(0x8bee, 0);
    m.w16(0x8b7f, m.u16(0x8b7f) + 0x7d0);
    m.w16(0x8b8b, 0x32);
    return startSequence(0xd2ee);
  }
  // 288C: call 25A5
  if (m.u8(0x8bac) !== 0) return di;
  m.w8(marker + 0x40, 0); // BX is still the class-0x2D marker (0 when there is none: the byte at DS:0x40)
  if (m.u8(0x8c33) === 0) {
    m.w8(marker + 1, 0xf); m.w16(marker + 0xc, 0xc5f5);
    levelCode(m, ctx);
  }
  return ABORT; // 25C3: pop ax; jmp 2663
}

/**
 * 1000:25C8: pick the letters of the level code shown after the level. Two random digits and the clock's
 * count index a table in another segment (ES = 0x2BA9, file offset 0x29E80); the word read is mixed with the
 * index. The glyph writes into the screen buffers are graphics only.
 */
function levelCode(m, ctx) {
  ctx.rng(m, 0); // 11FC
  const rnd = m.u16(0x8b6b);
  let ah = ((rnd >> 8) & 0xf) + (rnd & 7);
  ah = (ah + (m.u8(0x8bad) & 3)) & 0xff;
  m.w8(0x8bbf, ah);
  m.w8(0x8bc0, rnd & 7);
  const idx = ah * 8 + m.u8(0x8bc0);
  const word = m.exe[0x29e80 + 2 * idx] | (m.exe[0x29e80 + 2 * idx + 1] << 8);
  m.w16(0x8bc1, ((word ^ ((idx + 0xaab) & 0xffff)) & 0xffff) >> 1);
  m.w8(0x8bbf, (m.u8(0x8bbf) + 0x41) & 0xff);
  m.w8(0x8bc0, (m.u8(0x8bc0) + 1) & 0xff);
  m.w8(0x8c33, 1);
}
