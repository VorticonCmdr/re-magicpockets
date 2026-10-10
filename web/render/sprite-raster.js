// Software rasteriser for the sprite draw commands of web/render/sprites.js (no DOM): used by tools/sprite-video-compare.mjs and
// the `npm run verify` comparison against DOSBox video frames. `raw` maps depacked pak names (bitkid.pak, kidx2.pak, ...) to bytes.
'use strict';

import { decodeMaskedTile } from '../core/ega.js';
import { mirrorTile32, BANKS } from './sprites.js';

export const VIEW_W = 320, VIEW_H = 192; // the playfield; the HUD strip below it is not sprite territory

export function buildBanks(raw, world) {
  const banks = {};
  for (const [id, b] of Object.entries(BANKS)) {
    const parts = b.files.map((f) => raw[f.replace('%', world)]);
    if (parts.some((x) => !x)) continue;
    const buf = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
    let at = 0; for (const x of parts) { buf.set(x, at); at += x.length; }
    banks[id] = { b, buf };
  }
  return banks;
}

function tileRgba(banks, pal, cmd) {
  const bk = banks[cmd.bank];
  const { tw, th, widthBytes } = bk.b;
  const size = widthBytes * th * 5;
  let src = bk.buf, off = cmd.tile * size;
  if (cmd.mirror && widthBytes === 4) { src = mirrorTile32(bk.buf, off); off = 0; }
  const rgba = decodeMaskedTile(src, off, widthBytes, th, pal);
  if (!cmd.vflip) return { rgba, tw, th };
  const fl = new Uint8Array(rgba.length);
  for (let r = 0; r < th; r++) fl.set(rgba.subarray(r * tw * 4, (r + 1) * tw * 4), (th - 1 - r) * tw * 4);
  return { rgba: fl, tw, th };
}

/** @returns {Int32Array} VIEW_W*VIEW_H packed 0xRRGGBB, or -1 where no sprite pixel is drawn. */
export function rasterize(cmds, banks, pal) {
  const img = new Int32Array(VIEW_W * VIEW_H).fill(-1);
  for (const c of cmds) {
    if (!c.bank || c.tile < 0 || !banks[c.bank] || c.tile >= banks[c.bank].b.tiles) continue;
    const { rgba, tw, th } = tileRgba(banks, pal, c);
    let sy = 0, sh = Math.min(th, c.h || th), sw = tw;
    if (c.vflip) sy = th - c.h; else if (c.half >= 0) { sy = c.half * 16; sh = 16; sw = 32; }
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const o = ((sy + y) * tw + x) * 4;
      if (rgba[o + 3] === 0) continue;
      const px = c.dx + x, py = c.dy + y;
      if (px < 0 || px >= VIEW_W || py < 0 || py >= VIEW_H) continue;
      img[py * VIEW_W + px] = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    }
  }
  return img;
}
