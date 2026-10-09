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
      if (m.u16(0x8b89) !== 2) return;
      ctx.unported.add('F489 world 2 standing');
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
  if (al > 0) { if (m.u16(0x8b89) !== 2) return; ctx.unported.add('F489 world 2 standing'); return; } // F54B
  if (m.u8(si + 1) === 0x11) m.w8(si + 1, 0x10);
  al = (-al) >> 1; // neg al; sar al,1
  m.w8(si + 0x26, al & 0xff);
  if (m.s8(si + 0x26) <= 3) { settle(); return; }
  if (m.u16(0x8b89) !== 2) return; // F54B
  ctx.unported.add('F489 world 2 standing');
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
  if (m.u8(si + 1) === 0x11) { ctx.unported.add('F842 world state 0x11 (F949)'); return; }
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
function sideEnemy(m, bx, ctx) {
  const face = m.u16(bx + 0x14);
  if (face === 0) return;
  if (m.u16(bx + 4) !== 2) { ctx.unported.add(`E8D7/E961 kind ${m.u16(bx + 4)}`); return; }
  const probe = face === 8 ? R.CC : R.CB;
  const hit2 = face === 8 ? R.C8 : R.C7;
  if (m.u8(probe) === 0) return;
  sideContact(m, bx, m.u8(hit2) !== 0);
}

/** 1000:F290 (kind 2 floor contact) and F37D (no floor). */
function floorEnemy(m, bx, ctx) {
  const cls = m.u16(bx + 2);
  if (m.u8(R.CA) === 0) { // E703 -> F37D
    if (cls !== 0x13) { ctx.unported.add(`F37D class 0x${cls.toString(16)}`); return; }
    if (m.u8(bx + 1) !== 0) return;
    m.w16(bx + 0xa, 0x24);
    m.w8(bx + 1, 0x8d); m.w16(bx + 0xc, 0xcfd1);
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

/** 1000:E5B3 for kind 2 (ceiling). */
function ceilingEnemy(m, bx) {
  if (m.u8(R.C9) === 0) return;
  if (m.u8(R.C5) !== 0) alignToCeiling(m, bx);
  m.w16(bx + 0x24, m.u16(bx + 0x24) | 1);
}

/** 1000:E2C2: vertical resolution by the sign of the vertical speed. */
function verticalEnemy(m, bx, ctx) {
  const vy = m.s8(bx + 0x26);
  if (vy > 0) ceilingEnemy(m, bx); else floorEnemy(m, bx, ctx);
}

/** The enemy half of 1000:E14F (world 1-2, kinds other than the player). */
function resolveEnemy(m, bx, di, ctx) {
  if (m.u16(bx + 4) !== 2) { ctx.unported.add(`E14F kind ${m.u16(bx + 4)}`); return; }
  const vy = m.s8(bx + 0x26);
  let dl, dh;
  if (vy > 0) { scanLeft(m, bx, di); dl = m.s8(R.C9); } else { scanFloor(m, bx, di); dl = m.s8(R.CA); }
  if (m.u16(bx + 0x14) === 8) { scanBottom(m, bx, di); ledgeProbe(m, bx); dh = m.s8(R.CC); } else { scanTop(m, bx, di); ledgeProbe(m, bx); dh = m.s8(R.CB); }
  const side = () => sideEnemy(m, bx, ctx);
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
