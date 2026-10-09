// Plays the attract demo through the ported engine (web/engine/iteration.js), in the browser.
// The game's own files are loaded at runtime from /game/GAMEU.EXE (or a picked file) and /data/;
// nothing from them is bundled. The engine state is seeded from the first captured demo row
// (tools/attract-capture/entities-full.capture.json.gz) because booting a level from the files alone
// is not parity-checked yet (docs/open-questions-history.md item 21).

'use strict';

import { AssetCache } from '../loader/asset-cache.js';
import { sourceFromFetch } from '../loader/asset-source.js';
import { WORLD_PALETTES } from '../core/palette.js';
import { buildBackgroundCanvas } from '../render/canvas.js';
import { prepare, loadRow, expandRows } from '../verify/conformance-lib.js';
import { stepIteration } from '../engine/iteration.js';
import { Clock } from '../engine/clock.js';
import { findByClass } from '../engine/ds-memory.js';

const VIEW_W = 320, VIEW_H = 192;
const statusEl = document.getElementById('status');
const canvas = document.getElementById('view');
const ctx2d = canvas.getContext('2d');
ctx2d.imageSmoothingEnabled = false;
const setStatus = (msg, err = false) => { statusEl.textContent = msg; statusEl.className = err ? 'error' : ''; };

const fetchBytes = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

async function loadExe() {
  try { return await fetchBytes('/game/GAMEU.EXE'); } catch { /* fall through to the picker */ }
  const input = document.getElementById('exe');
  setStatus('GAMEU.EXE is not served from /game/: pick it with the file chooser.');
  return new Promise((resolve) => input.addEventListener('change', async () => resolve(new Uint8Array(await input.files[0].arrayBuffer())), { once: true }));
}

async function loadCapture() {
  const res = await fetch('/tools/attract-capture/entities-full.capture.json.gz');
  if (!res.ok) throw new Error(`capture: ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  // Some servers add Content-Encoding: gzip, in which case the browser has already inflated it.
  const text = raw[0] === 0x1f && raw[1] === 0x8b
    ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(raw);
  return expandRows(JSON.parse(text).rows.slice(0, 1));
}

const hue = (cls) => `hsl(${(cls * 47) % 360} 80% 60%)`;

async function main() {
  const [exe, tape, pap, rows] = await Promise.all([loadExe(), fetchBytes('/data/autoplay.pin'), fetchBytes('/data/pcmap.pap'), loadCapture()]);
  const cache = new AssetCache(sourceFromFetch('/data', ['blocks1.pak', 'pcmap.pap']));
  const [pak, papDecoded] = await Promise.all([cache.getPak('blocks1.pak', WORLD_PALETTES.world1), cache.getPap('pcmap.pap')]);
  const background = buildBackgroundCanvas(pak, papDecoded);
  const env = prepare(exe, tape, pap);
  let m, ticks, step;
  const sim = { unported: new Set(), events: [] };
  const restart = () => { m = loadRow(env, rows[0]); ticks = 0; };
  restart();
  step = () => { stepIteration(m, sim, null); ticks++; };

  const s16 = (o) => m.s16(o);
  const draw = () => {
    // The world entity (class 1) carries the scroll: a map pixel (mx, my) appears at screen (mx + e0x, my + e0y),
    // and every other entity's x/y is already in screen space (docs/open-questions-history.md item 18).
    const camX = s16(0x8bbb), camY = s16(0x8bbd);
    const world = findByClass(m, 1);
    const ox = s16(world + 6), oy = s16(world + 8);
    ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx2d.drawImage(background, ox, oy);
    for (let a = 0x9090; a < 0x91a8; a += 2) {
      const p = m.u16(a);
      if (p === 0 || p === 0xffff) continue;
      const cls = m.u16(p + 2);
      if (cls === 0) continue;
      const x = s16(p + 6), y = s16(p + 8);
      if (x < -16 || x > VIEW_W + 16 || y < -16 || y > VIEW_H + 16) continue;
      ctx2d.strokeStyle = hue(cls);
      ctx2d.strokeRect(x - 8, y - 8, 16, 16);
    }
    setStatus(`iteration ${ticks}  score ${m.u16(0x8b75)}  cam (${camX}, ${camY})  unported: ${[...sim.unported].join(', ') || 'none'}`);
  };
  const clock = new Clock(step, { onRender: draw });
  document.getElementById('pause').addEventListener('click', () => { if (clock.running) clock.stop(); else clock.start(); });
  document.getElementById('restart').addEventListener('click', () => { restart(); sim.unported.clear(); draw(); });
  window.__mpDemo = { m: () => m, step, draw, clock };
  draw();
  clock.start();
}

main().catch((err) => { setStatus(`error: ${err.message}`, true); throw err; });
