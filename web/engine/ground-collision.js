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
  if (ps === 0x1d) { ctx.unported.add('F77B player state 0x1d'); return; }
  if (t === 0x41 || t === 0x21) return;
  if (t === 0x43) { ctx.unported.add('F77B target 0x43'); return; }
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

/** 1000:F489: the player has ground underneath. Only the standing (world state 0) case is ported. */
function land(m, si, bx, ctx) {
  const t = m.u8(0x8b98);
  if (t === 0x21 || t === 0x41 || t === 3) { ctx.unported.add(`F489 target ${t}`); return; }
  if (t !== 0xff) {
    if (m.u8(si + 1) === 0xaf) return; // F4D7
    if (m.u8(bx + 1) === 0x35) { ctx.unported.add('F489 player state 0x35'); return; }
    if (m.u8(si + 1) === 0) { // F54B
      if (m.u16(0x8b89) !== 2) return;
      ctx.unported.add('F489 world 2 standing');
      return;
    }
  }
  ctx.unported.add('F489 landing/other');
}

/** 1000:E8D7 / E961 for the player: a side probe hit sends it to F842. */
function resolveSide(m, si, bx, probeAddr, ctx) {
  if (m.u8(probeAddr) === 0) return;
  ctx.unported.add('F842 lateral response');
}

/** 1000:E14F Entity_ResolveGroundCollision, player (class 3) branch only. */
function resolveGroundCollision(m, si, bx, di, ctx) {
  m.w16(bx + 0x24, 0);
  if (m.u16(0x8b89) === 3) { ctx.unported.add('E14F world 3'); return; }
  if (m.u16(bx + 2) !== 3) { ctx.unported.add('E14F non-player'); return; }
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

/** 1000:DFAC: box overlap test between `si` and `bx` for pair-table value `cl` (not 0x63). */
export function overlapTest(m, si, bx, cl, ctx) {
  if (m.u16(bx + 2) === 0) return;
  if (cl > 127) { ctx.unported.add('DFAC negative pair value (5761)'); return; }
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
  ctx.unported.add('45F8 overlap event');
}
