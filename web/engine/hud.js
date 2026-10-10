// Call #12, Hud_UpdateScoreDisplay (1000:0B92): mirrors the score, triggers the kill-bonus meter
// and the 1000-point extra-life burst, and converts the score to the digit bytes of the HUD text
// buffer at 0xE70E. Sound requests (1000:1CCF) are skipped; they write nothing compared yet.

'use strict';

import { findByClass } from './ds-memory.js';
import { pushSpawnEvent } from './fire.js';
import { bonus } from './hit.js';

const s16 = (v) => ((v & 0xffff) >= 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);

/** 1000:0C6E: the extra-life burst (a row of 8 event sprites). */
function extraLife(m) {
  m.w8(0x8c03, 4);
  const life = findByClass(m, 0x18);
  m.w16(life + 0xa, 0x7f);
  m.w8(0x8b90, 2);
  m.w8(0x8b93, 3);
  for (const [a, v] of [[0x8c29, 0xf], [0x8c27, 0x98], [0x8c25, 0x58], [0x8c1f, 0x46], [0x8c23, 4]]) m.w16(a, v);
  for (let v = 0x48; v <= 0x4f; v++) { m.w16(0x8c21, v); pushSpawnEvent(m); }
}

export function hudUpdateScoreDisplay(m, ctx) {
  if (m.u8(0x8c33) !== 0) return;
  const score = m.u16(0x8b75);
  m.w16(0x8b77, score);
  if (s16(score - m.u16(0x8b83)) >= 0x32 && s16(score) >= s16(m.u16(0x8b85))) {
    m.w16(0x8b85, m.u16(0x8b85) + 0x32);
    bonus(m, ctx);
  }
  if (s16(score - m.u16(0x8b7f)) >= 0x3e8 && m.u8(0x8ba1) === 0) {
    m.w16(0x8b7f, m.u16(0x8b7f) + 0x3e8);
    extraLife(m);
    if (m.u16(0x8b7f) === 0x2710) m.w8(0x8c0b, m.u8(0x8c0b) + 1);
  }
  // 0BEF: the digits (table of place values at 0xEE14..0xEE1E, most significant first)
  let di = 0xe70e;
  let cx = m.u16(0x8b75);
  for (let si = 0xee1e; si !== 0xee14; si -= 2) {
    let dx = 0;
    const place = m.u16(si);
    for (;;) {
      if (cx === 0) break;
      if (cx === place) { dx++; cx = 0; break; }
      if (cx < place) break;
      cx -= place; dx++;
    }
    m.w8(di++, dx + 0xbc);
  }
  m.w8(di, cx + 0xbc);
  if (m.u16(0x8b89) === 3 && m.u16(0x8b8b) >= 8) {
    const put = (a, v) => { m.w8(0xe715 + a, 0xbc + Math.floor(v / 10)); m.w8(0xe715 + a + 1, 0xbc + (v % 10)); };
    put(0, m.u8(0x8baf)); put(3, m.u8(0x8bae));
  }
}

/**
 * Call #5, Fx_UpdateTransition (1000:1028): the palette-fade state byte [8BA2]. 0x19 finishes a
 * fade (the screen copy it triggers is graphics only); the stepping states 0xFB-0xFF and the
 * special values 1, 0x32 and 0x63 are not ported.
 */
export function fxUpdateTransition(m, ctx) {
  const al = m.u8(0x8ba2);
  if (al === 0) return;
  if (al === 0x19) { m.w8(0x8ba2, 0); return; }
  if (al === 0x1) { screenWipeStep(m); return; }
  if (al === 0x32 || al === 0x63) return; // 8722 / 8667: copies or clears video memory only (no DS write) [STATIC]
  ctx.unported.add(`Fx_UpdateTransition state 0x${al.toString(16)}`);
}

/**
 * 1000:87A1 (state 1): one step of the screen wipe. Only the state it keeps is modelled: the wipe
 * position [8C3C] (advances by 0x2C up to 0x1130), the two mask words [8C3E]/[8C40] that shrink and
 * grow as it moves, and the stage counter [8C42]. The video-memory writes are graphics only.
 * [8DED] (outside the captured globals) remembers that the first call has been made.
 */
function screenWipeStep(m) {
  if (m.u16(0x8c3c) === 0x1130) { wipeDone(m); return; } // 88A8
  if (m.u8(0x8ded) === 0) {
    m.w8(0x8ded, 0xff);
    const cx = (-m.u16(0x8b69)) & 0xf;
    if (cx !== 0) {
      m.w8(0x8ded, 1);
      m.w16(0x8c3e, m.u16(0x8c3e) >> cx);
      m.w16(0x8c40, (m.u16(0x8c40) << cx) & 0xffff);
    }
  }
  let shift = true;
  if (m.u16(0x8c40) === 0) { // 8844
    m.w16(0x8c3e, 0xffff); m.w16(0x8c40, 0xffff);
    if (m.u16(0x8c42) !== 0x15) { m.w16(0x8c42, m.u16(0x8c42) + 1); shift = false; }
  }
  if (shift) { // 885D
    m.w16(0x8c40, (m.u16(0x8c40) << 1) & 0xffff);
    m.w16(0x8c3e, m.u16(0x8c3e) >> 1);
  }
  if (m.u16(0x8c3c) !== 0x1130) m.w16(0x8c3c, m.u16(0x8c3c) + 0x2c);
}

function wipeDone(m) { // 88A8
  m.w8(0x8ba2, 0); m.w8(0x8ded, 0); m.w16(0x8c34, 0x16);
  m.w16(0x8c3c, 0); m.w16(0x8c3e, 0xffff); m.w16(0x8c40, 0xffff); m.w16(0x8c42, 0);
}
