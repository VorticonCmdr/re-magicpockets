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
 * 1000:C7B8-C88F: the spawn template's group places the new entity `si` in the pointer array.
 * 1 and 2 go to the front list that ends at 0x91BA; 3, 4 and 6 insert (shifting the rest up) before
 * the first class 3/8, after the first class 2, after the first class 0x1C; 5 inserts into the front
 * list after the class-7 entry. Returns the slot where the caller's next append goes.
 */
export function insertByGroup(m, group, si, slot) {
  const FRONT_END = 0x91ba;
  const firstZeroFrom = (di) => { while (m.u16(di) !== 0 && di < 0x9400) di += 2; return di; };
  if (group === 1) { m.w16(FRONT_END, si); return slot; }
  if (group === 2) {
    let di = FRONT_END;
    do di -= 2; while (m.u16(di) !== 0);
    m.w16(di, si);
    return slot;
  }
  const rotate = (di, until) => {
    let cur = si;
    if (until === 'end') { // C7E4: shift every entry up to the end of the array
      for (;;) {
        const old = m.u16(di); m.w16(di, cur); di += 2;
        cur = m.u16(di); m.w16(di, old); di += 2;
        if (di === 0x91ac) break;
      }
    } else { // C816/C86F: shift until a zero is displaced
      for (;;) {
        const ax = m.u16(di); m.w16(di, cur); di += 2;
        cur = m.u16(di); m.w16(di, ax); di += 2;
        if (ax === 0) break;
      }
    }
  };
  if (group === 3) { // C7D2: before the first class 3 or 8 entity (slot 0 on a hero-first list)
    rotate(ENTITY_ARRAY, 'end');
    return firstZeroFrom(slot);
  }
  if (group === 4 || group === 6) { // C807 / C860: after the first class 2 / 0x1C entity
    const cls = group === 4 ? 2 : 0x1c;
    let di = ENTITY_ARRAY, bx;
    do { bx = m.u16(di); di += 2; } while (m.u16(bx + 2) !== cls && di < 0x91a8);
    rotate(di, 'zero');
    return firstZeroFrom(slot);
  }
  // group 5, C837: into the front list, after the class-7 entry
  let di = FRONT_END, bx;
  do { bx = m.u16(di); di -= 2; } while (m.u16(bx + 2) !== 7 && di > 0x9190);
  let cur = si;
  for (;;) {
    const ax = m.u16(di); m.w16(di, cur);
    if (ax === 0) break;
    cur = m.u16(di - 2); m.w16(di - 2, ax);
    di -= 4;
  }
  return slot;
}

/** 1000:C4DE: place the finished record in the pointer array according to its template's group. */
function finishSpawn(m, si, slot, bx, tpl) {
  const group = m.u16(tpl);
  if (group >= 1 && group <= 6) return { di: insertByGroup(m, group, si, slot), si: bx };
  if (slot >= ENTITY_ARRAY_END) return { di: slot, si: bx };
  m.w16(slot, si); // C512: append at the free slot
  return { di: slot + 2, si: bx };
}

/** 1000:30B3: set up the direction/step fields of an entity that walks a line to (8C1F, 8C21) cells away. */
export function setupLineMotion(m, si, cl) {
  m.w8(si + 0x3c, (cl + 1) & 0xff);
  const s16 = (v) => ((v & 0xffff) >= 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);
  let fx = (s16(m.u16(0x8c1f)) * 16 + m.u16(si + 6)) & 0xffff; m.w16(0x8c1f, fx);
  let fy = (s16(m.u16(0x8c21)) * 16 + m.u16(si + 8)) & 0xffff; m.w16(0x8c21, fy);
  let ax = (fx - m.u16(si + 6)) & 0xffff;
  if ((ax & 0x8000) === 0) { m.w16(si + 0x2e, 1); m.w16(si + 0x32, ax); }
  else { m.w16(si + 0x2e, 0xffff); ax = (-ax) & 0xffff; m.w16(si + 0x32, ax); }
  ax = (fy - m.u16(si + 8)) & 0xffff;
  if ((ax & 0x8000) === 0) { m.w16(si + 0x30, 1); m.w16(si + 0x34, ax); }
  else { m.w16(si + 0x30, 0xffff); ax = (-ax) & 0xffff; m.w16(si + 0x34, ax); }
  if (s16(ax) <= s16(m.u16(si + 0x32))) { // 3116: x is the major axis
    m.w16(si + 0x2c, 0); m.w16(si + 0x2a, m.u16(si + 0x2e));
  } else {
    m.w16(si + 0x2a, 0); m.w16(si + 0x2c, m.u16(si + 0x30));
    const a = m.u16(si + 0x32), d = m.u16(si + 0x34);
    m.w16(si + 0x34, a); m.w16(si + 0x32, d);
  }
  m.w16(si + 0x26, m.u16(si + 0x32));
  m.w16(si + 0x28, m.u16(si + 0x32) >> 1);
}

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
  let bx = data;
  if (type === 0x1f && tag === 7) { // C601: a platform that walks a line
    m.w16(si + 2, type);
    m.w16(si + 6, be16(m, bx)); bx += 2;
    m.w16(si + 8, be16(m, bx)); bx += 2;
    m.w16(si + 0xa, be16(m, bx)); bx += 2;
    m.w8(si + 1, 0xa);
    m.w16(si + 0xc, m.u16(0xcd88 + 2 * 0xa));
    const cl = m.u8(bx + 1); bx += 2; // CH:CL = the next word; only CL is used
    m.w16(0x8c1f, be16(m, bx)); bx += 2;
    const dx = be16(m, bx); m.w16(0x8c21, dx); bx += 2;
    setupLineMotion(m, si, cl);
    return finishSpawn(m, si, slot, bx, tpl);
  }
  if (type === 0x11) { // C523: a marker bound to another entity, given as a raw pointer
    m.w16(si + 2, type);
    const parent = m.u16(bx); bx += 2;
    if (m.u8(parent + 1) === 1 || m.u16(parent + 0x2c) !== 0 || m.u16(parent + 2) === 0 || m.u8(parent + 0x40) === 0x19) return { di: slot, si };
    m.w16(si + 6, m.u16(parent + 6));
    m.w16(si + 8, m.u16(parent + 8) - 8);
    m.w16(si + 0x2c, parent); m.w16(parent + 0x2c, si);
    m.w8(si + 0x40, 0xf6);
    return finishSpawn(m, si, slot, bx, tpl);
  }
  if (type === 0x1d) { // C5D7: a shot bound to the entity that fired it
    m.w16(si + 2, type);
    const parent = m.u16(bx); bx += 2;
    m.w16(si + 6, m.u16(parent + 6)); m.w16(si + 8, m.u16(parent + 8)); m.w16(si + 0x14, m.u16(parent + 0x14));
    m.w16(si + 0x2c, parent);
    m.w8(si + 0x40, 0xf6);
    m.w8(si + 0x3f, m.u16(0x8bf9) & 0xff);
    return finishSpawn(m, si, slot, bx, tpl);
  }
  if (type === 0x44) { // C66C: a falling pickup with a random initial speed
    m.w16(si + 2, type);
    m.w16(si + 6, be16(m, bx)); bx += 2;
    m.w16(si + 8, be16(m, bx)); bx += 2;
    m.w16(si + 0x14, be16(m, bx)); bx += 2;
    const w = be16(m, bx); bx += 2;
    m.w8(si + 1, w & 0xff);
    m.w16(si + 0xc, m.u16(0xcd88 + 2 * (w & 0xff)));
    m.w16(si + 0x26, m.u16(0x8b6b) & 0x70f);
    return finishSpawn(m, si, slot, bx, tpl);
  }
  if (type === 0x53 && m.u16(bx + 6) === 0) { // C6AF
    m.w16(si + 2, type);
    m.w16(si + 6, be16(m, bx)); bx += 2;
    m.w16(si + 8, be16(m, bx)); bx += 2;
    m.w16(si + 0x14, be16(m, bx)); bx += 4;
    m.w16(si + 0xa, be16(m, bx)); bx += 2;
    m.w8(si + 1, 0x3b);
    m.w16(si + 0xc, m.u16(0xcd88 + 2 * 0x3b));
    m.w16(si + 0x26, 0x204);
    return finishSpawn(m, si, slot, bx, tpl);
  }
  if (type === 0x2b) { // C707: presets, then the generic placement
    m.w8(si, 0); m.w8(si + 0x3f, 0x14); m.w8(si + 0x36, 0x32); m.w16(si + 0x14, 4);
  } else if (SPECIAL_TYPES.has(type) && type !== 0x1f && type !== 0x53) { ctx.unported.add(`spawn type 0x${type.toString(16)}`); return none; }
  // C40C: generic placement from the event data
  m.w16(si + 2, type);
  m.w16(si + 6, be16(m, bx)); bx += 2;
  m.w16(si + 8, be16(m, bx)); bx += 2;
  if (tag >= 4) {
    m.w16(si + 0x14, be16(m, bx)); bx += 2;
    if (tag >= 5) {
      if (tag === 8) { // C48A: animation set, hit points and the enemy's three tuning bytes
        m.w8(si + 0x39, m.u8(bx)); bx += 1;
        m.w8(si + 0x36, m.u8(bx)); bx += 1;
        m.w8(si + 0x37, m.u8(bx)); bx += 1;
        m.w8(si + 0x38, m.u8(bx)); bx += 1;
        m.w8(si, m.u8(bx + 1)); bx += 2; // MOV AX / MOV [SI],AL: the low byte of the big-endian word
        let al = m.u8(si + 0x36);
        const world = m.u16(0x8b89);
        if (m.u16(si + 2) !== 0x42 && world !== 4) {
          al >>= 1;
          if (world === 3) al = (al + (al >> 1)) & 0xff;
        }
        m.w8(si + 0x3f, al);
        if (m.u8(0x8ba3) !== 0) {
          m.w8(si + 0x3f, m.u8(si + 0x3f) + al);
          if (m.u8(si + 0x3f) === 0) m.w8(si + 0x3f, 1);
        }
        return finishSpawn(m, si, slot, bx, tpl);
      }
      const w = be16(m, bx); bx += 2;
      m.w8(si + 1, w & 0xff);
      m.w16(si + 0xc, m.u16(0xcd88 + 2 * w));
      if (tag >= 6) {
        m.w16(si + 0xa, be16(m, bx)); bx += 2;
        if (tag >= 7) { m.w16(si + 0x26, be16(m, bx)); bx += 2; }
      }
    }
  }
  return finishSpawn(m, si, slot, bx, tpl);
}

/** Call #6, 1000:C28F. */
export function levelUpdateEventQueue(m, ctx) {
  let si = m.u16(0x8bb5);
  if (si !== QUEUE_TOP) {
    let di = ENTITY_ARRAY;
    si += 2;
    for (let guard = 0; guard < 400; guard++) { // the array's 0xFFFF terminator ends the real loop
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

/** 1000:C1C0: the level list for sub-level `n`: a big-endian offset at DS:[2n] (0 selects the default at 0x1E). */
export function levelListPointer(m, n) {
  n &= 0xff;
  if (n === 0) return 0x1e;
  const si = be16(m, 2 * n);
  m.w16(0x8c65, m.u16(si + 6));
  m.w16(0x8c67, m.u16(si + 8));
  return si;
}

/**
 * 1000:C1E6 Level_LoadEntities: spawn every entry of the list at `si` through the same generic spawn
 * the event consumer uses. Markers: 0xAAAA ends the list (after a world-1/sub-level-6 tweak, not ported),
 * 0xBBBB switches to another sub-level's list, 0xCCCC waits (not needed at boot), 0xDDDD restarts.
 */
export function levelLoadEntities(m, si, ctx) {
  let di = ENTITY_ARRAY;
  for (let guard = 0; guard < 4000; guard++) {
    while (m.u16(di) !== 0) di += 2;
    const w = be16(m, si); si += 2;
    if (w === 0xaaaa) { if (m.u16(0x8b89) === 1 && m.u16(0x8b8b) === 6) ctx.unported.add('C229 world 1 sub-level 6 setup'); return; }
    if (w === 0xbbbb) { const n = be16(m, si); si += 2; si = levelListPointer(m, n); continue; }
    if (w === 0xcccc || w === 0xdddd) { ctx.unported.add(`C1F4 marker 0x${w.toString(16)}`); return; }
    const tag = be16(m, si); si += 2;
    const type = be16(m, si); si += 2;
    const r = spawn(m, di, type, tag, si, ctx);
    if (r.di === di && r.si === si) { ctx.unported.add('C2F3 spawn did not complete'); return; }
    di = r.di; si = r.si;
  }
}
