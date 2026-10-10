// The pre-game screens that INTROU.EXE shows (the "RENEGADE / PRESENTS / A BITMAP BROTHERS GAME" captions, the four kid close-ups,
// the MAGIC POCKETS title with its twinkling stars, then LOADING) as a pure per-tick state machine, one tick = one vsync = 1/70 s.
//
// Source: INTROU.EXE (`game/INTROU.EXE`, the depacked INTRO.EXE), transliterated from its disassembly (`ndisasm -b 16`; the MZ header is 0x90
// bytes, so CS:xxxx = file 0x90 + xxxx and DS:0000 = file 0x90 + 0x2FD0, `mov ax,0x2fd` at CS:0017). Everything below is the video driver
// 'C' ("Colour VGA", pockets.ini line 2; EGA mode 0x0D) branch, `[2B2A]` = 0: the CGA/Tandy branches are not modelled.
//
// What the program is (docs/launcher.md "INTROU"):
//  * the six pictures data\intro0..5.pip are Degas PI1 files (2-byte resolution word, 16 big-endian ST palette words, 32000 bytes of
//    interleaved bit planes, 32 bytes of colour cycling): 320 x 200, but INTROU never uses the embedded palette. They are uploaded to
//    off-screen video RAM (slots [2C..36] = A400..AE00, `fa4`) and copied to the 352-pixel-wide page with latch copies (`13E5`).
//  * the colours come from a table of 16-word banks at DS:BC9E, 32 bytes per bank (`0571` copies bank AL to [8B2B] and applies it:
//    `1913` -> `1DD2` 'C' path, the same word -> DAC conversion as GAMEU's `decodeBank`). All the fading and twinkling is bank switching.
//  * every wait is `f57` (CS:0F57) or `0596`, and both IGNORE the AX the caller passes: they read the next word of a per-sound-driver
//    timing script at DS:[BAEF] (cursor start BAF3 for the Beeper 'B', BB45 'A', BBE9 'R', BB97 'S', BC3B 'T'; the exit path resets it to BAF1).
//    A wait of n is n vsyncs (`35E` counts [8A3A]) and polls the input byte [8BA1] after each one: any bound key aborts to `0F83`.
//
// Evidence tags follow CLAUDE.md. `[PROVEN]` = frame for frame against DOSBox video (tools/front-capture/import-intro.mjs, asserted by
// `npm run verify` group checkIntro); `[STATIC]` = read from the disassembly only.

'use strict';

import { decodeBank } from '../core/palette.js';

export const INTRO_DS = 0x90 + 0x2fd0; // file offset of INTROU.EXE's DS:0000
export const PAGE_STRIDE = 44, PAGE_W = PAGE_STRIDE * 8, PAGE_H = 200;
export const SCREEN_W = 320, SCREEN_H = 200;
export const PIC_W = 320, PIC_H = 200;
export const PALETTE_TABLE = 0xbc9e; // DS:BC9E, banks 0x00..0x3B are real colours (0x3C.. is CGA data)
export const TIMING_CURSOR = { B: 0xbaf3, A: 0xbb45, R: 0xbbe9, S: 0xbb97, T: 0xbc3b }; // `Snd_SelectDriverScriptTable` CS:0375
export const EXIT_CURSOR = 0xbaf1; // CS:0F98 / CS:021D reset the cursor here before the closing wait

const u16 = (exe, ds) => exe[INTRO_DS + ds] | (exe[INTRO_DS + ds + 1] << 8);

/** `[PROVEN]` (CS:0FA4 `fa4` EGA path, 1243): decode a .pip's 200 rows of interleaved planes (plane k = index bit k) into 320 x 200 palette indices. */
export function decodePip200(pip) {
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

/** The palette table as 16 RGB triples per bank, read from INTROU.EXE's data segment (`decodeBank`: word low byte = G<<4|B, high byte = R). */
export function bankRgb(exe, bank, patches = null) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 16; i++) {
    let w = u16(exe, PALETTE_TABLE + bank * 32 + i * 2);
    if (patches && patches[`${bank}:${i}`] !== undefined) w = patches[`${bank}:${i}`];
    bytes[i * 2] = w & 0xff; bytes[i * 2 + 1] = w >> 8;
  }
  return decodeBank(bytes);
}

/**
 * The picture blits of CS:08D8..0E59, EGA operands (the first `mov si/di` of each, the later ones are the CGA/Tandy branches).
 * `[STATIC]`: si = source byte offset in the slot (40-byte rows), di = destination byte offset on the page (44-byte rows), rows, words
 * (2 bytes = 16 pixels each); `slot` indexes intro0..5.
 */
export const BLITS = {
  loading: [{ slot: 5, si: 0x00, di: 0xf2c, rows: 0x10, words: 8 }], // 08D8 (also the exit screen)
  renegade: [{ slot: 5, si: 0x10, di: 0xf2c, rows: 0x10, words: 8 }], // 0914
  presents: [{ slot: 5, si: 0x280, di: 0xf2c, rows: 0x10, words: 8 }], // 0959
  bitmapBrothers: [ // 099B: three centred lines plus "GAME"
    { slot: 5, si: 0x20, di: 0xb10, rows: 0x10, words: 4 },
    { slot: 5, si: 0x290, di: 0xdce, rows: 0x10, words: 6 },
    { slot: 5, si: 0x500, di: 0x108c, rows: 0x10, words: 8 },
    { slot: 5, si: 0x2a0, di: 0x1350, rows: 0x10, words: 4 },
  ],
  title: [{ slot: 0, si: 0, di: 0, rows: 0xc0, words: 0x14 }], // 0AA0: the whole picture, 192 rows
};
/** The four close-up scenes (b53 slot 2, c5d slot 3, d5d slot 4, e5a slot 1): first-frame `di`, and the 5 frame offsets of CS:0AD0 (EGA branch). */
export const SCENES = {
  shoe: { slot: 2, di: 0x1094, first: 0 }, // 0B53
  belly: { slot: 3, di: 0xb08, first: 0 }, // 0C5D
  jacket: { slot: 4, di: 0x84e, first: 0 }, // 0D5D
  face: { slot: 1, di: 0x2ce, first: 0 }, // 0E5A
};
export const FRAME_SI = { c53: 0xf00, c55: 0xf0c, c57: 0xf18, c59: 0xc, c5b: 0x18 }; // CS:0AE7.. EGA branch (0B2F)

/** Apply one latch-copy blit to a 352 x 200 index page (source rows 40 bytes, destination rows 44, `words * 2` bytes of 8 pixels each). */
export function applyBlit(page, pic, b) {
  for (let r = 0; r < b.rows; r++) {
    for (let k = 0; k < b.words * 2; k++) {
      const sa = b.si + r * 40 + k, da = b.di + r * PAGE_STRIDE + k;
      const sy = Math.floor(sa / 40), sc = sa % 40, dy = Math.floor(da / PAGE_STRIDE), dc = da % PAGE_STRIDE;
      if (sy >= PIC_H || dy >= PAGE_H) continue;
      for (let p = 0; p < 8; p++) page[dy * PAGE_W + dc * 8 + p] = pic[sy * PIC_W + sc * 8 + p];
    }
  }
}

/** The visible 320 x 200 window (pan 0: `[8BAD]` is 0 in a fresh process). */
export function visible(page) {
  const out = new Uint8Array(SCREEN_W * SCREEN_H);
  for (let y = 0; y < SCREEN_H; y++) out.set(page.subarray(y * PAGE_W, y * PAGE_W + SCREEN_W), y * SCREEN_W);
  return out;
}

// ---- the script ----
class Abort { }

/**
 * Build a new intro state. `data = { exe, pics: [6 x 320x200 index images] }`; `opts.driver` is the sound-driver letter of pockets.ini line 1
 * (B = Beeper, the shipped default); `opts.hold` is the load-time stand-in described at `loadTicks`.
 */
export function createIntro(data, opts = {}) {
  const driver = opts.driver || 'B';
  if (!TIMING_CURSOR[driver]) throw new Error(`unknown sound driver ${driver}`);
  const s = {
    exe: data.exe, pics: data.pics, driver,
    page: new Uint8Array(PAGE_W * PAGE_H), bank: 0x1a, patches: {},
    cursor: TIMING_CURSOR[driver], consumed: 0,
    t: 0, done: false, exitCode: null, key: false, screenRev: 0,
    // `loadTicks`: INTROU spends a while on disk loads / depacking before its first wait while the screen is black (bank 0x1A);
    // that is disk time, not logic (`[PROVEN]` about 166 video frames in DOSBox). A stand-in, default 0.
    loadTicks: opts.hold ?? 0,
    log: opts.log || null,
  };
  s.gen = script(s);
  return s;
}

function* script(s) {
  const next = () => { const v = u16(s.exe, s.cursor); s.cursor += 2; s.consumed++; return v; }; // f57 / 0596: the caller's AX is dead
  const tick = function* (n) { for (let i = 0; i < n; i++) { s.t++; yield; } };
  const poll = () => { if (s.key) throw new Abort(); }; // 0F72: cmp byte [8BA1],0 / jnz 0F83
  const f57 = function* () { const n = next(); for (let i = 0; i < n; i++) { s.t++; yield; poll(); } }; // CS:0F57
  const setBank = (b) => { s.bank = b; s.screenRev++; }; // 0571 -> 1913
  const clear = () => { s.page.fill(0); s.screenRev++; }; // 04F6, EGA branch 054D
  const blits = (list) => { for (const b of list) applyBlit(s.page, s.pics[b.slot], b); s.screenRev++; };
  const up = function* (a, b) { for (let x = a; x <= b; x++) { setBank(x); yield* tick(2); } }; // 06A7: 2 vsyncs per bank
  const down = function* (a, b) { for (let x = a; x >= b; x--) { setBank(x); yield* tick(2); } }; // 07C8
  const bounce = function* () { // 064A: banks 0 -> 0x11 then 0x11 -> 7, 1 vsync each
    for (let x = 0; x <= 0x11; x++) { setBank(x); yield* tick(1); }
    for (let x = 0x11; x >= 7; x--) { setBank(x); yield* tick(1); }
  };
  const sixteenInvisible = function* () { yield* tick(16); }; // 086C edits [8B2B] only (never calls 0571/1913): 8 x 2 invisible vsyncs
  const frames = (scene, extra) => { // 0B53/0C5D/0D5D/0E5A: draw frame 0, fade the bank up, then the five frame offsets (c59 c5b c53 c55 c57)
    const sc = SCENES[scene];
    return function* () {
      blits([{ slot: sc.slot, si: 0, di: sc.di, rows: 0x60, words: 6 }]);
      yield* up(0, 7);
      yield* f57();
      for (const k of ['c59', 'c5b', 'c53', 'c55', 'c57']) {
        blits([{ slot: sc.slot, si: FRAME_SI[k], di: sc.di, rows: 0x60, words: 6 }]);
        yield* f57();
      }
    }();
  };

  // ---- entry (CS:01B5): mode 0x0D, page flip, bank 0x1A (all black), the "Loading, please wait." text is drawn invisibly ----
  setBank(0x1a);
  yield* tick(s.loadTicks);
  try {
    yield* f57(); // 01E6: the first script word (448 for the Beeper): a black screen
    yield* sequence();
    yield* f57(); // 01EF
    yield* down(0x2e, 0x27);
    s.patches['6:15'] = 0x100; s.patches['7:15'] = 0x200;
    yield* sixteenInvisible();
    clear(); blits(BLITS.loading); yield* bounce();
    s.cursor = EXIT_CURSOR; yield* f57(); // 021D
    s.exitCode = 2;
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
    // 0F83: a bound key was down during a wait. Re-draws the LOADING caption and waits (the first script word) again; a key still
    // down at the next poll restarts it (the original recurses), otherwise INT 21h AH=4Ch AL=3.
    for (;;) {
      try {
        s.patches['6:15'] = 0x100; s.patches['7:15'] = 0x200;
        clear(); blits(BLITS.loading); yield* bounce();
        s.cursor = EXIT_CURSOR; yield* f57();
        break;
      } catch (e2) { if (!(e2 instanceof Abort)) throw e2; }
    }
    s.exitCode = 3;
  }
  yield* tick(1); // 0182 / 218A: `call 35E` in the shutdown
  s.done = true;

  // ---- CS:0229 ----
  function* sequence() {
    s.patches['6:15'] = 0x100; s.patches['7:15'] = 0x200;
    for (const [caption, scene] of [['renegade'], ['presents'], ['bitmapBrothers']]) {
      void scene;
      clear(); blits(BLITS[caption]); yield* bounce(); yield* f57(); yield* down(7, 0);
      if (caption !== 'bitmapBrothers') yield* f57(); // the black pause after "RENEGADE" and "PRESENTS" (0245..0278)
    }
    s.patches['7:15'] = 0; s.patches['6:15'] = 0; // 0290: [BD9C] = [BD7C] = 0 (the table holds 0x100 / 0x200 there)
    yield* f57(); // 029C
    for (const name of ['shoe', 'belly', 'jacket', 'face']) {
      clear();
      yield* frames(name);
      if (name === 'face') yield* f57(); // 02F9
      else yield* f57();
      yield* down(7, 0);
      if (name !== 'face') yield* f57();
    }
    // 0308: the title picture
    clear(); blits(BLITS.title);
    yield* up(0x27, 0x36);
    yield* down(0x36, 0x2e);
    yield* up(0x37, 0x3b);
    // 0596: the star twinkle, banks 0x22..0x26 for 5 vsyncs each, (script word - 1) steps
    {
      const a = next(); let b = 0x22;
      for (let k = 0; k < a - 1; k++) { setBank(b); for (let i = 0; i < 5; i++) { s.t++; yield; } b++; if (b === 0x27) b = 0x22; }
    }
    yield* up(0x2e, 0x36);
    yield* down(0x36, 0x2e);
  }
}

/** One vsync. `input.key` (any bound key: arrows, fire) aborts the intro at its next wait poll. Returns the frame to show. */
export function step(s, input = null) {
  s.key = !!(input && input.key);
  if (s.done) return { done: true, exitCode: s.exitCode, draw: null };
  const r = s.gen.next();
  if (s.done || r.done) { s.done = true; return { done: true, exitCode: s.exitCode, draw: null }; }
  return { done: false, exitCode: null, draw: { bank: s.bank, patches: s.patches, rev: s.screenRev } };
}

/** The visible 320 x 200 indices and 16 RGB colours for a state (call after `step`). */
export function frameOf(s) {
  return { indices: visible(s.page), palette: bankRgb(s.exe, s.bank, s.patches) };
}

/** RGB bytes (320 x 200 x 3) of the current frame. */
export function frameRgbBytes(s) {
  const f = frameOf(s), out = new Uint8Array(SCREEN_W * SCREEN_H * 3);
  for (let i = 0; i < SCREEN_W * SCREEN_H; i++) { const c = f.palette[f.indices[i]]; out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2]; }
  return out;
}
