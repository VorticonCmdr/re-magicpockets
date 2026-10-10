// import-prelude.mjs: turns one DOSBox video of `POCKETS` (typed at the C:\> prompt: pockets.com -> pockets.exe -> klogopok.exe, intro.exe, game.exe)
// into the committed reference `prelude.capture.json.gz` that `npm run verify` (group checkPrelude) compares web/engine/klogo.js and
// web/engine/intro.js against. How the footage is made (docs/dosbox-debugging.md "Front-end captures"): bridge_start, drive_mount C:
// build/dosbox-c, `video_capture_start`, input_type 'P' then 'OCKETS\n', wait until GAME is running (dos_memory_map), `video_capture_stop`;
//   ffmpeg -i video.avi -pix_fmt rgb24 -f rawvideo video.rgb        (320 x 200, ~70 frames/s)
//   node tools/front-capture/import-prelude.mjs prelude.capture.json.gz video.rgb
// Nothing is derived from the port's own output except the SEARCH for each frame's palette step; the stored values are video hashes.
//
// KLOGO: its palette updates come from a 50 Hz timer interrupt, not the vsync, so frames are TORN: rows above the beam's position still show the
// previous step's palette. Each video frame is therefore stored as (a, r, h): rows < r use palette state a, rows >= r use state a + 1, and h is the
// hash of the whole video frame. INTROU waits on the vsync and has no tearing: its screens are stored as runs (hash, video frames).
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { rncUnpack } from '../../web/core/rnc.js';
import * as K from '../../web/engine/klogo.js';
import { fnv64 } from '../../web/core/hash.js';

const [out, file, klogoFrames = '440'] = process.argv.slice(2);
const W = 320, H = 200, FS = W * H * 3;
const vid = readFileSync(file);
const nFrames = Math.floor(vid.length / FS);

const frameHash = (f) => fnv64(vid, f * FS, FS);

// ---- KLOGO ----
const exeK = new Uint8Array(readFileSync(new URL('../../game/KLOGOPOU.EXE', import.meta.url)));
const logo = K.loadLogo(exeK);
const states = K.distinctStates(logo, 5); // 0 black, 1..32 fade in (the hold repeats 32), 33..64 fade out
// For each video frame: the palette state `a` (the older one) and, for each of the 16 colours, the first row `t[k]` at which colour k already shows state a + 1
// (rows above show state a). A torn frame has different t[k]: the timer interrupt writes the 16 DAC registers one after another while the beam is drawing.
const dacRgb = (c) => [K.dacTo8(c[0]), K.dacTo8(c[1]), K.dacTo8(c[2])];
const same = (x, y) => x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
const rowsOf = Array.from({ length: 16 }, () => []); // [y, x of the first pixel of that index in the row]
for (let y = 0; y < H; y++) { const seen = new Set(); for (let x = 0; x < W; x++) { const k = logo.pixels[y * W + x]; if (!seen.has(k)) { seen.add(k); rowsOf[k].push([y, x]); } } }
const klogo = [];
let a = 0;
const analyse = (f, cand) => {
  const t = [];
  for (let k = 0; k < 16; k++) {
    const old = dacRgb(states[cand][k]), nw = dacRgb(states[cand + 1][k]);
    let lastOld = -1, firstNew = H;
    for (const [y, x] of rowsOf[k]) {
      const o = f * FS + (y * W + x) * 3, v = [vid[o], vid[o + 1], vid[o + 2]];
      const isOld = same(v, old), isNew = same(v, nw);
      if (!isOld && !isNew) return null;
      if (isOld && !isNew) { if (y > lastOld) lastOld = y; if (firstNew < lastOld) return null; }
      if (isNew && !isOld) { if (y < firstNew) firstNew = y; if (firstNew < lastOld) return null; }
    }
    t.push(lastOld + 1);
  }
  return t;
};
for (let f = 0; f < +klogoFrames; f++) {
  let found = null;
  for (let cand = Math.max(0, a - 1); cand < Math.min(states.length - 1, a + 4) && !found; cand++) { const t = analyse(f, cand); if (t) found = [cand, t]; }
  if (!found) throw new Error(`KLOGO frame ${f} matches no two adjacent palette states near state ${a}`);
  a = found[0];
  klogo.push([found[0], found[1].every((v) => v === found[1][0]) ? found[1][0] : found[1], frameHash(f)]);
}
// ---- INTROU ----
// the video after the KLOGO fade-out: black, then the first screen change; the intro ends where the next program (GAME) starts
let start = +klogoFrames;
const isBlack = (f) => { for (let i = 0; i < FS; i++) if (vid[f * FS + i]) return false; return true; };
while (isBlack(start)) start++;
const loadFrames = start - +klogoFrames; // black frames between the KLOGO fade-out and the first intro screen
const runs = [];
let prev = null;
for (let f = start; f < nFrames; f++) {
  const h = frameHash(f);
  if (h !== prev) { runs.push([h, 1]); prev = h; } else runs[runs.length - 1][1]++;
}
// the last run (the screen GAME shows while it loads) and the one before it (INTROU's LOADING hold) are kept; the final black tail is dropped
writeFileSync(out, gzipSync(JSON.stringify({
  note: 'DOSBox video of POCKETS (klogopok.exe /m1 /t5 0, intro.exe, game.exe); see import-prelude.mjs. Frame hash = fnv64 over the 320x200 RGB bytes.',
  klogo: { frames: klogo, steps: states.length - 1 },
  intro: { blackBeforeFirstScreen: loadFrames, runs },
})));
console.log(`klogo ${klogo.length} frames, ${states.length - 1} steps; intro starts at video frame ${start} (${loadFrames} black frames), ${runs.length} runs`);
