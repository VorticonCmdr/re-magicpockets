// Phase 2 checkpoint: core loop skeleton + camera + input. Pick a folder containing the original
// (still RNC-compressed) game data files; the page builds the full level scene once (same as
// Phase 1) and then drives a requestAnimationFrame loop that reads keyboard input and scrolls a
// viewport-sized camera smoothly over it, matching the original's 32px-tile/16px-tile split-scroll
// decomposition (displayed live) even though the crop itself needs no pixel-panning-register
// emulation. See docs/port-plan.md Phase 2.

'use strict';

import { sourceFromFileList, sourceFromFetch } from './loader/asset-source.js';
import { AssetCache } from './loader/asset-cache.js';
import { WORLD_PALETTES } from './core/palette.js';
import { buildLevelScene } from './render/canvas.js';
import { Camera } from './engine/camera.js';
import { Input } from './engine/input.js';
import { MainLoop } from './engine/loop.js';

// Per docs/formats/pin-level-script.md, world 1's level-script file is oddly named new1.pin.
const LEVEL = { pap: 'level1a.pap', pak: 'blocks1.pak', pin: 'new1.pin', palette: 'world1', world: 1 };
const SHAPES_URL = '/symbols/entity-shapes.json';
const VIEWPORT_W = 320;
const VIEWPORT_H = 192;
const EXTRA_SPRITE_FILES = ['bitkid.pak', 'kidx1.pak', 'special1.pak', 'extras.pak', 'extrax1.pak', 'nasty1.pak'];

const statusEl = document.getElementById('status');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const picker = document.getElementById('picker');
const devServerBtn = document.getElementById('dev-server');

canvas.width = VIEWPORT_W;
canvas.height = VIEWPORT_H;
ctx.imageSmoothingEnabled = false;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

function loadEntityShapes() {
  return fetch(SHAPES_URL).then((res) => {
    if (!res.ok) throw new Error(`fetch ${SHAPES_URL} failed: ${res.status}`);
    return res.json();
  });
}

let activeLoop = null;
let activeInput = null;

async function run(cache) {
  const required = [LEVEL.pak, LEVEL.pap, LEVEL.pin];
  for (const f of required) {
    if (!cache.has(f)) {
      setStatus(`missing required file: ${f} (looked for it, case-insensitive, among the picked files)`, true);
      return;
    }
  }

  if (activeLoop) activeLoop.stop();
  if (activeInput) activeInput.dispose();

  try {
    setStatus(`depacking + decoding ${LEVEL.pak}, ${LEVEL.pap}, ${LEVEL.pin}...`);
    const level = { ...LEVEL, paletteColors: WORLD_PALETTES[LEVEL.palette] };
    const entityShapes = await loadEntityShapes();
    const scene = await buildLevelScene(cache, level, entityShapes);

    const camera = new Camera({
      levelWidthPx: scene.widthPx,
      levelHeightPx: scene.heightPx,
      viewportWidthPx: VIEWPORT_W,
      viewportHeightPx: VIEWPORT_H,
    });
    const input = new Input(window);
    activeInput = input;

    const loop = new MainLoop({
      cameraUpdateScroll: (dt) => camera.update(dt, input),
      videoFlipAndScroll: () => {
        ctx.clearRect(0, 0, VIEWPORT_W, VIEWPORT_H);
        ctx.drawImage(
          scene.canvas,
          camera.x, camera.y, VIEWPORT_W, VIEWPORT_H,
          0, 0, VIEWPORT_W, VIEWPORT_H
        );
      },
      hudUpdateScoreDisplay: () => {
        const s = camera.split;
        setStatus(
          `${LEVEL.pap} live: frame ${loop.frameCount}, camera (${camera.x.toFixed(1)}, ` +
            `${camera.y.toFixed(1)})px -- tile (${s.tileCol},${s.tileRow}) + sub-tile remainder ` +
            `(${s.subX.toFixed(1)}, ${s.subY.toFixed(1)})px -- arrow keys/WASD to scroll -- ` +
            `${scene.entityStats.drawn} entities baked into the scene ` +
            `(${scene.entityStats.sprited} real sprites, ` +
            `${scene.entityStats.drawn - scene.entityStats.sprited} dots).`
        );
      },
    });
    activeLoop = loop;
    loop.start();
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
    throw err;
  }
}

picker.addEventListener('change', () => {
  const source = sourceFromFileList(picker.files);
  run(new AssetCache(source));
});

// Convenience for local dev: assumes `node tools/serve.js` is running and data/ is reachable at
// /data/ (serve.js serves the whole repo root, and data/ exists on disk even though it's
// gitignored -- this path only works for someone who already has the original files locally).
devServerBtn.addEventListener('click', () => {
  const allFiles = [LEVEL.pak, LEVEL.pap, LEVEL.pin, ...EXTRA_SPRITE_FILES];
  const source = sourceFromFetch('/data', allFiles);
  run(new AssetCache(source));
});
