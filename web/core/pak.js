// .pak sprite/tile bank decoder -- port of tools/extract-pak.js's format-detection + tile-decode
// logic, minus the CLI/PNG-file plumbing. See docs/formats/pak.md.

'use strict';

import { decodeMaskedTile, decodeDirectTile } from './ega.js';

const TILE_WIDTH_BYTES = 4; // 32px
const TILE_HEIGHT = 32;
const PLANE_SIZE = TILE_WIDTH_BYTES * TILE_HEIGHT; // 128
const TILE_SIZE = PLANE_SIZE * 5; // 640 (1 mask + 4 color planes)
const TILE_PIXELS = TILE_WIDTH_BYTES * 8; // 32

const BLOCKS_TILE_WIDTH_BYTES = 4; // 32px
const BLOCKS_TILE_HEIGHT = 16;
const BLOCKS_TILE_SIZE = BLOCKS_TILE_WIDTH_BYTES * BLOCKS_TILE_HEIGHT * 4; // 256, 4 color planes
const BLOCKS_TILE_PIXELS_W = BLOCKS_TILE_WIDTH_BYTES * 8; // 32
const BLOCKS_TILE_PIXELS_H = BLOCKS_TILE_HEIGHT; // 16

const EXTRAS_TILE_WIDTH_BYTES = 2; // 16px
const EXTRAS_TILE_HEIGHT = 16;
const EXTRAS_TILE_SIZE = EXTRAS_TILE_WIDTH_BYTES * EXTRAS_TILE_HEIGHT * 5; // 160
const EXTRAS_TILE_PIXELS = EXTRAS_TILE_WIDTH_BYTES * 8; // 16

function isBlocksFile(filename) {
  return /blocks\d*\.pak/i.test(filename);
}

function isExtrasFile(filename) {
  return /^extra[sx]\d*\.pak/i.test(filename);
}

export function formatFor(filename) {
  if (isBlocksFile(filename)) return 'blocks';
  if (isExtrasFile(filename)) return 'extras';
  return 'sprite';
}

const TILE_SIZE_BY_FORMAT = { sprite: TILE_SIZE, blocks: BLOCKS_TILE_SIZE, extras: EXTRAS_TILE_SIZE };
const TILE_PIXELS_BY_FORMAT = {
  sprite: { w: TILE_PIXELS, h: TILE_HEIGHT },
  blocks: { w: BLOCKS_TILE_PIXELS_W, h: BLOCKS_TILE_PIXELS_H },
  extras: { w: EXTRAS_TILE_PIXELS, h: EXTRAS_TILE_HEIGHT },
};

function decodeTile(format, buf, offset, palette) {
  if (format === 'blocks') return decodeDirectTile(buf, offset, BLOCKS_TILE_WIDTH_BYTES, BLOCKS_TILE_HEIGHT, palette);
  if (format === 'extras') return decodeMaskedTile(buf, offset, EXTRAS_TILE_WIDTH_BYTES, EXTRAS_TILE_HEIGHT, palette);
  return decodeMaskedTile(buf, offset, TILE_WIDTH_BYTES, TILE_HEIGHT, palette);
}

/**
 * Decode a depacked .pak buffer (Uint8Array) into a list of per-tile RGBA Uint8Arrays plus the
 * tile pixel dimensions for this format. `filename` is only used to pick the on-disk layout
 * (blocks/extras/sprite) -- see docs/formats/pak.md.
 */
export function decodePak(filename, buf, palette) {
  const format = formatFor(filename);
  const tileSize = TILE_SIZE_BY_FORMAT[format];
  if (buf.length % tileSize !== 0) {
    throw new Error(`${filename}: size ${buf.length} is not a multiple of ${tileSize} (format=${format})`);
  }
  const tileCount = buf.length / tileSize;
  const { w: tileWidth, h: tileHeight } = TILE_PIXELS_BY_FORMAT[format];
  const tiles = [];
  for (let i = 0; i < tileCount; i++) {
    tiles.push(decodeTile(format, buf, i * tileSize, palette));
  }
  return { format, tileCount, tileWidth, tileHeight, tiles };
}
