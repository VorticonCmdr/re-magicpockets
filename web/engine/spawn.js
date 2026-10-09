// Level_UpdateEventQueue (call #6, 1000:C28F) and the generic entity spawn it drives (C2F3),
// transliterated over a DsMemory image. Events are pushed by fire.js (and, later, by level
// scripts) onto a stack growing down from 0x9396 and consumed newest first. Only the generic spawn
// path is ported; the per-type special cases and the template groups that reorder the pointer
// array record themselves in `ctx.unported`.

'use strict';

import { ENTITY_ARRAY, ENTITY_ARRAY_END, ENTITY_SIZE } from './ds-memory.js';
import { rebuildVisibleList } from './entity-behavior.js';

const QUEUE_TOP = 0x9396;
const TEMPLATE_INDEX = 0xc39a; // word per type: pointer to the type's template record
const HITBOX_TABLE = 0xf3af;
const BLOCK_START = 0x9398;
const BLOCK_END = 0xb918;

const be16 = (m, o) => (m.u8(o) << 8) | m.u8(o + 1);

/** 1000:C176: first unused entity record (class 0) in the block, or 0. */
function findFreeRecord(m) {
  for (let si = BLOCK_START; si < BLOCK_END; si += ENTITY_SIZE) if (m.u16(si + 2) === 0) return si;
  return 0;
}

const SPECIAL_TYPES = new Set([0x11, 0x25, 0x1f, 0x1d, 0x44, 0x53, 0x2b, 0x2f, 0x5e]);

/**
 * 1000:C2F3: spawn one event. `slot` is the free pointer-array slot; `data` points past the type
 * word. Returns the new slot cursor and event pointer (unchanged when nothing was spawned).
 */
function spawn(m, slot, type, tag, data, ctx) {
  const none = { di: slot, si: data };
  m.w16(0x8c29, type);
  m.w16(0x8c1b, tag);
  m.w16(0x8c1d, data);
  const tpl = m.u16(TEMPLATE_INDEX + 2 * type);
  const si = findFreeRecord(m);
  if (si === 0) return none;
  if (type === 0) { m.w16(slot, 0); return { di: slot + 2, si: data }; }
  m.w16(0x8c77, tpl);
  m.w8(si + 0x16, m.u8(tpl + 8));
  m.w8(si + 0x3d, m.u8(tpl + 0x10));
  m.w16(si + 4, m.u16(tpl + 0x18));
  m.w16(si + 0x10, m.u16(tpl + 2));
  m.w16(si + 0x12, m.u16(tpl + 4));
  m.w16(si + 0xa, m.u16(si + 0x10));
  const hb = HITBOX_TABLE + m.u16(tpl + 0x1a);
  for (let i = 0; i < 6; i++) m.w16(si + 0x18 + 2 * i, m.u16(hb + 2 * i));
  // 1000:241F Entity_ResetExtendedFields
  for (const o of [0x3e, 0x40, 0x3f, 0x39, 0x36, 0x37, 0x38, 0x3a, 0x3b, 0x3c]) m.w8(si + o, 0);
  for (const o of [0x24, 0x26, 0x28, 0x2a, 0x2c, 0x2e, 0x30, 0x32]) m.w16(si + o, 0);
  m.w8(si + 0x3f, 4);
  m.w8(si, 0);
  const kind = m.u16(si + 4);
  if (kind !== 0 && kind !== 7 && kind !== 6) m.w8(si, 0xff);
  const st = m.u8(tpl + 6);
  m.w8(si + 1, st);
  m.w16(si + 0xc, st < 128 ? m.u16(0xcd88 + 2 * st) : m.u16(0xd996)); // the negative branch ignores the state (original quirk)
  if (SPECIAL_TYPES.has(type)) { ctx.unported.add(`spawn type 0x${type.toString(16)}`); return none; }
  // C40C: generic placement from the event data
  let bx = data;
  m.w16(si + 2, type);
  m.w16(si + 6, be16(m, bx)); bx += 2;
  m.w16(si + 8, be16(m, bx)); bx += 2;
  if (tag >= 4) {
    m.w16(si + 0x14, be16(m, bx)); bx += 2;
    if (tag >= 5) {
      if (tag === 8) { ctx.unported.add('spawn tag 8'); return none; }
      const w = be16(m, bx); bx += 2;
      m.w8(si + 1, w & 0xff);
      m.w16(si + 0xc, m.u16(0xcd88 + 2 * w));
      if (tag >= 6) {
        m.w16(si + 0xa, be16(m, bx)); bx += 2;
        if (tag >= 7) { m.w16(si + 0x26, be16(m, bx)); bx += 2; }
      }
    }
  }
  const group = m.u16(tpl);
  if (group >= 1 && group <= 6) { ctx.unported.add(`spawn template group ${group}`); return none; }
  if (slot >= ENTITY_ARRAY_END) return { di: slot, si: bx };
  m.w16(slot, si); // C512: append at the free slot
  return { di: slot + 2, si: bx };
}

/** Call #6, 1000:C28F. */
export function levelUpdateEventQueue(m, ctx) {
  let si = m.u16(0x8bb5);
  if (si !== QUEUE_TOP) {
    let di = ENTITY_ARRAY;
    si += 2;
    for (let guard = 0; guard < 64; guard++) {
      if (m.u16(di) === 0xffff) break;
      if (m.u16(di) !== 0) { di += 2; continue; }
      if (be16(m, si) !== 0xeeee) break;
      si += 2; // the marker
      const tag = be16(m, si); si += 2;
      const type = be16(m, si); si += 2;
      if (type === 0) { di += 2; continue; }
      const r = spawn(m, di, type, tag, si, ctx);
      if (r.di === di && r.si === si) break; // nothing spawned: the next marker test fails
      di = r.di; si = r.si;
    }
  }
  m.w16(0x8bb5, QUEUE_TOP);
  if (m.u16(0x8b89) === 0 && m.u16(0x8b8b) === 0) rebuildVisibleList(m);
}
