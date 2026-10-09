// Entity_UpdateAll (1000:C91D) and the per-entity behavior code ported so far, over a DsMemory
// image. Everything here is a transliteration of the disassembly; the `1000:xxxx` comments give
// the source address. Branches that are not ported record themselves in `ctx.unported` and do
// nothing, so tools/attract-capture/conformance.mjs shows what is still missing.
//
// Roles (from the demo capture): class/kind 1 = the world entity, whose X/Y are the scroll
// origin; class/kind 3 = the player, parked at screen (144, 80); class 2 = the hero's drawn
// sprite, which tracks the player.

'use strict';

import { VISIBLE_LIST, ENTITY_ARRAY, findByClass } from './ds-memory.js';
import { runScript } from './script-runner.js';
import { terrainCollision, overlapTest } from './ground-collision.js';
import { fireAndCharge } from './fire.js';
import { behaviorKind2 } from './enemy.js';
import { Rng } from './rng.js';

export const G = {
  INPUT: 0x8b67, EXTRA_FLAGS: 0x8b5e, NO_INPUT: 0x8b5f, WALK_SPEED: 0x8b97, TARGET: 0x8b98,
  SCROLL_DX: 0x8bb7, SCROLL_DY: 0x8bb9, CAM_X: 0x8bbb, CAM_Y: 0x8bbd, FREEZE: 0x8ba1,
  SUBLEVEL: 0x8b8b, WORLD: 0x8b89, CUR_LIST: 0x8b87, SCRATCH_C27: 0x8c27, RNG_OUT: 0x8b6b,
};

/** 1000:3178. Advance an entity's animation frame once its delay counter [+0x3B] reaches `al`. */
function advanceAnim(m, si, al) {
  if (m.s8(si + 0x3b) < al) { m.w8(si + 0x3b, m.u8(si + 0x3b) + 1); return; }
  m.w8(si + 0x3b, 0);
  m.w16(si + 0xa, m.u16(si + 0xa) === m.u16(si + 0x12) ? m.u16(si + 0x10) : m.u16(si + 0xa) + 1);
}

/** 1000:C998 Entity_RebuildVisibleList: apply the scroll delta, then rebuild the 0x91BE list. */
export function rebuildVisibleList(m) {
  const dh = m.u8(0x8bb1);
  let si = ENTITY_ARRAY;
  let di = VISIBLE_LIST;
  // Copy pointers up to and including the first class-2 entity (the hero's sprite).
  let bx;
  do {
    bx = m.u16(si); m.w16(di, bx); si += 2; di += 2;
  } while (m.u16(bx + 2) !== 2);
  for (;;) {
    bx = m.u16(si); si += 2;
    if (bx === 0) continue;
    if (bx === 0xffff) break;
    if (m.s8(bx + 0x40) >= 0 && m.u16(bx + 4) !== 0) {
      m.w16(bx + 6, m.u16(bx + 6) + m.u16(G.SCROLL_DX));
      m.w16(bx + 8, m.u16(bx + 8) + m.u16(G.SCROLL_DY));
    }
    const x = m.s16(bx + 6), y = m.s16(bx + 8);
    if (x <= -64 || x >= 0x180 || y <= -64 || y >= 0xe0) {
      // 1000:CA0D off-screen entities: keep them only in the cases that need updates.
      let al = m.s8(bx);
      if (al === 0) { m.w16(di, bx); di += 2; continue; }
      if (al < 0) {
        if ((al & 0xff) !== dh) continue;
        m.w8(bx, -al); m.w16(di, bx); di += 2; continue;
      }
      al = -al;
      if ((al & 0xff) === dh) { m.w16(di, bx); di += 2; continue; }
      m.w8(bx, al);
      continue;
    }
    if (m.s8(bx) < 0) m.w8(bx, -m.s8(bx));
    m.w16(di, bx); di += 2;
  }
  m.w16(di, 0xffff);
}

/** 1000:D3CE Entity_UpdateCameraTargetFromEntity (SI = player). */
function updateCameraTarget(m, si) {
  const bx = findByClass(m, 1);
  const oldCamX = m.u16(G.CAM_X);
  const newCamX = m.u16(bx + 6) & 0xfffc;
  m.w16(G.CAM_X, newCamX);
  m.w16(G.SCROLL_DX, (newCamX - oldCamX) & 0xffff); // -(old - new)
  const oldCamY = m.u16(G.CAM_Y);
  m.w16(G.CAM_Y, m.u16(bx + 8));
  m.w16(G.SCROLL_DY, (m.u16(bx + 8) - oldCamY) & 0xffff);
  m.w16(bx + 0x14, m.u16(si + 0x14));
  m.w8(si + 0x26, m.u8(bx + 0x26));
  return bx;
}

/** 1000:D40A. Place the hero's sprite entity (class 2) from the player's facing. */
function placeHeroSprite(m, si) {
  const bx = findByClass(m, 2);
  if (m.u16(si + 0x14) === 4) { m.w16(bx + 0xa, 0xb4); m.w16(bx + 6, 0xa0); } else { m.w16(bx + 0xa, 0xb0); m.w16(bx + 6, 0x90); }
  return bx;
}

/** 1000:D596. Walk the world entity `si` by `ax`, if the player `bx` allows it. */
function walk(m, si, bx, ax) {
  if ((m.u16(bx + 0x14) & m.u16(si + 0x24) & m.u16(bx + 0x24)) !== 0) return;
  const bs = m.u8(bx + 1);
  const ok = bs === 0x1d || bs === 0x11 || bs === 0x35 || bs === 0x5d || bs === 0x5b || m.u8(si + 1) === 0xd || bs === 0;
  if (!ok) return;
  m.w16(si + 6, m.u16(si + 6) + ax);
  if (m.u8(si + 1) !== 0) return;
  advanceAnim(m, bx, m.s8(0x8b99)); // 1000:D5D6: the player's walk cycle
}

/** 1000:DB67: steering while the world entity is mid-jump or mid-fall. */
function airSteer(m, si, bx) {
  const ax = (m.s8(G.EXTRA_FLAGS) | m.u16(si + 0x24) | m.u16(bx + 0x24)) ^ 0xff;
  const al = ax & m.u8(G.INPUT);
  const airborne = m.u8(si + 1) === 0x10 || m.u8(si + 1) === 0x11;
  if (al & 4) { m.w16(bx + 0x14, 4); if (airborne) m.w16(si + 6, m.u16(si + 6) + 4); } else if (al & 8) { m.w16(bx + 0x14, 8); if (airborne) m.w16(si + 6, m.u16(si + 6) - 4); }
  advanceAnim(m, bx, 0);
}

/** 1000:3CE8 Entity_HandleCollisionOrStateDispatch (SI = the world entity). */
function handleCollisionOrStateDispatch(m, si, ctx) {
  if (m.u8(G.NO_INPUT) !== 0) return;
  const bx = findByClass(m, 3);
  const t = m.u8(G.TARGET);
  if (t === 1) { airSteer(m, si, bx); return; }
  if (t === 0x15 || t === 0x21 || t === 0x43 || t === 0x41) { ctx.unported.add(`3CE8 target ${t}`); return; }
  if (t === 3 || t === 0xff) return;
  if (m.u8(bx + 1) === 0x63) return;
  if (fireAndCharge(m, si, bx, ctx)) return;
  const ax = ((m.u8(G.EXTRA_FLAGS) | m.u16(si + 0x24) | m.u16(bx + 0x24)) ^ 0xff) & 0xffff;
  const c27 = (ax & 0xff00) | (ax & m.u8(G.INPUT));
  m.w16(G.SCRATCH_C27, c27);
  if (c27 & 2) { ctx.unported.add('3CE8 down/fire path 3E15'); return; }
  if (c27 & 1) { // 3DA5: Up starts a jump
    if (m.u8(si + 1) === 0 && m.u8(bx + 1) === 0) {
      m.w8(bx + 0x3e, 0);
      m.w8(si + 1, 0x10); m.w16(si + 0xc, 0xc601);
      m.w8(bx + 1, 0x12); m.w16(bx + 0xc, 0xc60a);
      if ((m.u16(G.RNG_OUT) & 3) === 0) ctx.events.push({ op: 'sound', id: 8 });
    }
  }
  m.w16(0x8bfd, 0);
  if (c27 & 4) { // Left
    m.w16(bx + 0x14, 4);
    walk(m, si, bx, m.s8(G.WALK_SPEED));
    return;
  }
  if (c27 & 8) { // Right
    m.w16(bx + 0x14, 8);
    walk(m, si, bx, -m.s8(G.WALK_SPEED));
    return;
  }
  if (m.u8(bx + 1) !== 0 || m.u8(si + 1) !== 0) return; // idle pose only when both are idle
  m.w16(bx + 0xa, 0x40); m.w16(bx + 0x10, 0x41); m.w16(bx + 0x12, 0x48);
}

/** 1000:DF5A. Entity-vs-entity interactions, driven by the kind-pair table at 0xF36F. */
function interactions(m, si, ctx) {
  if (m.u16(si + 2) === 0) return;
  const row = 0xf36f + m.u16(si + 4) * 8;
  for (let p = VISIBLE_LIST; ; p += 2) {
    const bx = m.u16(p);
    if (bx === 0xffff) return;
    const cl = m.u8(row + m.u16(bx + 4));
    if (cl === 0) continue;
    // DFAC: entity must exist; 0x63 is the terrain collision of the player against the map.
    if (m.u16(bx + 2) === 0) continue;
    if (cl === 0x63) terrainCollision(m, si, bx, ctx); else overlapTest(m, si, bx, cl, ctx);
  }
}

/** Kind 1 (the world entity), 1000:D2D1. */
function behaviorKind1(m, si, ctx) {
  if (m.u8(G.FREEZE) === 0x32 || m.u16(G.SUBLEVEL) === 0) return;
  const bx = findByClass(m, 3);
  if (m.u8(G.TARGET) === 0xff) return;
  handleCollisionOrStateDispatch(m, si, ctx);
  m.w16(0x8c01, 0);
  m.w16(bx + 0x24, 0);
  interactions(m, si, ctx);
}

/** Kind 3 (the player), 1000:D2FE. */
function behaviorKind3(m, si, ctx) {
  if (m.u8(G.TARGET) !== 0xff) {
    const world = updateCameraTarget(m, si); // D3CE; BX = world entity
    if (m.u16(G.WORLD) === 3) ctx.unported.add('D42C world 3');
    m.w16(0x8b9a, m.u16(0x8b9a) - 1);
    if (m.u8(0x8b96) !== 0) m.w8(0x8b96, m.u8(0x8b96) - 1);
    if (m.u8(world + 1) === 0) m.w16(world + 0x28, 0);
    const sprite = placeHeroSprite(m, si); // D40A; BX = sprite entity
    m.w8(sprite + 0x40, 0xf6);
    const t = m.u8(G.TARGET);
    let table = true; // false jumps straight to D3A4
    if (!(t === 1 || t === 3 || m.u8(si + 1) === 0x2f)) {
      const c04 = m.u8(0x8c04);
      if (c04 === 0x40 || c04 === 0x1b || c04 === 0x27 || c04 === 0x45) { // D3BC
        if (m.u8(si + 1) === 0x5d || m.u8(si + 1) === 0x5b) table = false;
        else m.w16(sprite + 0xa, m.u16(sprite + 0xa) + 3);
      } else {
        const q = Math.floor(m.u8(0x8b91) / 8);
        if (q !== 0) m.w16(sprite + 0xa, m.u16(sprite + 0xa) + q);
      }
    }
    if (table) {
      // D376: the sprite's offset from the player, from the per-frame table at 0xF4F9.
      const di = 0xf4f9 + 2 * ((m.u16(si + 0xa) - 0x1f) & 0xffff);
      let ax = m.u16(si + 8);
      ax = (ax & 0xff00) | ((ax + m.u8(di + 1)) & 0xff);
      m.w16(sprite + 8, (ax + 0x14) & 0xffff);
      const dx = m.s8(di);
      if (dx < 0) {
        if (m.u16(si + 0x14) === 4) m.w16(sprite + 6, m.u16(sprite + 6) + dx);
        else m.w16(sprite + 6, m.u16(sprite + 6) - dx);
      }
    }
  }
  // D3A4: rebuild the visible list (applies the scroll) and re-find the player in it.
  rebuildVisibleList(m);
  for (let di = VISIBLE_LIST; ; di += 2) {
    if (m.u16(m.u16(di) + 2) === 3) { m.w16(G.CUR_LIST, di + 2); break; }
  }
}

/** 1000:CA6D Entity_UpdateBehavior, dispatch head, branch order as in the original. */
export function updateBehavior(m, si, ctx) {
  const cls = m.u16(si + 2);
  const frz = m.u8(G.FREEZE);
  const kind = m.u16(si + 4);
  if (cls === 8) { rebuildVisibleList(m); return; } // D592
  let toKindDispatch = false; // CAD0
  let toCB10 = false;
  if (frz > 127) toCB10 = true;
  else if (cls === 0x5e) { ctx.unported.add('behavior class 0x5e'); return; }
  else if (frz === 0x66 || frz === 0x32) toCB10 = true;
  else if (cls === 0x1f || cls === 7) toKindDispatch = true;
  else if (cls === 0xf) { ctx.unported.add('behavior class 0xf'); return; }
  else if (cls === 0x2d) return;
  else if (frz === 0x45) toCB10 = true;
  else if (cls === 0x1e || cls === 0x11 || cls === 0x2f) { ctx.unported.add(`behavior class ${cls}`); return; }
  else toKindDispatch = true;
  if (toKindDispatch) {
    if (kind === 0) return;
    if (kind === 1) { behaviorKind1(m, si, ctx); return; }
    if (kind === 2) { behaviorKind2(m, si, ctx); return; }
    if (kind === 4 || kind === 5 || kind === 6 || kind === 7) { ctx.unported.add(`behavior kind ${kind}`); return; }
    interactions(m, si, ctx); // CB07
  }
  if (kind === 3) behaviorKind3(m, si, ctx); // CB10
}

/** 1000:C91D Entity_UpdateAll. `only` restricts which entity pointers run (for staged porting). */
export function updateAll(m, ctx, only = null) {
  let di = VISIBLE_LIST;
  for (;;) {
    m.w16(G.CUR_LIST, di);
    const si = m.u16(di);
    if (si === 0xffff) return;
    let freed = m.u8(si + 0x40) === 0x19;
    if (!freed) {
      if (only && !only.has(si)) { di = m.u16(G.CUR_LIST) + 2; continue; }
      if (m.u8(si + 1) !== 0) {
        runScript(m, si, ctx);
        freed = m.u8(si + 0x40) === 0x19;
      }
      if (!freed) {
        updateBehavior(m, si, ctx);
        di = m.u16(G.CUR_LIST) + 2;
        freed = m.u8(si + 0x40) === 0x19;
        if (!freed) continue;
      }
    }
    ctx.unported.add('entity freed (C961)'); // C950: FreeSlot compacts the pointer array
    di = m.u16(G.CUR_LIST) + 2;
  }
}

/** Call #1, 1000:0221 Camera_UpdateScroll: tile/pixel split of the world entity's position. */
export function cameraUpdateScroll(m) {
  const bx = findByClass(m, 1);
  if (bx !== 0) {
    const x = (-m.u16(bx + 6)) & 0xffff;
    const y = (-m.u16(bx + 8)) & 0xffff;
    m.w16(0x8b69, x & 0x1f);
    const col = Math.floor(x / 0x20);
    m.w16(0x8c15, x % 0x20);
    const row = Math.floor(y / 0x10);
    m.w16(0x8c17, y % 0x10);
    m.w16(0x8c1f, col);
    m.w16(0x8c21, row);
    m.w16(0x8c1d, (col * 0x80) & 0xffff);
    m.w16(0x8c13, (0x4200 + ((col * 0x80) & 0xffff) + row) & 0xffff);
  }
  m.w16(0x8c15, (-m.u16(0x8c15)) & 0xffff);
  m.w16(0x8c17, (-m.u16(0x8c17)) & 0xffff);
  m.w16(G.SCROLL_DX, 0);
  m.w16(G.SCROLL_DY, 0);
}
