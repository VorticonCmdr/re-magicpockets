// Canvas2D rendering helpers -- builds a full-level offscreen canvas (background tiles + entity
// sprites, same technique tools/viewer.html validated) once per level, so the per-frame render
// path (loop.js) is just a single cropped drawImage of that offscreen canvas at the camera's
// current (possibly fractional) pixel position -- no hardware pixel-panning register to emulate,
// see engine/camera.js.

'use strict';

import { GRID_SIZE } from '../core/pap.js';
import { resolveEntitySprite, paksNeededForWorld } from '../core/shapes.js';

function colorForType(type) {
  const hue = (type * 47) % 360;
  return `hsl(${hue}, 85%, 60%)`;
}

const COLLISION_TILE_W = 32; // engine/camera.js's TILE_WIDTH -- duplicated here to avoid an import cycle
const COLLISION_TILE_H = 16; // engine/camera.js's TILE_HEIGHT

/**
 * Draws a translucent overlay over every solid cell of a placeholder collision grid (see
 * engine/placeholder-terrain.js) that's currently visible in the viewport, so it's visually clear
 * which geometry is actually collidable -- it doesn't correspond to the real cave art underneath
 * (that mapping is still an open item, see docs/engine.md's `[0xef23]` note).
 */
export function drawCollisionOverlay(ctx, collisionGrid, camera, viewportW, viewportH) {
  const colStart = Math.max(0, Math.floor(camera.x / COLLISION_TILE_W));
  const colEnd = Math.min(GRID_SIZE - 1, Math.ceil((camera.x + viewportW) / COLLISION_TILE_W));
  const rowStart = Math.max(0, Math.floor(camera.y / COLLISION_TILE_H));
  const rowEnd = Math.min(GRID_SIZE - 1, Math.ceil((camera.y + viewportH) / COLLISION_TILE_H));

  ctx.save();
  ctx.fillStyle = 'rgba(255, 45, 149, 0.35)';
  ctx.strokeStyle = 'rgba(255, 45, 149, 0.8)';
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      if (collisionGrid.grid[row * GRID_SIZE + col] === 0) continue;
      const x = col * COLLISION_TILE_W - camera.x;
      const y = row * COLLISION_TILE_H - camera.y;
      ctx.fillRect(x, y, COLLISION_TILE_W, COLLISION_TILE_H);
      ctx.strokeRect(x + 0.5, y + 0.5, COLLISION_TILE_W - 1, COLLISION_TILE_H - 1);
    }
  }
  ctx.restore();
}

/** Blit every non-empty .pap cell's .pak tile into a fresh canvas. Tiles are opaque, so a single putImageData is correct. */
function buildBackgroundCanvas(pak, pap) {
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

/**
 * Loads every sprite atlas the given world's entity-shapes table might reference (best-effort,
 * missing files are fine -- those entities just fall back to a dot), draws every placed entity
 * onto `canvas` at its (x, y), and returns {drawn, sprited, offMap} counts.
 */
async function drawEntities(canvas, cache, levelScript, entityShapes, world, palette) {
  const ctx = canvas.getContext('2d');
  const spriteFiles = paksNeededForWorld(entityShapes, world);
  const spritePaks = {};
  await Promise.all(
    spriteFiles.map(async (name) => {
      const filename = `${name}.pak`;
      if (!cache.has(filename)) return;
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
    const resolved = resolveEntitySprite(e.type, entityShapes, world);
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
  return { drawn, sprited, offMap };
}

/**
 * Builds the full static level scene (background + entities) as one offscreen canvas, ready to
 * be cropped by a camera each frame. `cache` is an AssetCache; `level` is
 * { pak, pap, pin, palette, world } (see main.js).
 */
export async function buildLevelScene(cache, level, entityShapes) {
  const palette = level.paletteColors;
  const [pak, pap, levelScript] = await Promise.all([
    cache.getPak(level.pak, palette),
    cache.getPap(level.pap),
    cache.getLevelScript(level.pin),
  ]);
  const canvas = buildBackgroundCanvas(pak, pap);
  const entityStats = await drawEntities(canvas, cache, levelScript, entityShapes, level.world, palette);
  return { canvas, pak, pap, levelScript, entityStats, widthPx: canvas.width, heightPx: canvas.height };
}
