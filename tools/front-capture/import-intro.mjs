// import-intro.mjs: turns DOSBox video captures of the world intro screen into the committed reference
// `intro.capture.json.gz` that `npm run verify` compares the port against.
//
// How the footage is made (docs/dosbox-debugging.md "Front-end captures"): `video_capture_start`, then either start GAMEU
// from the DOS prompt (a fresh start shows the world 1 intro) or warp with F2 + a level code (world 2: 6245, 3: 3505, 4: 8498,
// 1: 1053), `video_capture_stop`; the AVI is unpacked with
//   ffmpeg -i video.avi -pix_fmt rgb24 -f rawvideo video.rgb        (320 x 200, one frame per DOSBox video frame, ~70 fps)
// and this tool is run once per intro in it:
//   node tools/front-capture/import-intro.mjs out.json.gz video.rgb <world> <panX> <firstFrame> <lastFrame> <label[@8B69]> [more of the same...]
// (`@N` records the value of the scroll remainder word [8B69] read from DOSBox while that intro ran; `?` = not read)
// It records, per intro: the frame numbers at which the picture changed (the fade steps and the box blinks), and three
// whole frames as palette INDICES (the video's RGB mapped back through the fade bank 0x1D read from GAMEU.EXE, which also checks
// the palette: an unmapped colour aborts). Index images, not RGB, so DOSBox's DAC rounding is not part of the comparison.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { bankPalette } from '../../web/engine/frontend.js';

const args = process.argv.slice(2);
const out = args.shift();
const exe = new Uint8Array(readFileSync(new URL('../../game/GAMEU.EXE', import.meta.url)));
const pal = bankPalette(exe, 0x1d);
const W = 320, H = 200, FS = W * H * 3;
const key = (c) => c.join(',');
const inv = new Map(pal.map((c, i) => [key(c), i]));
if (inv.size !== 16) throw new Error('bank 0x1D has duplicate colours: cannot map back');

const caps = [];
while (args.length >= 6) {
  const [file, world, panX, a, b, labelArg] = args.splice(0, 6);
  const [label, scroll] = labelArg.split('@');
  const vid = readFileSync(file);
  const stat = (f) => { let nz = 0, sum = 0; const o = f * FS; for (let i = 0; i < FS; i += 3) { const v = vid[o + i] + vid[o + i + 1] + vid[o + i + 2]; if (v) nz++; sum += v; } return `${nz}:${sum}`; };
  const changes = [];
  let prev = stat(+a);
  for (let f = +a + 1; f <= +b; f++) { const s = stat(f); if (s !== prev) changes.push(f); prev = s; }
  // runs of changes: split where the gap exceeds 3 frames
  const runs = [];
  for (const f of changes) { const r = runs[runs.length - 1]; if (r && f - r[r.length - 1] <= 3) r.push(f); else runs.push([f]); }
  // the fade-in run starts at the first change from black; the blink run is the one with 10..12-frame gaps; the fade-out run ends in black
  const gaps = (r) => r.slice(1).map((f, i) => f - r[i]);
  const blink = changes.filter((_, i) => i > 0 && (changes[i] - changes[i - 1] >= 10 && changes[i] - changes[i - 1] <= 12) || (i + 1 < changes.length && changes[i + 1] - changes[i] >= 10 && changes[i + 1] - changes[i] <= 12));
  const fadeIn = runs[0];
  const fadeOut = runs[runs.length - 1];
  const toIdx = (f) => {
    const img = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const o = f * FS + p * 3;
      const i = inv.get(key([vid[o], vid[o + 1], vid[o + 2]]));
      if (i === undefined) throw new Error(`frame ${f}: colour ${vid[o]},${vid[o + 1]},${vid[o + 2]} is not in bank 0x1D`);
      img[p] = i;
    }
    return Buffer.from(img).toString('base64');
  };
  caps.push({
    world: +world, panX: +panX, label, scroll8b69: scroll === undefined || scroll === '?' ? null : +scroll,
    changes, fadeIn, blink, fadeOut, fadeInStats: fadeIn.map(stat), fadeOutStats: fadeOut.map(stat), // 'non-black pixels:sum of r+g+b' per fade step
    gapsFadeIn: gaps(fadeIn), gapsBlink: gaps(blink), gapsFadeOut: gaps(fadeOut),
    images: { full: toIdx(fadeIn[fadeIn.length - 1] + 12), erasedOn: toIdx(blink[0] + 4), off: toIdx(blink[1] + 4) },
  });
  console.log(`world ${world} pan ${panX}: fadeIn ${fadeIn.join(',')} | blink ${blink.join(',')} | fadeOut ${fadeOut.join(',')}`);
}
writeFileSync(out, gzipSync(JSON.stringify({ note: 'DOSBox video captures of the world intro screen; see import-intro.mjs', palette: 'fade bank 0x1D', captures: caps })));
