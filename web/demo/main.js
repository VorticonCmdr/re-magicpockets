// Plays the attract demo through the ported engine (web/engine/iteration.js), in the browser.
// The game's own files are loaded at runtime from /game/GAMEU.EXE (or a picked file) and /data/;
// nothing from them is bundled. The level is booted from the files alone (web/engine/boot.js), which
// `npm run verify` checks against the first captured demo row and a free run of the whole demo.

'use strict';

import { AssetCache } from '../loader/asset-cache.js';
import { sourceFromFetch } from '../loader/asset-source.js';
import { WORLD_PALETTES } from '../core/palette.js';
import { buildBackgroundCanvas } from '../render/canvas.js';
import { prepare, bootFromFiles } from '../verify/conformance-lib.js';
import { startLevel } from '../engine/boot.js';
import { rncUnpack } from '../core/rnc.js';
import { stepIteration } from '../engine/iteration.js';
import { Clock } from '../engine/clock.js';
import { INPUT_BITS } from '../core/demo-tape.js';
import { findByClass } from '../engine/ds-memory.js';
import { buildSpriteAtlas, drawEntities, BANKS } from '../render/sprites.js';

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

const hue = (cls) => `hsl(${(cls * 47) % 360} 80% 60%)`;

async function main() {
  // ?game: the whole game flow (world intro screens, level and world progression) instead of booting a level directly; see web/demo/game.js.
  if (new URLSearchParams(location.search).has('game')) {
    const { startGame } = await import('./game.js');
    document.querySelectorAll('#play, #pause, #restart').forEach((b) => { b.style.display = 'none'; });
    return startGame({ exe: await loadExe(), fetchBytes, canvas, setStatus });
  }
  const [exe, tape, pap, script, world1Script] = await Promise.all([loadExe(), fetchBytes('/data/autoplay.pin'), fetchBytes('/data/pcmap.pap'), fetchBytes('/data/level0.pin'), fetchBytes('/data/new1.pin')]);
  const cache = new AssetCache(sourceFromFetch('/data', ['blocks1.pak', 'pcmap.pap']));
  const [pak, papDecoded] = await Promise.all([cache.getPak('blocks1.pak', WORLD_PALETTES.world1), cache.getPap('pcmap.pap')]);
  const background = buildBackgroundCanvas(pak, papDecoded);
  // Sprite banks (world 1 files; the same bank layout holds for worlds 2-4, see web/render/sprites.js).
  // ?boxes keeps the old coloured boxes instead of the sprites.
  const boxes = new URLSearchParams(location.search).has('boxes');
  const spriteRaw = {};
  await Promise.all([...new Set(Object.values(BANKS).flatMap((b) => b.files))].map(async (f) => {
    const name = f.replace('%', 1);
    spriteRaw[name] = rncUnpack(await fetchBytes(`/data/${name}`)).data;
  }));
  const atlas = buildSpriteAtlas(spriteRaw, 1, WORLD_PALETTES.world1, (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const env = prepare(exe, tape, pap);
  let playing = new URLSearchParams(location.search).has('play');
  let m, ticks, step;
  const sim = { unported: new Set(), events: [] };
  const demoScript = rncUnpack(script).data, world1 = rncUnpack(world1Script).data;
  // Watching boots the attract demo's level (level0.pin + the tape); playing boots world 1, level 1 as the
  // game's own start does (new1.pin). Both use pcmap.pap and are parity-checked in `npm run verify`.
  const restart = () => { m = (playing ? bootFromFiles(env, world1, { world: 1, sub: 1, demo: false }) : bootFromFiles(env, demoScript)).m; ticks = 0; };
  restart();
  // ?play (or the button): the keyboard replaces the demo tape. Call #7 then just copies the key
  // bytes [8B5D]/[8B58] (what the original's keyboard ISR writes) into the input words.
  const held = new Set();
  const KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'fire', ControlLeft: 'fire', KeyZ: 'fire' };
  addEventListener('keydown', (e) => { if (KEYS[e.code]) { held.add(KEYS[e.code]); e.preventDefault(); } });
  addEventListener('keyup', (e) => { if (KEYS[e.code]) held.delete(KEYS[e.code]); });
  const keyState = () => [...held].reduce((v, k) => v | INPUT_BITS[k], 0);
  step = () => {
    if (playing) { m.w8(0x8b5d, keyState()); m.w8(0x8b58, keyState()); }
    stepIteration(m, sim, null); ticks++;
    if (sim.levelStart) { // opcode 37: the player continued after dying; the level loads again
      m.put(0x4200, env.map);
      const next = sim.levelStart; sim.levelStart = null;
      startLevel(m, sim, next);
    }
    if (sim.gameRestart === 'demo') { sim.gameRestart = null; playing = false; restart(); document.getElementById('play').textContent = 'play'; } // CONTINUE? timed out
  };

  const s16 = (o) => m.s16(o);
  const draw = () => {
    // The world entity (class 1) carries the scroll: a map pixel (mx, my) appears at screen (mx + e0x, my + e0y),
    // and every other entity's x/y is already in screen space (docs/open-questions-history.md item 18).
    const camX = s16(0x8bbb), camY = s16(0x8bbd);
    const world = findByClass(m, 1);
    const ox = s16(world + 6), oy = s16(world + 8);
    ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx2d.drawImage(background, ox, oy);
    let spriteInfo = '';
    if (!boxes) { const r = drawEntities(ctx2d, m, atlas); spriteInfo = `  sprites ${r.drawn}${r.missing.length ? ` (${r.missing.length} unresolved)` : ''}`; }
    for (let a = 0x9090; boxes && a < 0x91a8; a += 2) {
      const p = m.u16(a);
      if (p === 0 || p === 0xffff) continue;
      const cls = m.u16(p + 2);
      if (cls === 0) continue;
      const x = s16(p + 6), y = s16(p + 8);
      if (x < -16 || x > VIEW_W + 16 || y < -16 || y > VIEW_H + 16) continue;
      ctx2d.strokeStyle = hue(cls);
      ctx2d.strokeRect(x - 8, y - 8, 16, 16);
    }
    setStatus(`iteration ${ticks}  score ${m.u16(0x8b75)}  cam (${camX}, ${camY})  unported: ${[...sim.unported].join(', ') || 'none'}${spriteInfo}`);
  };
  if (playing) document.getElementById('play').textContent = 'watch demo';
  const clock = new Clock(step, { onRender: draw });
  document.getElementById('play').addEventListener('click', () => { playing = !playing; restart(); document.getElementById('play').textContent = playing ? 'watch demo' : 'play'; });
  document.getElementById('pause').addEventListener('click', () => { if (clock.running) clock.stop(); else clock.start(); });
  document.getElementById('restart').addEventListener('click', () => { restart(); sim.unported.clear(); draw(); });
  window.__mpDemo = { m: () => m, step, draw, clock };
  draw();
  clock.start();
}

main().catch((err) => { setStatus(`error: ${err.message}`, true); throw err; });
