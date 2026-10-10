// Entity sprite rendering, transliterated from the original render pass (main-loop call 3 =
// CS:73A5 "consume the visible list", per-entity draw = 1000:7419). Pure/isomorphic: it reads a
// DsMemory (or anything with u8/u16/s16) and the exe's static tables; drawing is done through an
// injected atlas so there is no DOM/fs code here.
//
// Evidence tags: every claim is [PROVEN] only where the comment says so; the rest is [STATIC]
// (read from the disassembly, `build/analysis/dis.sh`, code offsets below are CS-relative, file
// offset = 0x340 + CS).
//
// What the disassembly says (all [STATIC] unless noted):
//  * Entity record: +2 type (descriptor index), +4 class, +6/+8 x/y, +0xa frame, +0x14 facing,
//    +0x16 draw mode (a/b/d/e/f), +0x40 state (0x19 = not drawn).
//  * Descriptor = near pointer at DS:0xC39A + 2*type (1000:C16A), words: +0xa columns, +0xc rows,
//    +0xe bank id, +0x12 cell width, +0x14 cell height, +0x16 "frame source mode".
//  * Tile stream: bx = DS word at table[2*frame] (table E4FA, E906 for class 2/4, DEA2 for type
//    0x2d; 74A1..74E3). The stream is column-major, one byte per cell. frameSourceMode 0 reads
//    the byte as the tile index; mode 1 uses the entity frame (+0xa) itself as the tile index
//    for every cell; any other value reads video memory (not drawn here). This is the answer to
//    UNKNOWN_frame_source_mode_0 (docs/open-questions-history.md item 5).
//  * Draw modes: 0xe = 16x16 tiles (160 bytes, extras layout), 0xf = 32x32 tiles (640 bytes),
//    0xa = 32x16 half tiles (byte = tile*2 + half; zero byte = empty cell), 0xd = one 32-wide
//    tile at y+31, 0xb = the world/background entity (drawn by the background canvas instead).
//  * Mirroring is done by a pre-built bit-reversed copy of the bank (1000:B449): class 2/4 in
//    mode 0xf with facing (+0x14) != 4 read the mirrored copy of bank 7 (7B9D..7BB4); class 3 with
//    facing != 8 reads the mirrored copy of bank 2 (B42E).
//  * [PROVEN] by live DOSBox reads (tile 9 of banks 2/3/6/7 equals the depacked pak bytes in
//    world 1): bank 2 = bitkid+kidxN (80 tiles), 3 = specialN (20), 6 = extras+extraxN (320,
//    16x16), 7 = nastyN (60); bank 8 (segment table word 8) = mirrored bank 7.

'use strict';

import { decodeMaskedTile } from '../core/ega.js';

export const DESCRIPTOR_TABLE = 0xc39a; // 96 near pointers
export const TABLE_E4FA = 0xe4fa;
export const TABLE_E906 = 0xe906;
export const TABLE_DEA2 = 0xdea2;
export const VISIBLE_LIST = 0x91be;

/** Bank id -> geometry (see header). `tiles` is the tile count in world 1..4 (identical). */
export const BANKS = {
  2: { tw: 32, th: 32, widthBytes: 4, tiles: 80, files: ['bitkid.pak', 'kidx%.pak'] },
  3: { tw: 32, th: 32, widthBytes: 4, tiles: 20, files: ['special%.pak'] },
  6: { tw: 16, th: 16, widthBytes: 2, tiles: 320, files: ['extras.pak', 'extrax%.pak'] },
  7: { tw: 32, th: 32, widthBytes: 4, tiles: 60, files: ['nasty%.pak'] },
};

const s16 = (m, o) => m.s16(o);

/**
 * The per-entity draw commands for the current entity list (what call 3 would blit), in draw order.
 * Each command: { bank, tile, half (-1 none, 0/1 = top/bottom 32x16 half), dx, dy, w, h, mirror, ent, type }.
 * Cells whose source is not a bank tile (frameSourceMode 0xffff etc.) are returned with bank 0.
 */
export function collectDraws(m, o = {}) {
  const cmds = [];
  const filter = m.u8(0x8ba1);
  const pan = m.u16(0x8b69) & 0xf;
  for (let a = VISIBLE_LIST; ; a += 2) {
    const p = m.u16(a);
    if (p === 0xffff) break;
    const type = m.u16(p + 2);
    if (type === 0 || m.u8(p + 0x40) === 0x19) continue;
    const cls = m.u16(p + 4);
    // 73C1..7409: the [8BA1] draw filter
    if (filter !== 0) {
      if (filter >= 0x80) { if (cls === 0 || cls === 3) continue; } else if (filter === 0x45) {
        const keep = type === 0x2d || type === 1 || type === 0xf || type === 0x1f || type === 7 || type === 3;
        if (m.u16(0x8c34) === 0x16 && !(type === 0x2d || type === 1 || type === 0xf)) continue;
        if (!keep) continue;
      }
    }
    const first = cmds.length;
    drawEntity(m, p, type, cls, pan, cmds, o);
    // The entity is blitted at x + ([8B69]&15) into the 352-wide buffer, and the hardware pan shifts the
    // visible window by the same [8B69]&15, so the on-screen x is the record's x. [PROVEN]: with [8B69]=0x1C
    // a live DOSBox frame matches only for a net offset of 0 (2681 of 2764 sprite pixels; pan 4/8/12 match ~450).
    for (let i = first; i < cmds.length; i++) cmds[i].dx -= pan;
  }
  return cmds;
}

function drawEntity(m, p, type, cls, pan, cmds, o) {
  let x = s16(m, p + 6);
  const y = s16(m, p + 8);
  if (type !== 1) x += pan; // 7425..7431
  if (type !== 1 && type !== 0x2d && (x < -0x40 || x > 0x180 || y < -0x40 || y > 0xe0)) return; // 743B..7462
  const mode = m.u8(p + 0x16);
  if (mode !== 0xe && mode !== 0xf && mode !== 0xa && mode !== 0xd) return; // 0xb = background entity
  let frame = m.u16(p + 0xa);
  const facing = m.u16(p + 0x14);
  let dt = type; // descriptor index ([8C29])
  let table;
  // 746E..74E3: which near-pointer table the frame indexes
  if (cls === 5 || type === 0x2b) table = TABLE_E4FA;
  else {
    let done = false;
    if (type === 8) { dt = m.u16(0x8c51); if (mode === 0xf) { table = TABLE_E906; done = true; } }
    if (!done) {
      if (type === 0x42 && facing !== 4) frame += 0x10;
      if (cls === 2 || cls === 4) table = TABLE_E906;
      else if (type === 0x2d) table = TABLE_DEA2;
      else table = TABLE_E4FA;
    }
  }
  if (dt >= 96) return;
  const d = m.u16(DESCRIPTOR_TABLE + 2 * dt);
  let cols = m.u16(d + 0xa);
  const rows = m.u16(d + 0xc);
  let bank = m.u16(d + 0xe);
  const fsm = m.u16(d + 0x16);
  const th = m.u16(d + 0x14);
  let firstRows = rows;
  // 7526..7557: per-type tweaks
  if (type === 0x39 && frame > 0x32) bank = 7;
  if (type === 0x2d && m.u16(p + 0xa) >= 0x35) { /* [89E0]=0x2b columns */ cols = 0x2b; }
  if (type === 3 && m.u16(p + 0xa) >= 0xc5) firstRows += 1;
  let bx = m.u16(table + 2 * frame);
  const wrapX = mode === 0xe ? 16 : 32;
  let mirror = false;
  let dx = x;
  if (mode === 0xd) { // 7D77: one 32-wide tile of the stream at y+31 (1000:7EA0 blitter)
    cmds.push({ bank, tile: m.u8(bx), half: -1, dx: x, dy: y + 32 - th, w: 32, h: th, mirror: false, vflip: true, ent: p, type, mode });
    return;
  }
  if (mode === 0xf && (cls === 2 || cls === 4) && facing !== 4) { mirror = true; bank = 7; } // 7B9D..7BB4
  if (mode === 0xa && cls === 3 && facing !== 8) mirror = true; // B42E: mirrored bank 2
  if (mode === 0xa && type !== 3 && m.s16(0x8c34) < 0) return; // 75DB..75E8
  let nRows = firstRows;
  for (let c = 0; c < cols; c++) {
    const colStart = bx;
    let dy = y;
    for (let r = 0; r < nRows; r++) {
      let tile;
      if (mode === 0xa || fsm === 0) tile = m.u8(bx); else if (fsm === 1) tile = m.u16(p + 0xa); else tile = -1;
      if (fsm === 0 || mode === 0xa) bx++;
      if (mode === 0xa) {
        if (tile !== 0) cmds.push({ bank, tile: tile >> 1, half: tile & 1, dx, dy, w: 32, h: th, mirror, ent: p, type, mode });
        dy += 0x10;
      } else {
        if (fsm === 0 || fsm === 1) cmds.push({ bank, tile, half: -1, dx, dy, w: wrapX, h: th, mirror, ent: p, type, mode });
        else cmds.push({ bank: 0, tile: -1, half: -1, dx, dy, w: wrapX, h: th, mirror, ent: p, type, mode });
        dy += th;
      }
      if (dy >= 0xc0) break;
    }
    bx = colStart + rows; // 7B58: the next column starts [89E2] bytes on
    nRows = rows;
    dx += wrapX;
    if (dx >= 0x140) break;
  }
}

const REV = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let v = 0; for (let b = 0; b < 8; b++) if (i & (1 << b)) v |= 0x80 >> b; REV[i] = v; }

/** 1000:B449: mirror a 32x32 5-plane tile: every 4-byte row is bit-reversed and byte-reversed. */
export function mirrorTile32(buf, off) {
  const out = new Uint8Array(640);
  for (let g = 0; g < 160; g++) {
    for (let k = 0; k < 4; k++) out[g * 4 + k] = REV[buf[off + g * 4 + 3 - k]];
  }
  return out;
}

/**
 * Atlas over the depacked bank files: raw = { 'bitkid.pak': Uint8Array, ... } (all files named in
 * BANKS for the world, `%` replaced by the world number). makeCanvas(w, h) -> object with
 * getContext('2d') (e.g. document.createElement('canvas')).
 */
export function buildSpriteAtlas(raw, world, palette, makeCanvas) {
  const banks = {};
  for (const [id, b] of Object.entries(BANKS)) {
    const parts = b.files.map((f) => raw[f.replace('%', world)]);
    if (parts.some((x) => !x)) continue;
    const len = parts.reduce((s, x) => s + x.length, 0);
    const buf = new Uint8Array(len);
    let at = 0;
    for (const x of parts) { buf.set(x, at); at += x.length; }
    banks[id] = { b, buf, cache: new Map() };
  }
  const tileCanvas = (id, idx, mirror, vflip) => {
    const bk = banks[id];
    if (!bk || idx < 0 || idx >= bk.b.tiles) return null;
    const key = idx * 4 + (mirror ? 1 : 0) + (vflip ? 2 : 0);
    let cv = bk.cache.get(key);
    if (cv) return cv;
    const { tw, th, widthBytes } = bk.b;
    const size = widthBytes * th * 5;
    let src = bk.buf, off = idx * size;
    if (mirror && widthBytes === 4) { src = mirrorTile32(bk.buf, off); off = 0; }
    const rgba = decodeMaskedTile(src, off, widthBytes, th, palette);
    cv = makeCanvas(tw, th);
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(tw, th);
    img.data.set(rgba);
    if (vflip) { // 7F67: rows are written bottom-up
      const fl = c2.createImageData(tw, th);
      for (let r = 0; r < th; r++) fl.data.set(img.data.subarray(r * tw * 4, (r + 1) * tw * 4), (th - 1 - r) * tw * 4);
      c2.putImageData(fl, 0, 0);
    } else c2.putImageData(img, 0, 0);
    bk.cache.set(key, cv);
    return cv;
  };
  return { tileCanvas, banks };
}

/** Draw every entity sprite. Returns { drawn, missing: [cmd...] } (missing = no atlas tile). */
export function drawEntities(ctx2d, m, atlas, o = {}) {
  const cmds = collectDraws(m, o);
  let drawn = 0;
  const missing = [];
  for (const c of cmds) {
    const cv = c.bank ? atlas.tileCanvas(c.bank, c.tile, c.mirror, c.vflip) : null;
    if (!cv) { missing.push(c); continue; }
    if (c.vflip) ctx2d.drawImage(cv, 0, cv.height - c.h, cv.width, c.h, c.dx, c.dy, cv.width, c.h);
    else if (c.half >= 0) ctx2d.drawImage(cv, 0, c.half * 16, 32, 16, c.dx, c.dy, 32, 16);
    else ctx2d.drawImage(cv, 0, 0, cv.width, Math.min(cv.height, c.h || cv.height), c.dx, c.dy, cv.width, Math.min(cv.height, c.h || cv.height));
    drawn++;
  }
  return { drawn, missing };
}
