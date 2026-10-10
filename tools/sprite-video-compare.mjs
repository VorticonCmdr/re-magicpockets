// sprite-video-compare.mjs: compares the port's sprite renderer against DOSBox video frames of the same moment.
//   node tools/sprite-video-compare.mjs <world> <dump.log> <video.rgb>
// dump.log: lines `ROW <n> G <hex 0x8B50..0x8CAF> L <hex 0x91BE..> B <hex 0x9398..>` written by a Lua script (debug log) while a ZMBV
// capture ran (`ffmpeg -i video.avi -pix_fmt rgb24 -f rawvideo video.rgb`, 320x200). For each row the sprite draw commands are
// rebuilt from the dumped entity block, rasterised, and compared with every video frame; the best frame is reported with the
// number of sprite pixels that match exactly (`opaque` = pixels the port draws).
import fs from 'node:fs';
import { rncUnpack } from '../web/core/rnc.js';
import { DsMemory } from '../web/engine/ds-memory.js';
import { WORLD_PALETTES } from '../web/core/palette.js';
import { decodeMaskedTile } from '../web/core/ega.js';
import { collectDraws, mirrorTile32, BANKS } from '../web/render/sprites.js';

const [world, logFile, rgbFile] = process.argv.slice(2);
const R = new URL('../', import.meta.url).pathname;
const exe = new Uint8Array(fs.readFileSync(R + 'game/GAMEU.EXE'));
const pal = WORLD_PALETTES['world' + world];
const raw = {};
for (const b of Object.values(BANKS)) for (const f of b.files) { const n = f.replace('%', world); raw[n] = rncUnpack(new Uint8Array(fs.readFileSync(R + 'data/' + n))).data; }
const banks = {};
for (const [id, b] of Object.entries(BANKS)) {
  const parts = b.files.map((f) => raw[f.replace('%', world)]);
  const buf = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let at = 0; for (const x of parts) { buf.set(x, at); at += x.length; }
  banks[id] = { b, buf };
}
const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const W = 320, H = 200, FS = W * H * 3;
const vid = fs.readFileSync(rgbFile);
const nFrames = Math.floor(vid.length / FS);

function tileRgba(cmd) {
  const bk = banks[cmd.bank];
  const { tw, th, widthBytes } = bk.b;
  const size = widthBytes * th * 5;
  let src = bk.buf, off = cmd.tile * size;
  if (cmd.mirror && widthBytes === 4) { src = mirrorTile32(bk.buf, off); off = 0; }
  const rgba = decodeMaskedTile(src, off, widthBytes, th, pal);
  if (cmd.vflip) { const fl = new Uint8Array(rgba.length); for (let r = 0; r < th; r++) fl.set(rgba.subarray(r * tw * 4, (r + 1) * tw * 4), (th - 1 - r) * tw * 4); return { rgba: fl, tw, th }; }
  return { rgba, tw, th };
}

function raster(cmds) {
  const img = new Int32Array(W * H).fill(-1); // packed rgb or -1
  for (const c of cmds) {
    if (!c.bank || c.tile < 0 || !banks[c.bank] || c.tile >= banks[c.bank].b.tiles) continue;
    const { rgba, tw, th } = tileRgba(c);
    let sy = 0, sh = Math.min(th, c.h || th), sw = tw;
    if (c.vflip) sy = th - c.h; else if (c.half >= 0) { sy = c.half * 16; sh = 16; sw = 32; }
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const o = ((sy + y) * tw + x) * 4;
      if (rgba[o + 3] === 0) continue;
      const px = c.dx + x, py = c.dy + y;
      if (px < 0 || px >= W || py < 0 || py >= 192) continue; // the view is 192 lines; below it is the HUD strip
      img[py * W + px] = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    }
  }
  return img;
}

const rows = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /ROW /.test(l));
for (const line of rows) {
  const mm = /ROW (\S+) G ([0-9a-f]+) L ([0-9a-f]+) B ([0-9a-f]+)/.exec(line);
  if (!mm) continue;
  const m = new DsMemory(exe);
  m.put(0x8b50, hex(mm[2])); m.put(0x91be, hex(mm[3])); m.put(0x9398, hex(mm[4]));
  const cmds = collectDraws(m);
  const img = raster(cmds);
  let opaque = 0; for (let i = 0; i < img.length; i++) if (img[i] >= 0) opaque++;
  let best = { f: -1, ok: -1 };
  for (let f = 0; f < nFrames; f++) {
    let ok = 0; const o = f * FS;
    for (let i = 0; i < img.length; i++) if (img[i] >= 0) { const p = o + i * 3; if (((vid[p] << 16) | (vid[p + 1] << 8) | vid[p + 2]) === img[i]) ok++; }
    if (ok > best.ok) best = { f, ok };
  }
  if (process.env.WHERE && best.f >= 0) { // bounding boxes of the mismatching sprite pixels, per draw command
    const o = best.f * FS; const miss = {};
    for (const c of cmds) { if (!c.bank) continue; }
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let i = 0; i < img.length; i++) if (img[i] >= 0) { const p = o + i * 3; if (((vid[p] << 16) | (vid[p + 1] << 8) | vid[p + 2]) !== img[i]) { const x = i % W, y = (i / W) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); n++; } }
    console.log(`  mismatch box x ${x0}..${x1} y ${y0}..${y1} (${n} px)`);
  }
  console.log(`row ${mm[1]} world ${m.u16(0x8b89)}.${m.u16(0x8b8b)} cmds ${cmds.length} opaque ${opaque} best video frame ${best.f} exact ${best.ok} (${(100 * best.ok / opaque).toFixed(1)}%)`);
}
