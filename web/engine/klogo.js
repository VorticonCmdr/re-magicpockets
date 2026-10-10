// The Konami / Renegade copyright screen of KLOGOPOU.EXE (KLOGOPOK.EXE depacked), the first thing pockets.exe runs, as a pure state machine.
//
// pockets.exe starts it as `klogopok.exe /m1 /t5 0` (mode digit 1 = video driver 'C', EGA mode 0x0D; /t5 = 5 x 50 timer ticks). It is NOT the
// Bitmap Brothers logo (docs/launcher.md said so; `[PROVEN]` by the DOSBox video: the picture is the Renegade skull and "KONAMI").
//
// What it does (CS = file 0x30 + xxxx, DS:0000 = file 0x30 + 0x3660, `mov ax,0x366` at CS:029C):
//  * the picture is the resource LOGO1.HUF in an EJWLIB archive appended to the EXE (offset = MZ image size 15228, `Dos_LoadOverlayResource`
//    CS:03C8): a 10-byte header (entry count, key word, "EJWLIB"), then 22-byte entries whose bytes are XORed with a running key (`key += key >> 8`,
//    CS:04B0..04B8), then the LZHUF streams (web/core/lzhuf.js). LOGO1.HUF unpacks to 32000 bytes = 200 rows of 4 plane rows of 40 bytes
//    (plane k = index bit k, MSB = leftmost pixel): the EGA strips copy it straight to VRAM (CS:3350, 8 interlaced passes of 25 rows, no
//    waits in mode '1'). The CS:31A2 nibble-to-plane conversion belongs to mode '2' only (CS:01AB).
//  * the 16 target colours are 6-bit DAC triples at DS:04A6 (DS:0476 for mode '0'); the screen starts black (DS:0446 is all zero).
//  * fade in: 32 steps, each adds 2 to every component up to the target (CS:35A2..35FA), one timer tick per step; hold [C3] = 50 x t ticks
//    (a key press ends it, CS:012F..0137); fade out: 32 steps of -2 (CS:325C, [35FD] = 0xFE).
//  * the tick is the PIT channel 0 interrupt at divisor 0x5D2E = 1193182 / 23854 = 50.02 Hz (CS:034F), NOT the vsync.
// Evidence: `[PROVEN]` against DOSBox video (tools/front-capture/import-intro.mjs, `npm run verify` group checkIntro).

'use strict';

import { lzhufDecode } from '../core/lzhuf.js';

export const KLOGO_DS = 0x30 + 0x366 * 16;
export const KLOGO_HZ = 1193182 / 0x5d2e;
export const LOGO_W = 320, LOGO_H = 200;
const MZ_IMAGE = (b) => (((b[4] | (b[5] << 8)) - 1) * 512 + (b[2] | (b[3] << 8)));

/** The entries of the EJWLIB archive after the MZ image: `{ name, size, offset }` (offset from the archive start, `Dos_LoadOverlayResource` CS:03F7..0530). */
export function archiveEntries(exe) {
  const base = MZ_IMAGE(exe);
  const cnt = exe[base] | (exe[base + 1] << 8);
  if (String.fromCharCode(...exe.subarray(base + 4, base + 10)) !== 'EJWLIB') throw new Error('KLOGOPOU.EXE: no EJWLIB archive after the MZ image');
  const key = exe[base + 2] | (exe[base + 3] << 8);
  let al = key & 0xff; const ah = key >> 8;
  let pos = base + 10;
  const out = [];
  for (let e = 0; e < cnt; e++) {
    const ent = new Uint8Array(0x16);
    for (let i = 0; i < 0x16; i++) { ent[i] = exe[pos + i] ^ al; al = (al + ah) & 0xff; } // the key runs on across the records
    pos += 0x16;
    let name = ''; for (let i = 0; i < 10 && ent[i]; i++) name += String.fromCharCode(ent[i]);
    // the name is NUL-terminated within 12 bytes; entry 1 ("LOGO2_4.HUF") is 11 characters
    name = ''; for (let i = 0; i < 12 && ent[i]; i++) name += String.fromCharCode(ent[i]);
    out.push({ name, size: ent[0xe] | (ent[0xf] << 8), offset: ent[0x12] | (ent[0x13] << 8) | (ent[0x14] << 16) });
  }
  return out;
}

/** Find an entry of the EJWLIB archive after the MZ image and unpack it. Returns the unpacked bytes. */
export function readArchiveEntry(exe, name) {
  const base = MZ_IMAGE(exe);
  const e = archiveEntries(exe).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!e) throw new Error(`KLOGOPOU.EXE: no archive entry ${name}`);
  return lzhufDecode(exe, base + e.offset).data;
}

/** `{ pixels: 320 x 200 palette indices, target: 16 x [r, g, b] 6-bit DAC values }` for video mode '1'. */
export function loadLogo(exe) {
  const raw = readArchiveEntry(exe, 'LOGO1.HUF');
  const pixels = new Uint8Array(LOGO_W * LOGO_H);
  for (let y = 0; y < LOGO_H; y++) {
    for (let x = 0; x < LOGO_W; x++) {
      let v = 0;
      for (let p = 0; p < 4; p++) v |= ((raw[y * 160 + p * 40 + (x >> 3)] >> (7 - (x & 7))) & 1) << p;
      pixels[y * LOGO_W + x] = v;
    }
  }
  const target = [];
  for (let i = 0; i < 16; i++) target.push([0, 1, 2].map((k) => exe[KLOGO_DS + 0x4a6 + i * 3 + k]));
  return { pixels, target };
}

/** DOSBox's 6-bit -> 8-bit DAC expansion (52 -> 210, `[PROVEN]` by the video). */
export const dacTo8 = (v) => Math.round((v * 255) / 63);
export const toRgb = (dac) => dac.map((c) => c.map(dacTo8));

/** A new state; `seconds` is the /t switch (pockets.exe passes 5). One `step` = one timer tick (KLOGO_HZ). */
export function createLogo(data, opts = {}) {
  const hold = 50 * (opts.seconds ?? 5);
  return { data, hold, t: 0, cur: data.target.map(() => [0, 0, 0]), done: false, key: false };
}

/** One 50.02 Hz tick. `input.key` ends the hold early. Returns `{ done, draw: { dac } }`. */
export function step(s, input = null) {
  if (s.done) return { done: true, draw: null };
  s.key = !!(input && input.key);
  const t = s.t++;
  if (t < 32) { // 358C fade in
    s.cur = s.cur.map((c, i) => c.map((v, k) => Math.min(v + 2, s.data.target[i][k])));
  } else if (t < 32 + s.hold && !s.keyed) { // hold: [389] counts down once per tick; any key press (CS:0127..0137) leaves
    if (s.key) { s.keyed = true; s.t = 32 + s.hold; }
  } else {
    const o = s.t - (32 + s.hold) - 1; // fade out, 32 steps (a hold ended by a key reaches here at once)
    if (o >= 32) { s.done = true; return { done: true, draw: null }; }
    s.cur = s.cur.map((c) => c.map((v) => { const w = (v - 2) & 0xff; return w < 0x3f ? w : 0; }));
  }
  return { done: false, draw: { dac: s.cur } };
}

/** The distinct consecutive DAC states of a whole run (the hold repeats one): 0 = black, 1..32 fade in, 33..64 fade out. */
export function distinctStates(data, seconds = 5) {
  const out = [data.target.map(() => [0, 0, 0])], s = createLogo(data, { seconds });
  for (;;) {
    const o = step(s);
    if (o.done) break;
    const d = o.draw.dac.map((c) => c.slice());
    if (JSON.stringify(d) !== JSON.stringify(out[out.length - 1])) out.push(d);
  }
  return out;
}

/** RGB bytes (320 x 200 x 3) of the picture where colour k uses `above[k]` on rows < `split[k]` and `below[k]` from there on (one frame of the torn fade). */
export function frameRgb(pixels, above, below, split) {
  const out = new Uint8Array(LOGO_W * LOGO_H * 3);
  for (let y = 0; y < LOGO_H; y++) {
    for (let x = 0; x < LOGO_W; x++) {
      const k = pixels[y * LOGO_W + x], c = y < split[k] ? above[k] : below[k], o = (y * LOGO_W + x) * 3;
      out[o] = dacTo8(c[0]); out[o + 1] = dacTo8(c[1]); out[o + 2] = dacTo8(c[2]);
    }
  }
  return out;
}
