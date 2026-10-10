// The front end: everything GAMEU.EXE does OUTSIDE the 14-call main loop, as pure functions and an explicit
// per-tick state machine (one tick = one vsync = 1/70 s, the unit of the original's own waits).
//
// What GAMEU has outside the loop (docs/engine.md "Front end"):
//  * the WORLD INTRO screen, one fixed non-interactive animation inside each World*_LoadBanks (B56B world 1, B6F0, B8B7,
//    BA3C). It is the only "world map": `new.pip` (four islands + the number boxes 1-4 + an arrow) is depacked, and the
//    screen is composed from rectangles of it (BD0A, latch copies), then 8 palette-fade steps in, a pause for the disk
//    loads, 5 x (box 11 frames on, 11 frames off), 8 palette-fade steps out. No key is read anywhere in it.
//  * the LEVEL DISPATCH (1000:03FF): which map file (and script / extra bank) the next (world, sub-level) loads, when the
//    next world starts (7EB, with its intro screen) and where the ending is (6E3, world 4 sub 10).
// The Konami/Renegade screen and the captions / close-ups / title are NOT in GAMEU.EXE: they belong to KLOGOPOU.EXE and INTROU.EXE, which the
// launcher (pockets.exe) runs before game.exe (docs/launcher.md); web/engine/klogo.js and web/engine/intro.js model them.
//
// Evidence tags follow CLAUDE.md. The intro's composition, palette and timing are `[PROVEN]` against DOSBox video captures
// of all four worlds (tools/front-capture, asserted by `npm run verify`); the dispatch is `[STATIC]` (read from the
// disassembly; its file names agree with the `[PROVEN]` level table of web/engine/level-registry.js, which verify checks).

'use strict';

import { decodeBank } from '../core/palette.js';
import { DS_FILE_OFFSET, CODE_FILE_OFFSET } from '../core/exe-data.js';

export const PIC_W = 320, PIC_H = 192; // new.pip (Gfx_DrawFullScreenPicture, 1000:BD64)
export const PAGE_STRIDE = 44; // the video page is 352 px = 44 bytes wide (CRTC offset 0x16), the picture's rows are 40 bytes
export const PAGE_W = PAGE_STRIDE * 8, PAGE_H = 200;
export const SCREEN_W = 320, SCREEN_H = 200;

const code = (exe, o) => exe[CODE_FILE_OFFSET + o];
const code16 = (exe, o) => code(exe, o) | (code(exe, o + 1) << 8);
const ds8 = (exe, o) => exe[DS_FILE_OFFSET + o];
const ds16 = (exe, o) => ds8(exe, o) | (ds8(exe, o + 1) << 8);

/** NUL-terminated string at DS:`ptr` ("data\\new1.pin"), reduced to the file name. */
export function dsFileName(exe, ptr) {
  let s = '';
  for (let o = DS_FILE_OFFSET + ptr; exe[o] !== 0; o++) s += String.fromCharCode(exe[o]);
  return s.slice(s.lastIndexOf('\\') + 1);
}

/** Decode `new.pip`'s unpacked bytes into 320 x 192 palette indices (plane k of each 16-pixel group is index bit k, `[PROVEN]` docs/formats/pip.md). */
export function decodePictureIndices(pip) {
  const out = new Uint8Array(PIC_W * PIC_H);
  let s = 0x22;
  for (let y = 0; y < PIC_H; y++) {
    for (let g = 0; g < PIC_W / 16; g++) {
      for (let k = 0; k < 16; k++) {
        const byte = k >> 3, mask = 0x80 >> (k & 7);
        let v = 0;
        for (let p = 0; p < 4; p++) if (pip[s + p * 2 + byte] & mask) v |= 1 << p;
        out[y * PIC_W + g * 16 + k] = v;
      }
      s += 8;
    }
  }
  return out;
}

// ---- the intro's rectangle table: 21 words in the code segment at CS:8EBB..8EE3 (odd addresses), read by `mov si/di,[cs:xxxx]` ----
export const RECT_TABLE = 0x8ebb;
const RECT = {
  islandDst: 0x8ebb, // where the world's 144 x 80 island goes (96, 64)
  arrowSrc: 0x8ebd, arrowDst: 0x8ebf, // the orange arrow (64 x 32), picture (0, 160) -> (32, 96)
  eraseSrc: 0x8ec1, eraseDstA: 0x8ebf, eraseDstB: 0x8ec3, // BDC7: two 32 x 32 pieces that overwrite the arrow
  boxOffSrc: 0x8ec5, boxDst: 0x8ec7, // the empty box (BE02) and where the number box sits (96, 56)
  box: [0x8ec9, 0x8ecb, 0x8ecd, 0x8ecf], // the number boxes 1-4: picture (288, 0/32/64/96) (BE16/BE2A/BE3E/BE52)
  leftSrcW2: 0x8ed1, leftDst: 0x8ed3, // the neighbours' slivers at the left and right edges
  srcX144: 0x8ed5, srcX256: 0x8edd, srcX144Y80: 0x8edb, srcX256Y80: 0x8edf, srcX0Y80: 0x8ee1,
  dstW3: 0x8ed7, dstW2R: 0x8ed9, dstRight: 0x8ee3,
};

/** The rectangle words, `[STATIC]` (read from the shipped code bytes: no table is embedded in this port). */
export function readRects(exe) {
  const r = {};
  for (const [k, v] of Object.entries(RECT)) r[k] = Array.isArray(v) ? v.map((a) => code16(exe, a)) : code16(exe, v);
  return r;
}

/**
 * A rectangle blit `BD0A(si, di, dx = rows, cx = words)`: copies `2 * words` bytes (16 pixels per word) per row, all four planes
 * at once (write mode 1 latch copy, BCD8), from the picture (40-byte rows) to the page (44-byte rows).
 */
export const blit = (si, di, rows, words) => ({ si, di, rows, words });

/**
 * The world's picture pieces in the order the loader copies them (B5A0.. world 1, B725.. world 2, B8EC.. world 3, BA71.. world 4),
 * then the arrow (BDEE) and the world's number box (BE16/BE2A/BE3E/BE52, called before the fade-in at B5C7/B761/B928/BA9A).
 * `[STATIC]` transliteration of the operands; `[PROVEN]` pixel for pixel against DOSBox video frames (see the verify checks).
 */
export function introBlits(rects, world) {
  const R = rects;
  const pieces = {
    1: [blit(0, R.islandDst, 0x50, 9), blit(R.srcX144, R.dstRight, 0x50, 2)],
    2: [blit(R.leftSrcW2, R.leftDst, 0x50, 2), blit(R.srcX144, R.islandDst, 0x50, 9), blit(R.srcX144Y80, R.dstW2R, 0x46, 2)],
    3: [blit(R.srcX256, R.leftDst, 0x50, 2), blit(R.srcX144Y80, R.dstW3, 0x46, 9), blit(R.srcX0Y80, R.dstRight, 0x50, 2)],
    4: [blit(R.srcX256Y80, R.leftDst, 0x46, 2), blit(R.srcX0Y80, R.islandDst, 0x50, 9)],
  }[world];
  if (!pieces) throw new Error(`no world intro for world ${world}`);
  return {
    pieces,
    arrow: blit(R.arrowSrc, R.arrowDst, 0x20, 4),
    erase: [blit(R.eraseSrc, R.eraseDstA, 0x20, 2), blit(R.eraseSrc, R.eraseDstB, 0x20, 2)],
    boxOn: blit(R.box[world - 1], R.boxDst, 0x20, 2),
    boxOff: blit(R.boxOffSrc, R.boxDst, 0x20, 2),
  };
}

/** Apply one blit to a 352 x 200 index page (a faithful byte copy: 8 pixels per byte, source rows 40 bytes, destination rows 44). */
export function applyBlit(page, pic, b) {
  for (let r = 0; r < b.rows; r++) {
    for (let k = 0; k < b.words * 2; k++) {
      const sa = b.si + r * 40 + k, da = b.di + r * PAGE_STRIDE + k;
      const sy = Math.floor(sa / 40), sc = sa % 40, dy = Math.floor(da / PAGE_STRIDE), dc = da % PAGE_STRIDE;
      for (let p = 0; p < 8; p++) page[dy * PAGE_W + dc * 8 + p] = pic[sy * PIC_W + sc * 8 + p];
    }
  }
}

/** The visible 320 x 200 window of the composed page. `panX` is the horizontal pan the page flip applies (154A: [8B69] & 7, plus 8 px when bit 3 is set). */
export function visibleWindow(page, panX = 0) {
  const out = new Uint8Array(SCREEN_W * SCREEN_H);
  for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) out[y * SCREEN_W + x] = page[y * PAGE_W + x + panX];
  return out;
}

/** 154A: the horizontal pixel pan of the page flip, from the scroll remainder word [8B69] (a stale value survives the intro: `[PROVEN]` 4 and 12 seen in DOSBox). */
export const panFromScroll = (w8b69) => (w8b69 & 7) + ((w8b69 & 8) ? 8 : 0);

/** The intro screen's palette for fade bank `bank` (Video_SelectAndLoadPalette 3BBF: pointer table at DS:DE56, 16 words each), as 16 [r, g, b]. */
export function bankPalette(exe, bank) {
  const ptr = ds16(exe, 0xde56 + 2 * bank);
  return decodeBank(exe.subarray(DS_FILE_OFFSET + ptr, DS_FILE_OFFSET + ptr + 32));
}

// ---- timing, read from the immediates of BE66 / BE90 / BEA2 (`[STATIC]`), one tick = one vsync (CS:0142 per tick) ----
/** Phase constants read from the code bytes (the opcode bytes are checked, so a different build fails loudly). */
export function introTiming(exe) {
  const expect = (o, bytes) => { for (let i = 0; i < bytes.length; i++) if (code(exe, o + i) !== bytes[i]) throw new Error(`unexpected code at CS:${(o + i).toString(16)}`); };
  expect(0xbe66, [0xb8]); expect(0xbe8a, [0x3d]); expect(0xbe90, [0xb8]); expect(0xbe9c, [0x3d]);
  expect(0xbea5, [0xc7, 0x06, 0x1b, 0x8c]); expect(0xbebb, [0x83, 0x3e, 0xf6, 0x89]); expect(0xbece, [0x83, 0x3e, 0xf6, 0x89]);
  expect(0xbe69, [0xe8, 0x53, 0x7d]); // CALL 3BBF (palette step) ...
  expect(0xbe84, [0xe8, 0xbb, 0x42]); // ... then CALL 0142 (a vsync)
  expect(0x3c11, [0xe8, 0x2e, 0xc5]); // 3BBF itself ends with CALL 0142 before applying the palette: two vsyncs per step
  return {
    fadeInFirst: code16(exe, 0xbe91), fadeInEnd: code16(exe, 0xbe9d), // banks 0x16 .. 0x1D
    fadeOutFirst: code16(exe, 0xbe67), fadeOutLast: code16(exe, 0xbe8b) + 1, // banks 0x1D .. 0x16 (loop stops when it reaches 0x15)
    ticksPerStep: 2,
    blinkCycles: code16(exe, 0xbea9),
    onTicks: code(exe, 0xbebf) + 1, offTicks: code(exe, 0xbed2) + 1, // `JNG` after CMP [89F6], 0xA: waits until the counter reads 11
  };
}

/**
 * Where the intro is after `t` ticks. `hold` is the number of ticks the original spends loading files between the fade-in and the
 * blink (`[PROVEN]` about 160 frames in DOSBox; disk time, not game logic: a stand-in here, 0 by default).
 * @returns {{phase: string, bank: number, arrow: boolean, box: 'on'|'off', done: boolean}}
 */
export function introPhase(timing, t, hold = 0) {
  // A fade step is `CALL 3BBF` (a vsync wait, then the palette is applied) followed by a vsync wait: step k takes effect on tick 2k + 1
  // (`[PROVEN]`: the first visible fade-out change comes 14 video frames after the last box toggle, 11 + 3).
  const stepAt = (n) => (n < 1 ? 0 : Math.floor((n - 1) / timing.ticksPerStep));
  const steps = timing.fadeInEnd - timing.fadeInFirst, fade = steps * timing.ticksPerStep;
  const blink = timing.blinkCycles * (timing.onTicks + timing.offTicks);
  if (t < fade) return { phase: 'fadeIn', bank: timing.fadeInFirst + stepAt(t), arrow: true, box: 'on', done: false };
  if (t < fade + hold) return { phase: 'hold', bank: timing.fadeInEnd - 1, arrow: true, box: 'on', done: false };
  const b = t - fade - hold;
  if (b < blink) return { phase: 'blink', bank: timing.fadeInEnd - 1, arrow: false, box: b % (timing.onTicks + timing.offTicks) < timing.onTicks ? 'on' : 'off', done: false };
  const o = b - blink, out = (timing.fadeOutFirst - timing.fadeOutLast + 1) * timing.ticksPerStep;
  if (o < out) return { phase: 'fadeOut', bank: timing.fadeOutFirst - stepAt(o), arrow: false, box: 'off', done: false };
  return { phase: 'done', bank: timing.fadeOutLast, arrow: false, box: 'off', done: true };
}

/** Compose the page for one intro state: pieces, then the arrow (until BDC7 erases it), then the box. Returns the visible 320 x 200 index window. */
export function composeIntro(pic, blits, ph, panX = 0) {
  const page = new Uint8Array(PAGE_W * PAGE_H);
  for (const b of blits.pieces) applyBlit(page, pic, b);
  applyBlit(page, pic, blits.arrow);
  if (!ph.arrow) for (const b of blits.erase) applyBlit(page, pic, b);
  applyBlit(page, pic, ph.box === 'on' ? blits.boxOn : blits.boxOff);
  return visibleWindow(page, panX);
}

// ---- the level dispatch: 1000:03FF .. 06C4, 07EB ----
/** The address of each dispatch target's `mov word [8C1B], <name>` (then `mov word [8C11], <bank id>`), `[STATIC]`. */
const MAP_TARGETS = { 0x5a9: 'w1 sub 1', 0x5b8: 'w1 sub 2', 0x5c7: 'w1 sub 3-6', 0x5d6: 'w2 sub 4-6', 0x5e5: 'w2 sub 1-3', 0x628: 'w3 sub 1-3', 0x637: 'w3 sub 4-7', 0x651: 'w3 sub 8', 0x687: 'w4 sub 1-4', 0x695: 'w4 sub 5-9' };

/** Which target the compare chain at 03FF..059E picks for `sub` (= [8C27], already incremented) in `world`, as a CS address or a symbolic result. */
export function dispatchTarget(world, sub) {
  const chain = {
    1: [[6, (s) => (s === 1 ? 0x5a9 : s === 2 ? 0x5b8 : 0x5c7)]],
    2: [[7, (s) => (s <= 3 ? 0x5e5 : s <= 6 ? 0x5d6 : 0x5f4)]],
    3: [[8, (s) => (s <= 3 ? 0x628 : s <= 7 ? 0x637 : 0x651)]],
    4: [[10, (s) => (s <= 4 ? 0x687 : s <= 9 ? 0x695 : 0x6e3)]],
  }[world];
  if (!chain) return 0x6a3; // other worlds (the demo's world 0): nothing is loaded
  if (sub <= 0) return 0x6a3; // JNG: stays on the current map
  if (sub > chain[0][0]) return 0x7eb; // past the last sub-level: the next world
  return chain[0][1](sub);
}

/**
 * 1000:03FF's decision for the level after `sub - 1`, with the file names read out of the shipped bytes.
 * @returns {{kind: 'map', map: string, script?: string, extraBank?: string, bankId: number} | {kind: 'nextWorld', world: number, hardMode: boolean} | {kind: 'ending', picture: string} | {kind: 'keep'}}
 */
export function levelDispatch(exe, world, sub) {
  const t = dispatchTarget(world, sub);
  if (t === 0x6a3) return { kind: 'keep' };
  if (t === 0x7eb) { // 07EB: [8C29] + 1 picks the loader of the next world; after world 4 the game starts over at world 1 with [8BA3] = 1
    return { kind: 'nextWorld', world: world >= 4 ? 1 : world + 1, hardMode: world >= 4 };
  }
  if (t === 0x6e3) return { kind: 'ending', picture: dsFileName(exe, code16(exe, 0x6ee)) }; // 06E3: endscrn.pip, then the ending entities
  // Each target is `mov word [8C1B], <name>` / `mov word [8C11], <bank id>` (C7 06 1B 8C xx xx; C7 06 11 8C yy yy), at these offsets from its start.
  const at = { 0x5f4: { name: 0x623, id: 0x61d }, 0x637: { name: 0x647, id: 0x64d }, 0x651: { name: 0x67d, id: 0x683 } }[t] || { name: t + 4, id: t + 10 };
  const r = { kind: 'map', map: dsFileName(exe, code16(exe, at.name)), bankId: code16(exe, at.id) };
  if (t === 0x5f4) r.extraBank = dsFileName(exe, code16(exe, 0x5fb)); // ape.pak (world 2's boss bank) is loaded first
  if (t === 0x637) r.script = dsFileName(exe, code16(exe, 0x638)); // level3b.pin into DS:0 before the map
  if (t === 0x651) r.script = dsFileName(exe, code16(exe, 0x66e)); // level3c.pin (the sea); the random add to [8B8B] at 0651 is undone by 06A3
  return r;
}

/** The world loaders' own files for sub-level 1 (B56B/B6F0/B8B7/BA3C): used for a new game and for the next world. */
export const WORLD_LOADER = { 1: 0xb56b, 2: 0xb6f0, 3: 0xb8b7, 4: 0xba3c };

// ---- the per-tick state machine ----
/**
 * A front-end state. `screen` is 'worldIntro' (then `boot` is emitted once) or 'play' (the engine runs; this module is idle).
 * @param {object} o `{ world, sub, panX, hold, reason }`
 */
export function startWorldIntro(o) {
  return { screen: 'worldIntro', world: o.world, sub: o.sub ?? 1, t: 0, panX: o.panX ?? 0, hold: o.hold ?? 0, reason: o.reason ?? 'newGame', hardMode: !!o.hardMode };
}

/** A fresh start: GAMEU's entry (CS:0010) loads world 1 sub-level 1 through B51E -> B56B, i.e. the world 1 intro screen, then the level; no key is read. */
export const newGame = (o = {}) => startWorldIntro({ world: 1, sub: 1, reason: 'newGame', ...o });

/**
 * One vsync. `input` (the key bytes) is accepted for symmetry with the engine and ignored: no loop of the intro reads a key.
 * @returns {{draw: object|null, boot: null | {world: number, sub: number, reason: string, hardMode: boolean}}}
 */
export function step(fs, timing, input = null, hold) {
  void input;
  if (fs.screen !== 'worldIntro') return { draw: null, boot: null };
  const ph = introPhase(timing, fs.t, hold ?? fs.hold);
  if (ph.done) { fs.screen = 'play'; return { draw: null, boot: { world: fs.world, sub: fs.sub, reason: fs.reason, hardMode: fs.hardMode } }; }
  fs.t += 1;
  return { draw: { picture: 'new.pip', world: fs.world, phase: ph.phase, bank: ph.bank, arrow: ph.arrow, box: ph.box, panX: fs.panX }, boot: null };
}
