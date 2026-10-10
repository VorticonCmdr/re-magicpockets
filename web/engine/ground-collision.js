// Entity_ResolveGroundCollision (1000:E14F) and its tile scans, for the player (class 3) only,
// plus the entity-pair dispatch that reaches it (DF5A -> DFAC/E067). Transliterated from the
// disassembly over a DsMemory image; branches that are not ported record themselves in
// `ctx.unported` and do nothing.
//
// Coordinates: the level map lives at DS:0x4200 in column-major order, 128 bytes per column
// (the .pap transposed), and a tile's solidity comes from the per-world table that [0xEF23]
// points at. The scans work in *screen* space: the cell origin is (col*32 + world.x,
// row*16 + world.y), compared with the player's own screen box.

'use strict';

import { pairEvent } from './hit.js';
import { pushEvent5 } from './fire.js';

const MAP = 0x4200;
const S = { X: 0x8c1f, Y: 0x8c21, X2: 0x8c27, Y2: 0x8c29, CX: 0x8c1b, CY: 0x8c1d, OX: 0x8c23, OY: 0x8c25 };
const R = { C5: 0x8bc5, C6: 0x8bc6, C7: 0x8bc7, C8: 0x8bc8, C9: 0x8bc9, CA: 0x8bca, CB: 0x8bcb, CC: 0x8bcc,
  D5: 0x8bd5, D7: 0x8bd7, D9: 0x8bd9, DD: 0x8bdd, DF: 0x8bdf, E7: 0x8be7, E8: 0x8be8, E9: 0x8be9, EA: 0x8bea, EB: 0x8beb, EC: 0x8bec };
const EF23 = 0xef23;

/** Solidity contribution of the map cell at DS offset `di` (table[[EF23] + tile]). */
const tile = (m, di) => m.u8(m.u16(EF23) + m.u8(di));
/** The same lookup with the tile byte sign-extended, as `cbw` does (tiles above 127 would go negative). */
const tileSigned = (m, di) => m.u8((m.u16(EF23) + m.s8(di)) & 0xffff);

function add8(m, addr, v) { m.w8(addr, m.u8(addr) + v); }

/** 1000:E3CA: probe at the bottom edge (the floor), summing into [8BCA]; sets [8BC6], [8BD7], [8BD9]. */
function scanFloor(m, bx, di0) {
  const save = [S.X, S.Y, S.X2, S.Y2].map((a) => m.u16(a));
  let di = di0;
  m.w16(S.Y2, m.u16(S.Y2) + m.u16(bx + 0x1a));
  do {
    m.w16(S.Y, m.u16(S.Y) + 0x10);
    di += 1;
  } while (m.s16(S.Y) < m.s16(S.Y2));
  if (m.s16(S.Y) !== m.s16(S.Y2)) { di -= 1; m.w16(S.Y, m.u16(S.Y) - 0x10); m.w8(R.C6, 0xff); }
  m.w16(R.D9, m.u16(S.Y));
  m.w16(R.D7, di);
  add8(m, R.CA, tileSigned(m, di));
  add8(m, R.E7, tileSigned(m, di - 1));
  m.w16(S.X, m.u16(S.X) + 0x20);
  m.w16(S.X2, m.u16(S.X2) + m.u16(bx + 0x18));
  if (m.s16(S.X) < m.s16(S.X2)) {
    m.w8(R.E8, 0xff);
    di += 0x80;
    add8(m, R.CA, tileSigned(m, di));
    add8(m, R.E7, tileSigned(m, di - 1));
  }
  [S.X, S.Y, S.X2, S.Y2].forEach((a, i) => m.w16(a, save[i]));
}

/** 1000:E366: probe the left column, summing into [8BC9]; sets [8BC5]. */
function scanLeft(m, bx, di0) {
  const sx = m.u16(S.X), sx2 = m.u16(S.X2);
  let di = di0;
  if (m.s16(S.Y) === m.s16(S.Y2)) di -= 1; else m.w8(R.C5, 0xff);
  add8(m, R.C9, tileSigned(m, di));
  m.w16(S.X, m.u16(S.X) + 0x20);
  m.w16(S.X2, m.u16(S.X2) + m.u16(bx + 0x18));
  if (m.s16(S.X) < m.s16(S.X2)) {
    m.w8(R.E8, 0xff);
    di += 0x80;
    add8(m, R.C9, tileSigned(m, di));
  }
  m.w16(S.X, sx); m.w16(S.X2, sx2);
}

/** 1000:E47C: probe the top row, summing into [8BCB]; sets [8BC7], [8BDD], [8BDF], [8BD5]. */
function scanTop(m, bx, di0) {
  const sx = m.u16(S.X);
  let di = di0;
  m.w16(R.DD, m.u16(S.X));
  if (m.s16(S.X) === m.s16(S.X2)) di -= 0x80; else m.w8(R.C7, 0xff);
  const t = tileSigned(m, di);
  add8(m, R.CB, t);
  m.w8(R.DF, t);
  m.w16(S.X, m.u16(bx + 0x1a));
  if (m.s16(S.Y) !== m.s16(S.Y2)) m.w16(S.X, m.u16(S.X) + 0x10);
  for (;;) {
    di += 1;
    m.w16(S.X, m.u16(S.X) - 0x10);
    if (m.s16(S.X) < 0x10) break;
    add8(m, R.CB, tileSigned(m, di));
  }
  m.w16(R.D5, di);
  m.w16(S.X, sx);
}

/** 1000:E4ED: probe the bottom row, summing into [8BCC]; sets [8BC8], [8BDD], [8BDF], [8BD5]. */
function scanBottom(m, bx, di0) {
  const sx = m.u16(S.X), sx2 = m.u16(S.X2);
  let di = di0;
  m.w16(S.X2, m.u16(S.X2) + m.u16(bx + 0x18));
  do {
    m.w16(S.X, m.u16(S.X) + 0x20);
    di += 0x80;
  } while (m.s16(S.X) < m.s16(S.X2));
  if (m.s16(S.X) !== m.s16(S.X2)) { di -= 0x80; m.w16(S.X, m.u16(S.X) - 0x20); m.w8(R.C8, 0xff); }
  m.w16(R.DD, m.u16(S.X));
  const t = tileSigned(m, di);
  add8(m, R.CC, t);
  m.w8(R.DF, t);
  m.w16(S.X, m.u16(bx + 0x1a));
  if (m.s16(S.Y) !== m.s16(S.Y2)) m.w16(S.X, m.u16(S.X) + 0x10);
  for (;;) {
    di += 1;
    m.w16(S.X, m.u16(S.X) - 0x10);
    if (m.s16(S.X) < 0x10) break;
    add8(m, R.CC, tileSigned(m, di));
  }
  m.w16(R.D5, di);
  m.w16(S.X, sx); m.w16(S.X2, sx2);
}

/** 1000:E5B3 for the player: the [8BC9] probe result sets the "blocked" bit 1. */
function resolveC9(m, si, bx, ctx) {
  if (m.u8(R.C9) === 0) return;
  const kind = m.u16(bx + 4);
  if (kind !== 3) { ctx.unported.add(`E5B3 kind ${kind}`); return; }
  const t = m.u8(0x8b98);
  if (m.u8(R.C5) === 0) { // E61B
    if (t === 0x21 || t === 0x41) m.w16(bx + 0x24, m.u16(bx + 0x24) | 1);
    return;
  }
  // E62A
  if (t === 0x21 || t === 0x41) { // E652: snap the world entity to the 16-px grid
    let ax = (-m.s16(si + 8)) & 0xffff;
    ax = (ax & 0xfff0); ax = (ax + 0x10) & 0xffff; ax = (-ax) & 0xffff;
    m.w16(si + 8, ax);
    m.w16(bx + 0x24, m.u16(bx + 0x24) | 1);
    return;
  }
  if (m.u8(R.EB) !== 0) return;
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 1);
  if (m.u8(si + 1) === 0) return;
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 0x80);
}

/** 1000:E696 for the player: no floor falls (F77B), floor lands (F489). */
function resolveFloor(m, si, bx, ctx) {
  if (m.u8(R.CA) === 0) { fall(m, si, bx, ctx); return; } // E703 -> F77B
  land(m, si, bx, ctx); // E6A4/E6FF -> F489
}

/** 1000:F77B: the player has nothing underneath. */
function fall(m, si, bx, ctx) {
  const t = m.u8(0x8b98);
  if (t === 0xff) return;
  const ws = m.u8(si + 1);
  if (ws === 0x11 || ws === 0x10 || ws === 0xd || ws === 0xaf || ws === 4 || ws === 0x43 || ws === 0x47) return;
  const ps = m.u8(bx + 1);
  if (ps === 0xaa || ps === 0x35 || ps === 0x2f) return;
  const f82d = () => { // the world entity starts to fall
    if (m.u8(si + 1) === 0x75) return;
    m.w16(si + 0x26, 0); m.w8(si + 1, 0x11); m.w16(si + 0xc, 0xc606);
  };
  if (ps === 0x1d && (((m.u16(bx + 0xc) - 0xc65a) << 16) >> 16) < 0xa) { // F819: the punch script is early enough to cancel
    m.w8(bx + 1, 0x35); m.w16(bx + 0xc, 0xc7f7);
    f82d();
    return;
  }
  if (t === 0x41 || t === 0x21) return;
  if (t === 0x43) { f82d(); return; }
  if (t === 3) { m.w8(si + 1, 0); return; }
  if (t === 1) return;
  if ((m.u16(bx + 0x24) & 2) !== 0) return;
  if (m.u8(R.EB) !== 0) return;
  m.w16(0x8c38, 0);
  m.w8(bx + 1, 0);
  m.w8(si + 1, 0x11);
  m.w16(si + 0xc, 0xc606); // the fall script
  if (t !== 0x15) m.w16(bx + 0xa, 0x4f);
}

/** 1000:F6D3: round the world entity's Y up to the next 16-px boundary. */
function snapWorldY(m, si) {
  const y = m.u16(si + 8);
  m.w16(si + 8, y & 0xfff0);
  if ((y & 0xf) !== 0) m.w16(si + 8, m.u16(si + 8) + 0x10);
}

/** 1000:F489: the player has ground underneath (landing). */
function land(m, si, bx, ctx) {
  const t = m.u8(0x8b98);
  if (t === 0x21 || t === 0x41) { snapWorldY(m, si); m.w16(bx + 0x24, m.u16(bx + 0x24) | 2); return; }
  if (t === 3) { // F6E4
    if (m.u16(R.C7) !== 0 && m.u8(R.CA) === 1) m.w8(si + 1, 0);
    return;
  }
  if (t === 0xff) return;
  if (m.u8(si + 1) === 0xaf) return;
  let landing = m.u8(bx + 1) === 0x35; // F4F6 directly
  if (!landing) {
    const ws = m.u8(si + 1);
    if (ws === 0) { // F54B
      worldTwoStanding(m, si, bx);
      return;
    }
    const vy = m.s8(si + 0x26);
    if (ws === 0x11 ? vy > -10 : vy >= 0) return; // not falling fast enough to land
    if (t === 1) { landTarget1(m, si, bx, ctx); return; }
    if (t === 0x15 || t === 0x43) { ctx.unported.add(`F489 landing target ${t}`); return; }
    landing = true;
  }
  // F4F6
  if (m.u8(R.E7) !== 0) { // F552: only the signed-tile-byte checks (tiles are 1..120 here) are inert
    ctx.unported.add('F552 side-contact landing');
    return;
  }
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 2);
  snapWorldY(m, si);
  if (m.u16(0x8b89) === 3) ctx.unported.add('F6F7 world 3');
  m.w16(si + 0x26, 0);
  m.w8(si + 1, 0);
  m.w8(bx + 0x3e, 0);
  if ((m.u8(0x8b67) & 0xf) !== 0) {
    m.w16(bx + 0x10, 0x41); m.w16(bx + 0x12, 0x48); m.w16(bx + 0xa, 0x40);
    m.w16(0x8c38, 0);
    m.w8(bx + 1, 0);
    m.w16(bx + 0x24, 0);
    ctx.events.push({ op: 'sound', id: 0x4e });
    return;
  }
  m.w16(bx + 0xc, 0xc62d);
  m.w8(bx + 1, 0x16);
}

/** 1000:F619 (falling target): land with a bounce. */
function landTarget1(m, si, bx, ctx) {
  const rest = () => { // F661
    if (m.u8(R.E7) === 1) return;
    m.w16(bx + 0x24, m.u16(bx + 0x24) | 2);
    snapWorldY(m, si);
    if (m.u16(0x8b89) === 3) ctx.unported.add('F6F7 world 3');
    bounce(m, si, bx, ctx);
  };
  if (m.u8(R.CA) === 0 || m.u16(R.CB) === 0) { if (m.u8(R.E7) === 0) rest(); return; } // F659
  const e7 = m.u8(R.E7);
  if (e7 === 0) { rest(); return; }
  if (e7 === 2) { // F64B
    if (m.u8(R.C9) !== 0) return;
    if (m.u8(si + 0x26) === 0xf0) rest();
    return;
  }
  if (m.u8(R.C9) === 0 || m.u8(R.CB) !== 0 || m.u8(R.CC) !== 0) { rest(); return; }
}

/** 1000:F5AE: the landing sound, then the bounce or the stop. */
function bounce(m, si, bx, ctx) {
  ctx.events.push({ op: 'sound', id: 9 });
  const settle = () => { // F5DF
    m.w16(si + 0x26, 0); m.w8(si + 1, 0); m.w8(si + 0x3e, 0);
    if (m.u8(0x8b98) === 1) {
      m.w8(0x8b98, 0);
      m.w16(bx + 0x10, 0x41); m.w16(bx + 0x12, 0x48); m.w16(bx + 0xa, 0x40);
    }
  };
  if ((m.u8(0x8b67) & 2) !== 0) { settle(); return; }
  let al = m.s8(si + 0x26);
  if (al === 0) { settle(); return; }
  if (al > 0) { worldTwoStanding(m, si, bx); return; } // F54B
  if (m.u8(si + 1) === 0x11) m.w8(si + 1, 0x10);
  al = (-al) >> 1; // neg al; sar al,1
  m.w8(si + 0x26, al & 0xff);
  if (m.s8(si + 0x26) <= 3) { settle(); return; }
  worldTwoStanding(m, si, bx); // F54B
}

/**
 * 1000:F54B (world 2): standing next to a negative tile (a belt) drags the world entity 0x20 sideways unless that
 * side is blocked. `si` is the world entity, `bx` the hero.
 */
function worldTwoStanding(m, si, bx) {
  if (m.u16(0x8b89) !== 2) return;
  let di = m.u16(0x8bd7);
  const neg = (o) => m.s8(o) < 0;
  let drag = false;
  if (neg(di) || neg(di - 1)) drag = true; // F594
  else if (m.u8(0x8be8) === 0) return; // F5A6
  else if (neg(di + 0x7f)) drag = true;
  else {
    di -= 1;
    if (neg(di - 1) || neg(di - 2)) drag = true;
    else if (m.u8(0x8be8) !== 0 && neg(di + 0x7f)) drag = true;
    else return; // F592
  }
  if (drag) {
    if ((m.u16(bx + 0x24) & m.u16(si + 0x14)) !== 0) return;
    m.w16(si + 6, m.u16(si + 6) + (m.u16(si + 0x14) === 4 ? 0x20 : -0x20));
  }
}

/** 1000:F960: snap the world entity to the tile column it ran into and set the blocked bit. */
function snapLateral(m, si, bx) {
  if (m.u16(R.C7) === 0) { m.w16(bx + 0x24, m.u16(bx + 0x24) | m.u16(bx + 0x14)); return; } // FA3E
  const ax = m.u16(bx + 6) & 0x1f;
  let cx = (-m.u16(si + 6)) & 0xffff;
  cx = (cx & 0xffe0) | ax;
  cx = (-cx) & 0xffff;
  const old = m.u16(si + 6);
  m.w16(si + 6, cx);
  const diff = (old - cx) & 0xffff;
  if (diff & 0x8000) { if (m.u16(bx + 0x14) !== 8) m.w16(R.D7, m.u16(R.D7) - 0x80); } // F999
  else if (m.u16(bx + 0x14) !== 4) m.w16(R.D7, m.u16(R.D7) + 0x80); // F98B
  const e7 = m.u8(R.E7);
  if (e7 !== 2 && e7 !== 0) { // F9B3: re-read the tiles beside the new position
    const ef = m.u16(EF23);
    let di = m.u16(R.D7);
    if (m.u16(bx + 0x14) === 4) {
      m.w8(R.E7, m.u8(ef + m.u8(di + 0x7f)));
      if (m.u8(ef + m.u8(di)) !== 0 && m.u8(R.CA) === 1) m.w8(R.CA, 0);
      if (m.u8(ef + m.u8(di)) === 0) return finishSnap(m, si, bx);
    }
    di = m.u16(R.D7);
    m.w8(R.E7, m.u8(ef + m.u8(di - 1)));
    if (m.u8(ef + m.u8(di + 0x80)) !== 0 && m.u8(R.CA) === 1) m.w8(R.CA, 0);
  }
  finishSnap(m, si, bx);
}

function finishSnap(m, si, bx) { // FA17
  if (m.u16(bx + 0x14) === 4) {
    m.w8(R.C7, 0);
    m.w16(bx + 0x24, m.u16(bx + 0x24) | 4);
    if ((m.u16(si + 6) & 0x1f) === 0) m.w16(bx + 6, m.u16(bx + 6) + 0x20);
    return;
  }
  m.w8(R.C8, 0);
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 8);
}

/** 1000:F842: the player ran into something at the side (called from E8D7/E961 when a side probe hit). */
function lateral(m, si, bx, ctx) {
  const t = m.u8(0x8b98);
  if (t === 0x15) { m.w8(0x8b97, 0); snapLateral(m, si, bx); return; } // F925
  if (t === 0x21) { snapLateral(m, si, bx); return; }
  if (t === 0x41) { m.w16(bx + 0x24, m.u16(bx + 0x24) | m.u16(bx + 0x14)); return; } // F942
  if (t === 3) { snapLateral(m, si, bx); m.w16(bx + 0x24, m.u16(bx + 0x24) | 0xc); return; } // F92C
  if (t === 1) { // F906
    snapLateral(m, si, bx);
    if (m.u8(R.E7) === 0) return;
    m.w16(bx + 0x24, m.u16(bx + 0x24) | m.u16(bx + 0x14));
    if ((m.u8(0x8b67) & m.u16(bx + 0x14)) !== 0) return;
    m.w16(bx + 0x14, m.u16(bx + 0x14) ^ 0xc);
    return;
  }
  if (m.u8(si + 1) === 0x11) { // F949: mid-air against a wall
    if (m.s8(R.CB) >= 2 || m.s8(R.CC) >= 2) { snapLateral(m, si, bx); return; }
    if (m.s8(R.CA) >= 2) { m.w16(bx + 0x24, m.u16(bx + 0x24) | m.u16(bx + 0x14)); return; } // F942
    snapLateral(m, si, bx);
    return;
  }
  const facing4 = m.u16(bx + 0x14) === 4;
  const sideProbe = m.u8(facing4 ? R.CB : R.CC);
  const to8a1 = () => {
    m.w16(bx + 0x24, m.u16(bx + 0x24) | m.u16(bx + 0x14)); // F8A1
    if (m.u8(si + 1) === 0) { if (m.u16(R.C7) !== 0) snapLateral(m, si, bx); return; } // F8CE
    if (m.u8(R.C9) === 0) { snapLateral(m, si, bx); return; }
    m.w16(bx + 0x24, m.u16(bx + 0x24) | 0x80);
    if (m.u8(R.E7) === 2) return;
    if (m.u16(R.C5) === 0xffff) snapLateral(m, si, bx);
  };
  if (m.u8(R.E7) === 0) { // F884
    if (sideProbe !== 1) { to8a1(); return; }
    if (m.s8(R.C6) < 0) return; // F89A
    to8a1();
    return;
  }
  if (m.u8(R.E7) !== 1) { to8a1(); return; } // F8D9
  if (sideProbe !== 2 || m.u8(R.CA) === 0) { to8a1(); return; }
  snapLateral(m, si, bx);
}

/** 1000:E8D7 / E961 for the player: a side probe hit sends it to F842. */
function resolveSide(m, si, bx, probeAddr, ctx) {
  if (m.u8(probeAddr) === 0) return;
  lateral(m, si, bx, ctx);
}

// --- Enemy (non-player) collision: the second branch of E14F, kind 2 leaves only ---

/** 1000:FA46: pull a blocked entity back to the tile edge on the side it faces. */
function alignToWall(m, bx) {
  const face = m.u16(bx + 0x14);
  if (face === 4) {
    if (m.u8(R.C7) === 0) return;
    m.w16(bx + 6, m.u16(R.DD) + 0x20);
    if (m.u8(R.EC) !== 0) return;
    m.w8(R.C7, 0);
    m.w8(R.C9, Math.max(0, m.s8(R.C9) - 1) & 0xff); // sub 1; jns keep else 0
    m.w8(R.CA, Math.max(0, m.s8(R.CA) - 1) & 0xff);
  } else if (face === 8) {
    if (m.u8(R.C8) === 0) return;
    m.w16(bx + 6, (m.u16(R.DD) - m.u16(bx + 0x18)) & 0xffff);
    if (m.u8(R.EC) !== 0) return;
    m.w8(R.C8, 0);
    m.w8(R.C9, Math.max(0, m.s8(R.C9) - 1) & 0xff);
    m.w8(R.CA, Math.max(0, m.s8(R.CA) - 1) & 0xff);
  }
}

/** 1000:FABD: lift an entity out of the ceiling it ran into. */
function alignToCeiling(m, bx) {
  if (m.u8(R.C5) === 0) return;
  m.w16(bx + 8, (m.u16(0x8be3) + 0x10) & 0xffff);
  if (m.u8(R.EC) !== 0) return;
  m.w8(R.C5, 0);
  if (m.u8(R.CB) !== 0) m.w8(R.CB, m.u8(R.CB) - 1);
  if (m.u8(R.CC) !== 0) m.w8(R.CC, m.u8(R.CC) - 1);
}

/** 1000:FAF5: lift an entity out of the floor it sank into. */
function alignToFloor(m, bx) {
  if (m.u8(R.C6) === 0) return;
  m.w16(bx + 8, (m.u16(R.D9) - m.u16(bx + 0x1a)) & 0xffff);
  if (m.u8(R.EC) !== 0) return;
  m.w8(R.C6, 0);
  if (m.u8(R.CB) !== 0) m.w8(R.CB, m.u8(R.CB) - 1);
  if (m.u8(R.CC) !== 0) m.w8(R.CC, m.u8(R.CC) - 1);
}

/** 1000:E2D3: ledge probe for kind 2; sets [8BE9] when there is no floor under the next step. */
function ledgeProbe(m, bx) {
  if (m.u16(0x8b89) === 3 || m.u16(bx + 4) !== 2) return;
  const ef = m.u16(EF23);
  const solid = (di) => m.u8(ef + m.s8(di) & 0xffff) !== 0;
  let di = (m.u16(R.D7) - 0x80) & 0xffff;
  if (solid(di - 1)) {
    di = (di + 0x100) & 0xffff;
    if (solid(di - 1)) { m.w8(R.E9, 0xff); return; }
  }
  if (m.u16(R.C7) !== 0) return;
  di = m.u16(R.D7);
  if (!solid(di)) return;
  di = (di - 0x80) & 0xffff;
  if (solid(di)) return;
  di = (di + 0x100) & 0xffff;
  if (solid(di)) return;
  m.w8(R.E9, 1);
}

/** 1000:F270 / F283: kind 2 side contact. */
function sideContact(m, bx, withAlign) {
  if (withAlign) alignToWall(m, bx);
  if (!withAlign && m.u8(bx + 1) !== 0 && m.s8(bx + 0x26) < 0) return;
  m.w16(bx + 0x24, m.u16(bx + 0x24) | m.u16(bx + 0x14));
}

/** 1000:E2AF: resolve the side probe (kind 2 only). */
/** 1000:E8D7 / E961 -> EA41..EAF6 for kind 7: projectiles breaking 0x3C tiles or bouncing off walls. */
function sideProjectile(m, bx, di, face, probe, ctx) {
  if (m.u8(probe) === 0) return;
  const contact = face === 8 ? R.C8 : R.C7;
  let ax;
  if (m.u8(contact) === 0) ax = face === 8 ? 0x80 : -0x80; // EA46 / EA41
  else { ax = m.u8(0x8be8) === 0 ? 0 : 0x80; if (face === 4) ax = 0; } // EA4B
  di = (di + ax) & 0xffff;
  ax &= 0xffff;
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  const cls = m.u16(bx + 2);
  if (world === 1 && [0xa, 0xb, 0xc, 0xd, 0x27].includes(cls)) { // EAA5
    // The 1CCF sound request writes nothing this model compares yet.
    const breakTile = (o) => { m.w8(di + o, -m.u8(di + o)); m.w8(bx + 0x40, 0x19); };
    ax &= 0xffff;
    if (m.u8(di) === 0x3c) { breakTile(0); ax = 1; if (cls !== 0xd) return; }
    if (m.u8(di + 1) === 0x3c) { breakTile(1); ax = 2; }
    if (cls === 0xd && m.u8(di + 2) === 0x3c && ax !== 2) { breakTile(2); return; } // EADD
  }
  if (m.u16(R.C7) !== 0) alignToWall(m, bx); // EA90
  m.w16(bx + 0x24, m.u16(bx + 0x24) | m.u16(bx + 0x14));
  m.w16(bx + 0x14, m.u16(bx + 0x14) ^ 0xc);
}

function sideEnemy(m, bx, ctx, di) {
  const face = m.u16(bx + 0x14);
  if (face === 0) return;
  const probe = face === 8 ? R.CC : R.CB;
  if (m.u16(bx + 4) === 7) { sideProjectile(m, bx, di, face, probe, ctx); return; }
  if (m.u16(bx + 4) === 5 || m.u16(bx + 4) === 4) { // E940 / E9CA: turn around at a wall
    if (m.u8(probe) === 0) return;
    if (m.u16(bx + 2) === 6) return;
    alignToWall(m, bx);
    m.w16(bx + 0x14, m.u16(bx + 0x14) ^ 0xc);
    return;
  }
  if (m.u16(bx + 4) !== 2) { ctx.unported.add(`E8D7/E961 kind ${m.u16(bx + 4)}`); return; }
  const hit2 = face === 8 ? R.C8 : R.C7;
  if (m.u8(probe) === 0) return;
  sideContact(m, bx, m.u8(hit2) !== 0);
}

/** 1000:F290 (kind 2 floor contact) and F37D (no floor). */
function floorProp(m, bx, ctx) { // kind 5/6: E703 -> F3EA; E6A4/E6D5 -> E734/E740
  const cls = m.u16(bx + 2);
  if (m.u8(R.CA) === 0) { noFloorProp(m, bx, cls, ctx); return; }
  if (m.u8(R.C6) !== 0) { if (cls === 6) return; alignToFloor(m, bx); } // E734
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 2); // E740
  if (m.s8(bx + 0x26) >= 0) { // E7F9
    if (m.u8(bx + 1) === 0) idleProp(m, bx, cls);
    return;
  }
  // E74D: bounce. The sound requests (1CCF) write nothing this model compares yet.
  if (cls === 0xe) m.w8(bx + 0x3e, 1);
  else if (cls === 0x41) { if (m.u8(bx + 1) === 0x2e) m.w8(bx + 1, 0); }
  else if (cls !== 0x1a) m.w8(bx + 0x3e, 1);
  const half = ((-m.u8(bx + 0x26)) & 0xff) >> 1;
  m.w8(bx + 0x26, half); // E7A8
  if (m.s8(bx + 0x26) > 4) return;
  m.w16(bx + 0xc, m.u16(bx + 0xc) + 3);
  m.w16(bx + 0x26, 0);
  const state = (s, script) => { m.w8(bx + 1, s); m.w16(bx + 0xc, script); };
  if (cls === 0x16) state(0xae, 0xd20b);
  else if (cls === 0x28) state(0xad, 0xd1fe);
  else if (cls === 0x53) {
    if (m.s8(bx + 1) < 0) return;
    m.w8(bx + 0x40, 0x65);
    if (m.u16(bx + 0xa) === 0x104) state(0xf6, 0xd8f1); else state(0xf7, 0xd8fd);
  } else if (cls === 0x5f) state(0xff, 0xd97e);
  else if (cls === 0xe && m.s16(bx + 0xa) >= 0x50) { m.w16(bx + 0xa, 0x12); m.w8(bx + 0x3d, 0xff); }
}

/** 1000:E846: a settled prop with state 0 picks its idle script by class. */
function idleProp(m, bx, cls) {
  if ([0x15, 0x40, 0x41, 0x43, 0x24, 0x26, 0x29, 0x1a, 0x2a, 0x22, 0x1c].includes(cls)) return;
  if (cls === 0xe && m.u16(bx + 0xa) === 0x12) m.w8(bx + 0x3d, 0xff);
  m.w8(bx + 1, 0x20); m.w16(bx + 0xc, 0xc697);
}

/** 1000:F3EA: a kind 5/6 prop with no floor under it. */
function noFloorProp(m, bx, cls, ctx) {
  if (cls === 0x29 || cls === 0x1c || cls === 6) return;
  const f426 = () => { m.w8(bx + 0x3e, 0); m.w8(bx + 1, 0x8f); m.w16(bx + 0xc, 0xcfd9); };
  if (cls === 0x41) { // F451
    if (m.s8(m.u16(R.D7)) < 0) {
      if (m.u8(bx + 1) === 0x2e) return;
      ctx.unported.add('F461 class 0x41 spawn event (BF1E)');
      return;
    }
  } else if (cls === 0xe) {
    if (m.u16(bx + 0xa) === 0x12) { // F434
      m.w16(bx + 0x10, 0x50); m.w16(bx + 0x12, 0x5b); m.w16(bx + 0xa, 0x50);
      m.w8(bx + 1, 0x8f); m.w16(bx + 0xc, 0xcfd9); m.w8(bx + 0x3d, 0);
      return;
    }
    f426(); return;
  } else if (cls === 0x1b || cls === 0x45) { f426(); return; }
  if (m.u8(bx + 1) === 0) { m.w8(bx + 1, 0x8e); m.w16(bx + 0xc, 0xcfd5); } // F410
}

/** 1000:EB20/EB23 (+ ECE5, EE60): the floor under a kind 7 projectile, world 1 only. */
function floorProjectile(m, bx, ctx) {
  const world = m.u16(0x8b89) || m.u16(0x8b8b);
  if (m.u8(R.CA) === 0) { // EDCC: nothing happens in worlds 1-3; world 4 is not ported
    if (world === 4) ctx.unported.add('EDED kind 7 without floor, world 4');
    return;
  }
  if (m.u8(R.C6) !== 0) alignToFloor(m, bx); // EB20: FAF5
  if (world !== 1) { ctx.unported.add(`EB23 kind 7 world ${world}`); return; }
  const cls = m.u16(bx + 2);
  const kill = () => m.w8(bx + 0x40, 0x19);
  if ([0xa, 0xb, 0xc, 0xd, 0x27].includes(cls)) { // ECBA: breakable tiles under the shot
    const tile = m.u16(R.D7);
    let broke = false;
    if (m.u8(tile) === 0x3c) { m.w8(tile, -m.u8(tile)); broke = true; }
    else if (m.u8(0x8be8) !== 0 && m.u8(tile + 0x80) === 0x3c) { m.w8(tile + 0x80, -m.u8(tile + 0x80)); broke = true; }
    if (broke) { // sound 1CCF skipped; F1F6 decides what the shot becomes
      if (cls === 0xa) { kill(); } else ctx.unported.add(`F1F6 class 0x${cls.toString(16)}`);
    }
  } else if (cls === 0x10) { // ED32
    if (m.u8(bx + 1) === 0x5c) return;
    m.w16(bx + 0x26, 0); m.w8(bx + 1, 0x5c); m.w16(bx + 0xc, 0xcac4);
    return;
  }
  else if (cls !== 0x44 && cls !== 0x28) { kill(); return; }
  // ECE5
  if (m.u8(R.E7) !== 0) return;
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 2);
  let al = m.s8(bx + 0x26);
  if (al !== 0) {
    if (al > 0) return;
    al = (-al) & 0xff;
    m.w8(bx + 0x26, al);
    m.w8(bx + 0x26, al - (m.s8(bx + 0x26) >> 1)); // sar al,1 on the negated byte, then subtract
    if (m.u8(0x8c03) !== 0) { // F0F5: a class-0xD shot sheds two sparks when it bounces
      if (world !== 1) { ctx.unported.add(`F0F5 world ${world}`); return; }
      if (cls === 0xd) {
        m.w16(0x8c29, 0xa); m.w16(0x8c21, 0x17);
        m.w16(0x8c25, m.u16(bx + 8)); m.w16(0x8c27, m.u16(bx + 6) + 8);
        m.w16(0x8c23, 4); pushEvent5(m);
        m.w16(0x8c23, 8); pushEvent5(m);
      }
    }
    if (m.s8(bx + 0x26) > 3) return; // ED19: only the bounce sound
  }
  // EE60 -> F08F: the shot has run out of bounce
  const settle = (state, script, dying) => { // the shot becomes a fixed scripted object
    if (m.u8(bx + 1) === state) return;
    if (dying) m.w8(bx + 0x40, 0x65);
    m.w8(bx + 1, state); m.w16(bx + 0xc, script);
  };
  if (cls === 0x44) { // EEA6
    if (m.u8(bx + 1) === 0xb3) return;
    m.w8(bx + 1, 0xb3); m.w16(bx + 0xc, 0xd27d); m.w8(bx + 0x3d, 0xff); m.w16(bx + 0x26, 0); m.w16(bx + 0xa, 0x6c);
    return;
  }
  if (cls === 0x27) { settle(0xca, 0xd4d6, true); return; } // EED8
  if (cls === 0x28 || cls === 0x5f) { settle(0xad, 0xd1fe, true); return; } // EEC4
  if (cls === 0x16) { settle(0xae, 0xd20b, true); return; } // EEEC
  if (cls === 0xa) {
    if (m.s8(bx + 1) < 0) return;
    m.w8(bx + 1, 0x93); m.w16(bx + 0xc, 0xd006); m.w8(bx + 0x40, 0x65);
  } else if (cls === 0xb) {
    if (m.s8(bx + 1) < 0) return;
    m.w8(bx + 1, 0x92); m.w16(bx + 0xc, 0xcffb);
  } else if (cls === 0xc) {
    if (m.s8(bx + 1) < 0) return;
    m.w8(bx + 1, 0x91); m.w16(bx + 0xc, 0xcff0);
  } else if (cls === 0xd) {
    if (m.s8(bx + 1) < 0) return;
    m.w16(bx + 0x26, 0); m.w8(bx + 1, 0x90); m.w16(bx + 0xc, 0xcfe3);
  } else kill();
}

/** 1000:E8BA/E8BD: kind 4 floor contact; the hovering class 0x12 bounces back up. */
function floorKind4(m, bx) {
  if (m.u8(R.CA) === 0) return; // E703 lists no kind 4: nothing happens without a floor
  if (m.u8(R.C6) !== 0) alignToFloor(m, bx); // E8BA: FAF5
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 2);
  if (m.u16(bx + 2) !== 0x12) return;
  m.w8(bx + 0x28, m.u8(bx + 0x36)); m.w8(bx + 0x26, 1); m.w8(bx + 0x40, 0xb);
}

function floorEnemy(m, bx, ctx) {
  if (m.u16(bx + 4) === 4) { floorKind4(m, bx); return; }
  if (m.u16(bx + 4) === 7) { floorProjectile(m, bx, ctx); return; }
  if (m.u16(bx + 4) === 5 || m.u16(bx + 4) === 6) { floorProp(m, bx, ctx); return; }
  const cls = m.u16(bx + 2);
  if (m.u8(R.CA) === 0) { // E703 -> F37D
    // 1000:F37D: no floor under the entity; pick the falling frame by class, then F3DA.
    const frame = { 0x13: 0x24, 0x23: 0xdc, 0x14: 0xc, 0x20: 0xcf, 0x4b: 0x31 }[cls];
    if (frame !== undefined && cls !== 0x14) {
      if (cls === 0x4b && m.u8(bx + 0x40) === 0x67) return;
      if (m.u8(bx + 1) !== 0) return;
    }
    if (frame !== undefined) m.w16(bx + 0xa, frame);
    if (m.u8(bx + 1) === 0) { m.w8(bx + 1, 0x8d); m.w16(bx + 0xc, 0xcfd1); } // F3DA
    return;
  }
  if (m.u8(R.C6) !== 0) alignToFloor(m, bx); // E6D5 -> F28D
  if (m.u8(bx + 1) === 0) { m.w16(bx + 0x24, m.u16(bx + 0x24) | 2); return; } // F2DC
  if (m.s8(bx + 0x26) >= 0) return;
  if (m.u8(R.E7) !== 0) return;
  m.w16(bx + 0x26, 0);
  if (cls === 0x14 || cls === 0x20 || cls === 0x2c) { ctx.unported.add(`F290 class 0x${cls.toString(16)}`); return; }
  if (m.u8(bx + 1) === 0x8d) {
    m.w16(bx + 0xa, m.u16(bx + 0x10)); m.w8(bx + 1, 0);
    m.w16(bx + 6, m.u16(bx + 6) & 0xfffc);
    m.w16(bx + 0x24, m.u16(bx + 0x24) | 2);
    return;
  }
  m.w16(bx + 6, m.u16(bx + 6) & 0xfffc);
  m.w16(bx + 0xc, m.u16(bx + 0xc) + 3);
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 2);
}

/** 1000:E5B3 (ceiling): kind 2 and 4 set the flag, kinds 5/6 (E66F) and 7 (E9D8) bounce off it. */
function ceilingEnemy(m, bx, ctx) {
  if (m.u8(R.C9) === 0) return;
  const kind = m.u16(bx + 4);
  const bounce = () => { // FABD, flag, then the vertical speed reverses
    alignToCeiling(m, bx);
    m.w16(bx + 0x24, m.u16(bx + 0x24) | 1);
    m.w8(bx + 0x26, -m.u8(bx + 0x26));
  };
  if (kind === 5 || kind === 6) { // E66F
    const cls = m.u16(bx + 2);
    if (cls === 0x55) {
      if (m.u8(bx + 1) !== 0xb1) { m.w8(bx + 1, 0xb1); m.w16(bx + 0xc, 0xc7cf); }
      return;
    }
    if (cls === 6) return;
    bounce();
    return;
  }
  if (kind === 7) { // E9D8
    const world = m.u16(0x8b89) || m.u16(0x8b8b);
    const cls = m.u16(bx + 2);
    if (world === 1 && [0xa, 0xb, 0xc, 0xd, 0x27].includes(cls)) { // EA10: shatter a 0x3C tile
      let di = m.u16(R.D7);
      if (m.u8(R.C5) === 0) di -= 1;
      if (m.u8(di) === 0x3c) { m.w8(di, -m.u8(di)); m.w8(bx + 0x40, 0x19); return; }
      if (m.u8(0x8be8) !== 0 && m.u8(di + 0x80) === 0x3c) { m.w8(di + 0x80, -m.u8(di + 0x80)); m.w8(bx + 0x40, 0x19); return; }
    }
    bounce();
    return;
  }
  if (m.u8(R.C5) !== 0) alignToCeiling(m, bx);
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 1);
}

/** 1000:E2C2: vertical resolution by the sign of the vertical speed. */
function verticalEnemy(m, bx, ctx) {
  const vy = m.s8(bx + 0x26);
  if (vy > 0) ceilingEnemy(m, bx, ctx); else floorEnemy(m, bx, ctx);
}

/** The enemy half of 1000:E14F (world 1-2, kinds other than the player). */
function resolveEnemy(m, bx, di, ctx) {
  const kind = m.u16(bx + 4);
  if (kind !== 2 && kind !== 4 && kind !== 5 && kind !== 7) { ctx.unported.add(`E14F kind ${kind}`); return; }
  const vy = m.s8(bx + 0x26);
  let dl, dh;
  if (vy > 0) { scanLeft(m, bx, di); dl = m.s8(R.C9); } else { scanFloor(m, bx, di); dl = m.s8(R.CA); }
  if (m.u16(bx + 0x14) === 8) { scanBottom(m, bx, di); ledgeProbe(m, bx); dh = m.s8(R.CC); } else { scanTop(m, bx, di); ledgeProbe(m, bx); dh = m.s8(R.CB); }
  const side = () => sideEnemy(m, bx, ctx, di);
  const vert = () => verticalEnemy(m, bx, ctx);
  const finish = () => { if (m.u8(R.E9) !== 0) m.w16(bx + 0x24, m.u16(bx + 0x24) | 0xc); };
  if (dh === dl) { // E276
    if (m.u16(R.C5) === 0) { side(); vert(); finish(); return; } // E263
    if (m.u16(R.C7) === 0) { vert(); side(); finish(); return; } // E255
    if (m.u8(R.E7) !== 0) m.w8(R.EC, 0xff);
    if (m.u16(bx + 4) === 7) { vert(); side(); finish(); return; }
    if (m.u16(R.D5) !== m.u16(R.D7)) { vert(); side(); finish(); return; }
    vert();
    return;
  }
  if (dh > dl) { side(); vert(); } else { vert(); side(); }
  finish();
}

/** 1000:E14F Entity_ResolveGroundCollision, player (class 3) branch only. */
function resolveGroundCollision(m, si, bx, di, ctx) {
  m.w16(bx + 0x24, 0);
  if (m.u16(0x8b89) === 3) { ctx.unported.add('E14F world 3'); return; }
  if (m.u16(bx + 2) !== 3) { resolveEnemy(m, bx, di, ctx); return; }
  scanFloor(m, bx, di);
  scanLeft(m, bx, di);
  scanTop(m, bx, di);
  scanBottom(m, bx, di);
  if (m.u16(bx + 0x14) === 8) resolveSide(m, si, bx, R.CC, ctx); else resolveSide(m, si, bx, R.CB, ctx);
  resolveFloor(m, si, bx, ctx);
  resolveC9(m, si, bx, ctx);
}

/** 1000:E067: terrain collision of `bx` (the player) against the map, relative to world entity `si`. */
export function terrainCollision(m, si, bx, ctx) {
  if (m.u8(bx + 0x40) === 0x65) { ctx.unported.add('E067 state 0x65'); return; }
  let x = (m.u16(bx + 6) - m.u16(si + 6)) & 0xffff;
  let y = (m.u16(bx + 8) - m.u16(si + 8)) & 0xffff;
  x = Math.floor(x / 0x20); y = Math.floor(y / 0x10);
  const colBase = (x * 0x80) & 0xffff;
  m.w16(S.CY, colBase);
  m.w16(0x8bdb, 0x80);
  const di = (MAP + colBase + y) & 0xffff;
  m.w16(S.X, (x * 0x20 + m.u16(si + 6)) & 0xfffc);
  m.w16(S.Y, (y * 0x10 + m.u16(si + 8)) & 0xffff);
  m.w16(0x8be1, m.u16(S.X));
  m.w16(0x8be3, m.u16(S.Y));
  m.w16(R.C9, 0); m.w16(R.CB, 0); m.w16(R.C5, 0); m.w16(R.C7, 0);
  for (const a of [R.E7, R.E8, R.E9, R.EA, R.EC]) m.w8(a, 0);
  m.w16(S.X2, m.u16(bx + 6));
  m.w16(S.Y2, m.u16(bx + 8));
  resolveGroundCollision(m, si, bx, di, ctx);
  m.w8(bx + 0x3a, m.u8(bx + 0x3a) + 1);
  if (m.u16(bx + 2) === 3) m.w8(R.EB, 0);
}

/**
 * 1000:5761, DFAC's handler for a negative pair-table value: run the terrain collision with the
 * roles swapped (the partner is the reference) unless `si` is scenery or a settled prop. Returns
 * true when the original `pop ax; ret` (5780..57A0) abandons the whole interaction scan.
 */
function negativePair(m, si, bx, ctx) {
  const cls = m.u16(si + 2), kind = m.u16(si + 4);
  if (!(cls === 6 || cls === 0x1d || (kind === 5 && m.u8(si + 0x3e) !== 0))) terrainCollision(m, bx, si, ctx);
  return kind === 2 || kind === 4 || kind === 6 || kind === 5 || cls === 0x10;
}

/** 1000:DFAC: box overlap test between `si` and `bx` for pair-table value `cl` (not 0x63). */
export function overlapTest(m, si, bx, cl, ctx) {
  if (m.u16(bx + 2) === 0) return;
  if (cl > 127) return negativePair(m, si, bx, ctx);
  m.w16(S.CX, m.u16(si + 6) + m.u16(si + 0x1c));
  m.w16(S.CY, m.u16(si + 8) + m.u16(si + 0x1e));
  m.w16(S.OX, m.u16(bx + 6) + m.u16(bx + 0x1c));
  m.w16(S.OY, m.u16(bx + 8) + m.u16(bx + 0x1e));
  m.w16(S.X, m.u16(S.CX)); m.w16(S.Y, m.u16(S.CY));
  m.w16(S.X2, m.u16(S.OX)); m.w16(S.Y2, m.u16(S.OY));
  m.w16(S.X, m.u16(S.X) + m.u16(si + 0x20));
  m.w16(S.Y, m.u16(S.Y) + m.u16(si + 0x22));
  m.w16(S.X2, m.u16(S.X2) + m.u16(bx + 0x20));
  m.w16(S.Y2, m.u16(S.Y2) + m.u16(bx + 0x22));
  if (m.s16(S.Y) < m.s16(S.OY)) return;
  if (m.s16(S.X) < m.s16(S.OX)) return;
  if (m.s16(S.Y2) < m.s16(S.CY)) return;
  if (m.s16(S.X2) < m.s16(S.CX)) return;
  return pairEvent(m, si, bx, cl, ctx);
}
