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
import { fireAndCharge, pushEvent3, pushEvent5, pushSpawnEvent } from './fire.js';
import { behaviorKind2, behaviorKind4, behaviorKind5, behaviorKind6, behaviorKind7 } from './enemy.js';
import { Rng } from './rng.js';
import { nextByClass } from './enemy.js';
import { heroLosesHeart } from './hit.js';

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

/** 1000:3FE2: the player grabs the crate (class 0xD/0x33) he is standing against. */
export function crateGrab(m, si, bx) {
  m.w8(0x8b98, 1);
  m.w8(si + 1, 0x1c); m.w16(si + 0xc, 0xc655);
  m.w16(si + 0x14, m.u16(bx + 0x14));
  m.w16(bx + 0x10, 0x90); m.w16(bx + 0x12, 0x93); m.w16(bx + 0xa, 0x90);
  m.w8(bx + 1, 0);
  m.w8(0x8bb3, m.u8(0x8bb3) + 1);
  m.w8(0x8b96, 0);
}

/** 1000:4014: pick up the item prop `di`: it rides the player from now on. */
function takeItem(m, si, bx, di) {
  if (m.u8(di + 1) === 0x8e) return;
  if (m.u16(di + 0x2a) === 0) m.w16(di + 0x2a, 0x3e8);
  m.w16(0x8c71, Math.floor(m.u16(di + 0x2a) / 0x3c));
  m.w8(0x8b98, 0x1a);
  m.w8(di + 0x40, 0xf6);
  m.w16(di + 0x2c, bx);
  m.w8(di + 1, 0); m.w8(di + 0x3e, 0);
  switch (m.u16(di + 0xa) & 0xfffe) {
    case 0xe0: m.w16(di + 0xa, 0xe4); break; // 4067 (the alternate-build screen call is skipped)
    case 0xe8: // 4091
      m.w8(0x8b96, 0x32);
      m.w8(si + 1, 0x95); m.w16(si + 0xc, 0xd020);
      m.w8(di + 1, 0x9d); m.w16(di + 0xc, 0xd0c9);
      m.w8(findByClass(m, 7) + 0x3e, 0x96);
      break;
    case 0xea: m.w8(0x8b96, 1); break; // 40B5
    case 0xec: m.w8(0x8c04, 0x1d); break; // 40BB
    default: break; // 0xe6: nothing
  }
}

/** 1000:3E15: Down was pressed: interact with the prop remembered in [8C01]. */
function downPressed(m, si, bx, ctx) {
  if (m.u8(0x8b67) & 0x80) return;
  if (m.u16(0x8bfd) !== 0) return;
  m.w16(0x8bfd, 1);
  if (m.u8(si + 1) !== 0) return;
  let ax = 2, item = 0;
  if (m.u16(0x8c01) !== 0) { item = m.u16(0x8c01); ax = m.u16(item + 2); m.w16(0x8c01, 0); }
  const t = m.u8(0x8b98), c04 = m.u8(0x8c04);
  const unp = (n) => ctx.unported.add(`3E15 ${n}`);
  if (ax === 0x22) { // 3EE8: the prop starts its pressed state
    if (m.u8(item + 1) !== 6) { m.w8(item + 1, 6); m.w16(item + 0xc, 0xc4cb); }
    return;
  }
  if (t !== 0x1a) {
    if (ax === 0x29) { unp('class 0x29'); return; }
    if (t === 0x43) { unp('target 0x43'); return; }
    if (c04 === 0x40) { unp('c04 0x40'); return; }
    if (ax === 0x24) { unp('class 0x24'); return; }
    if (ax === 0xd || ax === 0x33) { crateGrab(m, si, bx); return; }
    if (t !== 0x41 && ax === 0x1a) { takeItem(m, si, bx, item); return; } // 4014
    if (c04 === 0x27) { // 3F0F
      m.w8(0x8c04, 0); m.w16(0x8c25, 0x50); m.w16(0x8c27, 0x90); m.w16(0x8c29, 0x2a);
      pushEvent3(m);
      return;
    }
  }
  if (c04 === 0x45) { // 3F72
    m.w8(0x8c04, 0);
    m.w16(0x8c21, 0x5f); m.w16(0x8c23, 0); m.w16(0x8c25, 0x50); m.w16(0x8c27, 0x90); m.w16(0x8c29, 0x45);
    pushEvent5(m);
    return;
  }
  if (ax === 0x2a) { // 3EF8
    if (m.u16(0x8bef) === 0) m.w16(0x8bef, 0x3e8);
    m.w8(0x8c04, 0x27); m.w8(item + 0x40, 0x19);
    return;
  }
  if (ax === 0x45) { // 3F29
    const st = m.u8(item + 1);
    if (st === 0xf) return;
    if (st !== 0x5f) { m.w8(item + 0x3e, 0); m.w8(item + 1, 0x5f); m.w16(item + 0xc, 0xcb2a); m.w16(0x8c5d, 0); return; }
    if (m.u16(item + 0xa) !== 0xa) return;
    m.w16(0x8c5d, m.u16(0x8c5d) + 1); m.w8(0x8c04, 0x45); m.w8(item + 0x40, 0x19);
    return;
  }
  if (t === 0x1a) { unp('target 0x1a'); return; }
  if (ax === 0x41) { takeItem(m, si, bx, item); return; } // 4014
  if (ax === 0x15) { // 3FB3
    if (m.u8(bx + 1) !== 0) return;
    m.w8(0x8b94, 0); m.w8(0x8b97, 0); m.w8(0x8c04, 0x15);
    m.w8(bx + 1, 0x34); m.w16(bx + 0xc, 0xc7ef);
    m.w8(item + 0x40, 0x19);
    m.w8(findByClass(m, 0x1c) + 0x3e, 0x1d);
    return;
  }
  if (ax === 0x40 || ax === 0x43) unp(`class 0x${ax.toString(16)}`);
}

/**
 * 1000:D67D (target 0x41, world 3): the hero floats on the carried float: the world entity `si` is moved by the keys (D73A), a splash event
 * every 17th tick, the world entity's vertical speed byte from [8C59], and the hero's frame advances while a key is held.
 */
function floatControls(m, si, bx, ctx) {
  fireAndCharge(m, si, bx, ctx); // 4269
  floatMove(m, si, bx, ctx);
  m.w16(0x8c5b, m.u16(0x8c5b) + 1);
  if (m.u16(0x8c5b) === 0x11) {
    const r = m.u8(0x8b6b) & 3; // the matching sound (1CCF) is graphics-side
    m.w16(0x8c1f, r === 1 ? 0x101 : r === 2 ? 0x102 : r === 3 ? 0xff : 0x100);
    m.w16(0x8c5b, 0);
    m.w16(0x8c21, 0x32); m.w16(0x8c23, 4); m.w16(0x8c25, 0x50); m.w16(0x8c27, 0x98); m.w16(0x8c29, 0x55);
    pushSpawnEvent(m);
  }
  let ax = m.s16(0x8c59);
  if (ax !== 0) { if (ax < 0) ax = -ax; ax = ((ax + 2) * 4) & 0xffff; }
  m.w8(si + 0x28, ax & 0xff);
  if (m.u8(bx + 1) !== 0) return;
  m.w8(0x8b5e, 0);
  const al = (((m.u16(si + 0x24) | m.u16(bx + 0x24)) ^ 0xff) & m.u8(0x8b67)) & 0xff;
  if (al === 0 || (al & 2) !== 0) return;
  advanceAnim(m, bx, 1); // 3178 with SI = the hero
}

/** 1000:D73A: the keys move the world entity while floating. */
function floatMove(m, si, bx, ctx) {
  const cl = (((m.u8(0x8b5e) | m.u16(si + 0x24)) ^ 0xff) & m.u8(0x8b67)) & 0xff;
  if (cl & 4) { // D7CF
    if ((m.u16(bx + 0x24) & 4) === 0) { m.w16(bx + 0x14, 4); m.w16(si + 6, m.u16(si + 6) + 4); }
  } else if (cl & 8) { // D7E3
    if ((m.u16(bx + 0x24) & 8) === 0) { m.w16(bx + 0x14, 8); m.w16(si + 6, m.u16(si + 6) - 4); }
  }
  if (m.u8(si + 1) === 0xd) return; // D795
  if (cl & 1) { // D796
    if (m.s16(0x8c59) !== 4) m.w16(0x8c59, m.u16(0x8c59) + 1);
    if ((m.u16(bx + 0x24) & 1) !== 0) { m.w16(0x8c59, 0); return; }
    m.w16(si + 8, m.u16(si + 8) + m.u16(0x8c59));
    return;
  }
  if (m.u8(si + 1) !== 0) return;
  if ((m.u16(bx + 0x24) & 2) !== 0) { // D7B1
    m.w16(0x8c59, 0);
    if (cl & 2) downPressed(m, si, bx, ctx); else m.w16(0x8bfd, 0);
    return;
  }
  if (m.s16(0x8c59) !== -3) m.w16(0x8c59, m.u16(0x8c59) - 1);
  const dx = m.u16(0x8c59);
  m.w16(si + 8, m.u16(si + 8) + dx);
  if (cl & 2) m.w16(si + 8, m.u16(si + 8) + dx); else m.w16(0x8bfd, 0);
}

/** 1000:3CE8 Entity_HandleCollisionOrStateDispatch (SI = the world entity). */
function handleCollisionOrStateDispatch(m, si, ctx) {
  if (m.u8(G.NO_INPUT) !== 0) return;
  const bx = findByClass(m, 3);
  const t = m.u8(G.TARGET);
  if (t === 1) { airSteer(m, si, bx); return; }
  if (t === 0x15 || t === 0x21 || t === 0x43) { ctx.unported.add(`3CE8 target ${t}`); return; }
  if (t === 0x41) { floatControls(m, si, bx, ctx); return; } // D67D
  if (t === 3 || t === 0xff) return;
  if (m.u8(bx + 1) === 0x63) return;
  if (fireAndCharge(m, si, bx, ctx)) return;
  const ax = ((m.u8(G.EXTRA_FLAGS) | m.u16(si + 0x24) | m.u16(bx + 0x24)) ^ 0xff) & 0xffff;
  const c27 = (ax & 0xff00) | (ax & m.u8(G.INPUT));
  m.w16(G.SCRATCH_C27, c27);
  if (c27 & 2) { downPressed(m, si, bx, ctx); return; } // 3E15
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
export function interactions(m, si, ctx) {
  if (m.u16(si + 2) === 0) return;
  const row = 0xf36f + m.u16(si + 4) * 8;
  for (let p = VISIBLE_LIST; ; p += 2) {
    const bx = m.u16(p);
    if (bx === 0xffff) return;
    const cl = m.u8(row + m.u16(bx + 4));
    if (cl === 0) continue;
    // DFAC: entity must exist; 0x63 is the terrain collision of the player against the map.
    if (m.u16(bx + 2) === 0) continue;
    if (cl === 0x63) terrainCollision(m, si, bx, ctx); else if (overlapTest(m, si, bx, cl, ctx)) return;
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

/**
 * 1000:D42C (world 3, the player's tick): the player standing in water. [8BEA] sums the water flags of the four probes; above 0x20 the
 * player is in the water: he drops what he carries, sinks into state 0xAA (and loses a heart unless invulnerable) and spawns the
 * two splash events; carrying the float (class 0x41 in state 0xF6, [8B98] = 0x41) he floats instead. `si` is the player, `bx` the world entity.
 */
function worldThreeSwim(m, si, bx, ctx) {
  if (m.u8(si + 1) === 0x47) return;
  const flags = m.u8(0x8bea);
  const floatItem = () => { let it = 0x9398; for (;;) { it = nextByClass(m, it, 0x41); if (it === 0) return 0; if (m.u8(it + 0x40) === 0xf6) return it; } };
  if (m.u8(0x8b98) === 0x41) { // D533: floating
    if (flags > 0x20 || m.u8(si + 1) === 0x71) return;
    if (m.u8(bx + 1) === 0xd) { m.w8(0x8b98, 0x1a); return; }
    m.w8(bx + 1, 0xd); m.w16(bx + 0xc, 0xc5a5); m.w16(bx + 0x26, 0);
    m.w16(si + 0xa, 0x4f); m.w16(si + 0x10, 0x4f); m.w16(si + 0x12, 0x4f);
    const it = floatItem(); if (it !== 0) m.w16(it + 0xa, 0xe4);
    return;
  }
  if (flags <= 0x20) return;
  const it = floatItem();
  if (it !== 0) { // D4AF: the player takes the float
    m.w16(it + 0xa, 0xe3);
    m.w16(si + 0xa, 0x36); m.w16(si + 0x10, 0x36); m.w16(si + 0x12, 0x38);
    m.w8(0x8b98, 0x41); m.w8(bx + 1, 0); m.w8(si + 1, 0);
  } else {
    if (m.u8(0x8b98) === 1 || m.u8(0x8b98) === 0x1a) m.w8(0x8b98, 0);
    if (m.s8(bx + 0x26) >= 0) return;
    if (m.u8(si + 1) === 0xaa) return;
    m.w8(bx + 1, 0); m.w16(bx + 0x26, 0);
    m.w8(si + 1, 0xaa); m.w16(si + 0xc, 0xd171);
    if (m.u8(0x8b96) === 0) heroLosesHeart(m, si, ctx); // 4A50
  }
  // D4D1: a splash where the water starts, if one of the five cells ahead is a water tile
  const di = m.u16(0x8bd7);
  let ax = (m.u16(0x8bd9) - 0x20) & 0xffff;
  let hit = m.s8(di) < 0;
  for (let k = 1; k <= 4 && !hit; k++) { ax = (ax - 0x10) & 0xffff; hit = m.s8(di - k) < 0; }
  if (!hit) return;
  m.w16(0x8c25, ax); m.w16(0x8c27, 0x90); m.w16(0x8c29, 0x52); pushEvent3(m);
  m.w16(0x8c27, 0x96); m.w16(0x8c25, (ax + 0x1c) & 0xffff); m.w16(0x8c29, 0x55); pushEvent3(m);
}

/** Kind 3 (the player), 1000:D2FE. */
function behaviorKind3(m, si, ctx) {
  if (m.u8(G.TARGET) !== 0xff) {
    const world = updateCameraTarget(m, si); // D3CE; BX = world entity
    if (m.u16(G.WORLD) === 3) worldThreeSwim(m, si, world, ctx); // D42C
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
  else if (cls === 0xf) { behaviorClassF(m, si); return; } // CB1C
  else if (cls === 0x2d) return;
  else if (frz === 0x45) toCB10 = true;
  else if (cls === 0x1e) { // CC01
    const al = m.u8(si + 0x3d);
    if (!(al & 0x80)) advanceAnim(m, si, al);
    return;
  } else if (cls === 0x11) { behaviorClass11(m, si, ctx); return; } // CC52
  else if (cls === 0x2f) { behaviorClass2f(m, si); return; } // CC0F
  else toKindDispatch = true;
  if (toKindDispatch) {
    if (kind === 0) return;
    if (kind === 1) { behaviorKind1(m, si, ctx); return; }
    if (kind === 2) { behaviorKind2(m, si, ctx); return; }
    if (kind === 5) { behaviorKind5(m, si, ctx); return; }
    if (kind === 6) { behaviorKind6(m, si, ctx); return; }
    if (kind === 7) { behaviorKind7(m, si, ctx); return; }
    if (kind === 4) { behaviorKind4(m, si, ctx); return; }
    interactions(m, si, ctx); // CB07
  }
  if (kind === 3) behaviorKind3(m, si, ctx); // CB10
}

/** 1000:241F Entity_ResetExtendedFields. */
export function resetExtendedFields(m, si) {
  for (const o of [0x3e, 0x40, 0x3f, 0x39, 0x36, 0x37, 0x38, 0x3a, 0x3b, 0x3c]) m.w8(si + o, 0);
  for (const o of [0x24, 0x26, 0x28, 0x2a, 0x2c, 0x2e, 0x30, 0x32]) m.w16(si + o, 0);
}

/** 1000:C961 Entity_FreeSlot: drop `si` from the pointer array and compact it. */
export function freeSlot(m, si) {
  let di = ENTITY_ARRAY;
  let ax;
  do { ax = m.u16(di); di += 2; } while (si !== ax);
  m.w16(di - 2, 0);
  resetExtendedFields(m, si);
  m.w16(si + 2, 0);
  if (di >= 0x91a8) return;
  do { ax = m.u16(di); di += 2; m.w16(di - 4, ax); } while (di !== 0x91a8);
  m.w16(di - 2, 0);
}

/** 1000:C91D Entity_UpdateAll. `only` restricts which entity pointers run (for staged porting). */
export function updateAll(m, ctx, only = null) {
  let di = VISIBLE_LIST;
  for (;;) {
    m.w16(G.CUR_LIST, di);
    let si = m.u16(di);
    if (si === 0xffff) return;
    let freed = m.u8(si + 0x40) === 0x19;
    if (!freed) {
      if (only && !only.has(si)) { di = m.u16(G.CUR_LIST) + 2; continue; }
      if (m.u8(si + 1) !== 0) {
        si = runScript(m, si, ctx); // opcode 45 may leave SI on another entity
        if (ctx.levelStart) return; // the level change never returns to the main loop (opcode 37 jumps out)
        freed = m.u8(si + 0x40) === 0x19;
      }
      if (!freed) {
        updateBehavior(m, si, ctx);
        di = m.u16(G.CUR_LIST) + 2;
        freed = m.u8(si + 0x40) === 0x19;
        if (!freed) continue;
      }
    }
    freeSlot(m, si); // C950
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

const kill = (m, si) => m.w8(si + 0x40, 0x19);

/** 1000:CB1C class 0xF (frame-driven effect sprites; the frame number selects the step). */
function behaviorClassF(m, si) {
  const f = m.s16(si + 0xa), rnd = m.u16(0x8b6b);
  const cb48 = () => { advanceAnim(m, si, m.u8(si + 0x3d)); if (m.u16(si + 0xa) === 0x4f) kill(m, si); };
  const cb61 = () => { m.w16(si + 0xa, 0x46); cb48(); };
  const fall = () => { if (m.s16(si + 8) > 0xc8) kill(m, si); };
  if (f === 0x46) { cb48(); return; }
  if (f < 0x46) { fall(); return; } // CB59
  if (f === 0x50) { // CB68
    if ((rnd & 1) === 0) { cb61(); return; }
    m.w16(si + 0x10, 0x50); m.w16(si + 0x12, 0x5b);
    advanceAnim(m, si, 0);
    fall();
    return;
  }
  if (f === 0xc8) { m.w16(si + 0xa, rnd & 0xf); return; } // CB88
  if (f === 0x64) { // CBBC
    const v = rnd & 3;
    if (v === 0) { cb61(); return; }
    const frame = v === 1 ? 0x66 : v === 2 ? 0x67 : 0x1e;
    m.w16(si + 0xa, frame); m.w16(si + 0x10, frame); m.w16(si + 0x12, frame);
    return;
  }
  if (f === 0x96) { m.w16(si + 0xa, (rnd & 1) ? 0x14 : 0x1d); return; } // CBA5
  if (f === 0xfa) { m.w16(si + 0xa, (rnd & 7) + 0x15); return; } // CB95
  cb48();
}

/** 1000:CC0F class 0x2F: an overlay that follows the entity it was attached to. */
function behaviorClass2f(m, si) {
  const bx = m.u16(si + 0x2c);
  if (m.u8(bx + 0x40) === 0x19 || m.u16(bx + 2) === 0) { kill(m, si); return; }
  m.w16(si + 6, m.u16(bx + 6));
  m.w16(si + 8, m.u16(bx + 8) - 0x10);
  m.w16(si + 0xa, m.u16(bx + 0xa) - 0x38 + (m.u16(bx + 0x14) === 8 ? 0x42 : 0x46));
}

/** 1000:CC52 class 0x11: a marker that follows the entity at [+0x2C] and dies with the player's grab. */
function behaviorClass11(m, si, ctx) {
  const bx = m.u16(si + 0x2c);
  m.w16(si + 6, m.u16(bx + 6));
  m.w16(si + 8, m.u16(bx + 8) - 8);
  advanceAnim(m, si, m.u8(si + 0x3d));
  if (m.u16(bx + 2) !== 3) return;
  m.w8(si + 1, 0);
  m.w16(si + 0xc, 0);
  if (m.s8(0x8b96) > 1) return;
  kill(m, si);
  m.w16(bx + 0x2c, 0);
  // 1D4C sound request (ax = 4) writes nothing this model compares yet.
}
