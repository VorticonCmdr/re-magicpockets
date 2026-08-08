// Phase 1 checkpoint: pick a folder containing the original (still RNC-compressed) game data
// files, and render a full level -- background tiles (.pak via .pap) plus every placed entity's
// real sprite where resolvable, colored dots otherwise -- entirely in-browser, no pre-extraction
// step. See docs/port-plan.md Phase 1.

'use strict';

import { sourceFromFileList, sourceFromFetch } from './loader/asset-source.js';
import { AssetCache } from './loader/asset-cache.js';
import { WORLD_PALETTES } from './core/palette.js';
import { GRID_SIZE } from './core/pap.js';
import { resolveEntitySprite, paksNeededForWorld } from './core/shapes.js';

// One world's worth of level data for the checkpoint. Per docs/formats/pin-level-script.md,
// world 1's level-script file is oddly named new1.pin (not level1.pin).
const LEVEL = { pap: 'level1a.pap', pak: 'blocks1.pak', pin: 'new1.pin', palette: 'world1', world: 1 };
const SHAPES_URL = '/symbols/entity-shapes.json';

const statusEl = document.getElementById('status');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const picker = document.getElementById('picker');
const devServerBtn = document.getElementById('dev-server');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

let entityShapesPromise = null;
function loadEntityShapes() {
  if (!entityShapesPromise) {
    entityShapesPromise = fetch(SHAPES_URL).then((res) => {
      if (!res.ok) throw new Error(`fetch ${SHAPES_URL} failed: ${res.status}`);
      return res.json();
    });
  }
  return entityShapesPromise;
}

// Cache of decoded-tile-RGBA -> offscreen <canvas>, so masked sprites can be alpha-composited
// onto the main canvas via drawImage (putImageData ignores destination alpha and would just
// stamp transparent pixels as black, which is wrong for masked sprites).
const tileCanvasCache = new WeakMap();
function tileToCanvas(rgba, w, h) {
  let c = tileCanvasCache.get(rgba);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  tileCanvasCache.set(rgba, c);
  return c;
}

function colorForType(type) {
  const hue = (type * 47) % 360;
  return `hsl(${hue}, 85%, 60%)`;
}

async function renderLevel(cache) {
  const palette = WORLD_PALETTES[LEVEL.palette];

  setStatus(`depacking + decoding ${LEVEL.pak}, ${LEVEL.pap}, ${LEVEL.pin}...`);
  const [pak, pap, levelScript, entityShapes] = await Promise.all([
    cache.getPak(LEVEL.pak, palette),
    cache.getPap(LEVEL.pap),
    cache.getLevelScript(LEVEL.pin),
    loadEntityShapes(),
  ]);

  const tw = pak.tileWidth;
  const th = pak.tileHeight;
  canvas.width = GRID_SIZE * tw;
  canvas.height = GRID_SIZE * th;

  // --- background tile layer: opaque, so a single putImageData blit is correct ---
  const imageData = ctx.createImageData(canvas.width, canvas.height);
  const dest = imageData.data;
  const destStride = canvas.width * 4;
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const value = pap.grid[row * GRID_SIZE + col];
      if (value === 0 || value > pak.tileCount) continue;
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

  // --- entity layer: load every .pak this world's shape table might reference, best-effort ---
  const spriteFiles = paksNeededForWorld(entityShapes, LEVEL.world);
  const spritePaks = {};
  await Promise.all(
    spriteFiles.map(async (name) => {
      const filename = `${name}.pak`;
      if (!cache.has(filename)) return; // missing is fine -- those entities fall back to a dot
      try {
        spritePaks[name] = await cache.getPak(filename, palette);
      } catch {
        // best-effort, same as tools/viewer.html
      }
    })
  );

  let drawn = 0;
  let sprited = 0;
  let offMap = 0;
  for (const e of levelScript.entities) {
    if (e.x === undefined || e.y === undefined) continue;
    if (e.x < -500 || e.x > canvas.width + 500 || e.y < -500 || e.y > canvas.height + 500) {
      offMap++;
      continue;
    }
    drawn++;
    const resolved = resolveEntitySprite(e.type, entityShapes, LEVEL.world);
    const pakForEntity = resolved && spritePaks[resolved.file];
    if (pakForEntity && resolved.localTileIndex < pakForEntity.tileCount) {
      sprited++;
      const rgba = pakForEntity.tiles[resolved.localTileIndex];
      const c = tileToCanvas(rgba, pakForEntity.tileWidth, pakForEntity.tileHeight);
      ctx.drawImage(c, e.x, e.y);
    } else {
      ctx.beginPath();
      ctx.arc(e.x, e.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = colorForType(e.type);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
    }
  }

  setStatus(
    `${LEVEL.pap}: 128x128 grid, ${pak.tileCount} tiles in ${LEVEL.pak} -- ${drawn} entities from ` +
      `${LEVEL.pin} (${sprited} real sprites, ${drawn - sprited} unresolved dots, ${offMap} far ` +
      `off-map) -- everything depacked + decoded entirely in-browser from the original RNC-` +
      `compressed files, no build/ step.`
  );
}

async function run(cache) {
  const required = [LEVEL.pak, LEVEL.pap, LEVEL.pin];
  for (const f of required) {
    if (!cache.has(f)) {
      setStatus(`missing required file: ${f} (looked for it, case-insensitive, among the picked files)`, true);
      return;
    }
  }
  try {
    await renderLevel(cache);
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
  const allFiles = [
    LEVEL.pak, LEVEL.pap, LEVEL.pin,
    'bitkid.pak', 'kidx1.pak', 'special1.pak', 'extras.pak', 'extrax1.pak', 'nasty1.pak',
  ];
  const source = sourceFromFetch('/data', allFiles);
  run(new AssetCache(source));
});
