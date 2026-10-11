// Canvas2D rendering helpers. Background tiles are baked into one offscreen canvas once per level
// (same technique level.html validated) since they're static and large; the per-frame
// render path (loop.js) is a single cropped drawImage of that canvas at the camera's current
// (possibly fractional) pixel position -- no hardware pixel-panning register to emulate, see
// engine/camera.js. Entities are drawn live, every frame, straight from the entity pool (Phase 4
// on: some of them move -- see engine/entity-ai.js), culled to the camera viewport.

'use strict';

import { GRID_SIZE } from '../core/pap.js';
import { resolveEntitySprite, paksNeededForWorld } from '../core/shapes.js';

function colorForType(type) {
  const hue = (type * 47) % 360;
  return `hsl(${hue}, 85%, 60%)`;
}

/** Blit every non-empty .pap cell's .pak tile into a fresh canvas. Tiles are opaque, so a single putImageData is correct. */
export function buildBackgroundCanvas(pak, pap) {
  const tw = pak.tileWidth;
  const th = pak.tileHeight;
  const width = GRID_SIZE * tw;
  const height = GRID_SIZE * th;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const imageData = ctx.createImageData(width, height);
  const dest = imageData.data;
  const destStride = width * 4;
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
  return canvas;
}

const tileCanvasCache = new WeakMap();
/** Memoized RGBA-Uint8Array -> offscreen <canvas>, so alpha-compositing (drawImage) is cheap to reuse. */
export function tileToCanvas(rgba, w, h) {
  let c = tileCanvasCache.get(rgba);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  tileCanvasCache.set(rgba, c);
  return c;
}

/**
 * Loads every sprite atlas the given world's entity-shapes table might reference (best-effort,
 * missing files are fine -- those entities just fall back to a dot). Returns { file: pakData }.
 */
export async function loadSpritePaks(cache, entityShapes, world, palette) {
  const spriteFiles = paksNeededForWorld(entityShapes, world);
  const spritePaks = {};
  await Promise.all(
    spriteFiles.map(async (name) => {
      const filename = `${name}.pak`;
      if (!cache.has(filename)) return;
      try {
        spritePaks[name] = await cache.getPak(filename, palette);
      } catch {
        // best-effort, same as level.html
      }
    })
  );
  return spritePaks;
}

/**
 * Draws every live entity in `entities` at its CURRENT (x, y) -- called every frame, not baked --
 * culled to the camera viewport. Returns { drawn, sprited } for the visible set.
 */
export function drawEntitiesLive(ctx, entities, entityShapes, spritePaks, world, camera, viewportW, viewportH) {
  let drawn = 0;
  let sprited = 0;
  const margin = 64;
  for (const e of entities) {
    if (e.x === undefined || e.y === undefined) continue;
    const sx = e.x - camera.x;
    const sy = e.y - camera.y;
    if (sx < -margin || sx > viewportW + margin || sy < -margin || sy > viewportH + margin) continue;
    drawn++;
    const resolved = resolveEntitySprite(e.type, entityShapes, world);
    const pakForEntity = resolved && spritePaks[resolved.file];
    if (pakForEntity && resolved.localTileIndex < pakForEntity.tileCount) {
      sprited++;
      const rgba = pakForEntity.tiles[resolved.localTileIndex];
      const c = tileToCanvas(rgba, pakForEntity.tileWidth, pakForEntity.tileHeight);
      ctx.drawImage(c, sx, sy);
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = colorForType(e.type);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
    }
  }
  return { drawn, sprited };
}

/**
 * Loads a level's background + level-script data (no entity drawing -- that's now live/dynamic,
 * see drawEntitiesLive). `cache` is an AssetCache; `level` is { pak, pap, pin, palette, world }.
 */
export async function buildLevelScene(cache, level) {
  const palette = level.paletteColors;
  const [pak, pap, levelScript] = await Promise.all([
    cache.getPak(level.pak, palette),
    cache.getPap(level.pap),
    cache.getLevelScript(level.pin),
  ]);
  const canvas = buildBackgroundCanvas(pak, pap);
  return { canvas, pak, pap, levelScript, widthPx: canvas.width, heightPx: canvas.height };
}
