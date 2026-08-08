// Phase 0 checkpoint: pick a folder containing the original (still RNC-compressed) game data
// files, RNC-depack + decode a level's tile bank and tile-map entirely in-browser, and draw it to
// a <canvas>. No pre-extraction step, no build/ artifacts -- see docs/port-plan.md Phase 0.

'use strict';

import { sourceFromFileList, sourceFromFetch } from './loader/asset-source.js';
import { AssetCache } from './loader/asset-cache.js';
import { WORLD_PALETTES } from './core/palette.js';
import { GRID_SIZE } from './core/pap.js';

const REQUIRED_FILES = ['blocks1.pak', 'level1a.pap'];

const statusEl = document.getElementById('status');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const picker = document.getElementById('picker');
const devServerBtn = document.getElementById('dev-server');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

async function renderLevel(cache, papFile, pakFile, paletteName) {
  setStatus(`depacking + decoding ${pakFile} and ${papFile}...`);
  const palette = WORLD_PALETTES[paletteName];
  const [pak, pap] = await Promise.all([cache.getPak(pakFile, palette), cache.getPap(papFile)]);

  const tw = pak.tileWidth;
  const th = pak.tileHeight;
  canvas.width = GRID_SIZE * tw;
  canvas.height = GRID_SIZE * th;

  const imageData = ctx.createImageData(canvas.width, canvas.height);
  const dest = imageData.data;
  const destStride = canvas.width * 4;

  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const value = pap.grid[row * GRID_SIZE + col];
      if (value === 0 || value > pak.tileCount) continue; // empty / out of range
      const tile = pak.tiles[value - 1]; // 1-based on disk
      const destX = col * tw;
      const destY = row * th;
      for (let y = 0; y < th; y++) {
        const srcOff = y * tw * 4;
        const destOff = (destY + y) * destStride + destX * 4;
        dest.set(tile.subarray(srcOff, srcOff + tw * 4), destOff);
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
  setStatus(
    `${papFile}: 128x128 grid, ${pak.tileCount} tiles in ${pakFile} (${pak.format}, ` +
      `${tw}x${th}px) -- rendered ${canvas.width}x${canvas.height}, decoded entirely in-browser ` +
      `from the original RNC-compressed files, no build/ step.`
  );
}

async function run(cache) {
  for (const f of REQUIRED_FILES) {
    if (!cache.has(f)) {
      setStatus(`missing required file: ${f} (looked for it, case-insensitive, among the picked files)`, true);
      return;
    }
  }
  try {
    await renderLevel(cache, 'level1a.pap', 'blocks1.pak', 'world1');
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
  const source = sourceFromFetch('/data', REQUIRED_FILES);
  run(new AssetCache(source));
});
