// 1000:4269 (the fire/charge routine called from Entity_HandleCollisionOrStateDispatch) and the
// spawn-event pushes it uses, transliterated over a DsMemory image.
//
// `[8B91]` is the charge meter (0..0x1F), `[8B93]` its per-frame increment, `[8BFB]` a cooldown,
// `[8B8F]` a release countdown. Releasing the button (or pressing it with a direction) puts the
// player into state 0x1D (the punch script at 0xC65A) with frames 0x61..0x68.

'use strict';

const EVENT_FLOOR = 0x926a; // spawn events grow downward from [8BB5]; below this the queue is full

function pushWord(m, si, value) { // big-endian in memory, as `mov al,ah; mov ah,lo; mov [si],ax` stores it
  m.w8(si, (value >> 8) & 0xff);
  m.w8(si + 1, value & 0xff);
}

/** 1000:BF6D: push a 4-word spawn event (x, y, a, b) from the scratch words, tag 4. */
export function pushEvent4(m) {
  let si = m.u16(0x8bb5);
  if (si < EVENT_FLOOR) return;
  for (const a of [0x8c23, 0x8c25, 0x8c27, 0x8c29]) { pushWord(m, si, m.u16(a)); si -= 2; }
  pushWord(m, si, 4); si -= 2;
  m.w16(si, 0xeeee); si -= 2;
  m.w16(0x8bb5, si);
}

/** 1000:C035 Entity_PushSpawnEvent: a 6-word event, tag 6. */
export function pushSpawnEvent(m) {
  let si = m.u16(0x8bb5);
  if (si < EVENT_FLOOR) return;
  for (const a of [0x8c1f, 0x8c21, 0x8c23, 0x8c25, 0x8c27, 0x8c29]) { pushWord(m, si, m.u16(a)); si -= 2; }
  pushWord(m, si, 6); si -= 2;
  m.w16(si, 0xeeee); si -= 2;
  m.w16(0x8bb5, si);
}

const frameIs4x = (m, bx) => m.u16(bx + 0xa) === 0x40 || m.u16(bx + 0xa) === 0x4f;

/** 1000:45CF */
function checkTimerEvent(m, bx) {
  if (m.s16(0x8b9a) >= 0) return;
  m.w16(0x8b9a, 0);
  m.w16(0x8c23, m.u16(bx + 0x14));
  m.w16(0x8c25, m.u16(bx + 8));
  m.w16(0x8c27, m.u16(bx + 6));
  m.w16(0x8c29, 0x1e);
  pushEvent4(m);
}

/** 1000:4464: per-world offset into [8C69], and the 100-shot bonus event. */
function weaponId(m, bx, ax, ctx) {
  let cx = m.u16(0x8b89);
  if (cx === 0) cx = m.u16(0x8b8b);
  const add = { 1: 0xa, 2: 0x30, 3: 0x35, 4: 0x3a }[cx];
  if (add === undefined) return;
  m.w16(0x8c69, (ax + add) & 0xffff);
  m.w16(0x8bf1, m.u16(0x8bf1) + 1);
  if (m.u16(0x8bf1) !== 0x64) return;
  m.w16(0x8c1f, m.u16(0x8bf5));
  m.w16(0x8c21, 0x14);
  m.w16(0x8c23, m.u16(bx + 0x14));
  m.w16(0x8c27, 0x98);
  m.w16(0x8c25, 0x58);
  m.w16(0x8c29, 0x0e);
  pushSpawnEvent(m);
  m.w16(0x8bf1, 0);
  if (m.u8(0x8bb2) !== 0) m.w16(0x8bf1, (m.u16(0x8bf5) * 5) & 0xffff);
  if (m.u16(0x8bf5) !== 0x12) m.w16(0x8bf5, m.u16(0x8bf5) + 2);
}

/**
 * @returns {boolean} true when the caller (3CE8) must stop too (the original's `pop ax; ret`).
 */
export function fireAndCharge(m, si, bx, ctx) {
  const bs = m.u8(bx + 1);
  if (m.u8(si + 1) === 0x11 || bs === 0x43 || bs === 0x37 || bs === 0x35 || bs === 0xaa) return false;
  const blockers = (m.u8(0x8b5e) | m.u16(si + 0x24) | m.u16(bx + 0x24)) ^ 0xff;
  if ((blockers & 0x80) === 0) return false;
  let level = 0; // DX at 43A1: the charge level that triggers the release
  if (m.u8(0x8b67) & 0x80) { // 42B7: fire held
    if (m.u16(0x8bfb) !== 0) { m.w16(0x8bfb, m.u16(0x8bfb) - 1); return frameIs4x(m, bx); }
    m.w8(0x8b91, m.u8(0x8b91) + m.u8(0x8b93));
    if (m.s8(0x8b91) > 0x1f) { m.w8(0x8b91, 0x1f); ctx.unported.add('5609 charge maxed'); }
    m.w8(0xbbea, m.u8(0x8b91));
    if (!frameIs4x(m, bx)) return false;
    level = m.u8(0x8b91);
    const ax = (blockers & 0xff00) | (blockers & m.u8(0x8b67));
    m.w16(0x8c27, ax);
    let id;
    if (ax & 2) id = 0x1a; else if (ax & 1) id = 0x18; else if (ax & 4) id = 0x19; else if (ax & 8) id = 0x19;
    else { m.w8(0x8b8f, 1); return true; }
    m.w16(0x8c27, ax & (ax & 2 ? 2 : ax & 1 ? 1 : ax & 4 ? 4 : 8));
    m.w16(0x8bf3, id);
  } else { // 436F: fire released
    if (m.u16(0x8bfb) !== 0) { m.w16(0x8bfb, m.u16(0x8bfb) - 1); return false; }
    m.w8(0x8b8f, 1);
    level = m.u8(0x8b91);
    if (level === 0) return false;
    if (!frameIs4x(m, bx)) m.w16(0x8bf3, 0x17);
  }
  // 43A1
  m.w8(0x8b8f, m.u8(0x8b8f) - 1);
  if (m.u8(0x8b8f) !== 0) return true;
  // 43AA: the release itself
  const c04 = m.u8(0x8c04);
  if (c04 !== 0x1d && c04 !== 0x40) {
    if (m.u8(0x8b98) === 0x41) { m.w8(bx + 1, 0x2d); m.w16(bx + 0xc, 0xc754); }
    else if (m.u8(bx + 1) === 0x12 || m.u16(bx + 0xa) === 0x4f) { m.w8(bx + 1, 0x35); m.w16(bx + 0xc, 0xc7f7); }
    else {
      m.w8(bx + 1, 0x1d); m.w16(bx + 0xc, 0xc65a);
      m.w16(bx + 0x10, 0x61); m.w16(bx + 0x12, 0x68);
      m.w16(bx + 0xa, m.u16(bx + 0x10));
    }
  }
  m.w8(0xbbea, 0x20);
  m.w8(0x8b8f, m.u8(0x8b90));
  m.w16(0x8bfb, m.u8(0x8b90));
  m.w8(0x8b91, 0);
  const ax = Math.floor(((level - 1) & 0xffff) / 8);
  if (c04 === 0xe || c04 === 0x1d || c04 === 0x40 || c04 === 0x1b || c04 === 0x27) { ctx.unported.add(`4269 special mode ${c04}`); return false; }
  weaponId(m, bx, ax, ctx);
  checkTimerEvent(m, bx);
  return m.u16(bx + 0xa) === 0x40;
}
