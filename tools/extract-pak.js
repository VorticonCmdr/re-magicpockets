#!/usr/bin/env node
// Extracts .pak sprite/tile banks to a PNG sprite sheet.
//
// Two distinct on-disk formats, both confirmed against build/raw/*.pak.raw -- see
// docs/formats/pak.md:
//
// 1. Sprite banks (special/kidx/extrax/nasty/bitkid/ape/extras): a flat array of fixed-size
//    640-byte tile records, no header. Each record is a 32x32 masked EGA sprite: one AND-mask
//    bitplane followed by four OR-color bitplanes, each 32 rows x 4 bytes (128 bytes/plane),
//    matching Gfx_BlitSpriteMasked's on-disk layout.
//
// 2. blocks1-4.pak (level background/terrain tiles): a flat array of fixed-size 256-byte tile
//    records, no header, no mask plane. Each record is an UNMASKED, directly-opaque 32x16 EGA
//    tile: four consecutive color bitplanes, each 16 rows x 4 bytes (64 bytes/plane). Confirmed
//    via Gfx_CopyTileBankPlanes/Gfx_CopyPlaneRow32Words's disassembly (CX=0x78=120 tiles/call)
//    and by rendering -- every blocksN.pak produces a clean, coherent 120-tile terrain sheet
//    (rock/brick/crystal/signage tiles, one file even contains a legible "EXIT" sign tile).
//
// Usage: node tools/extract-pak.js <file.pak.raw> [out.png] [--cols N]

'use strict';

const fs = require('fs');
const path = require('path');
const { decodeMaskedTile, decodeDirectTile } = require('./ega.js');
const { encodePng } = require('./png.js');
const { WORLD_PALETTES } = require('./palette.js');

const TILE_WIDTH_BYTES = 4; // 32px
const TILE_HEIGHT = 32;
const PLANE_SIZE = TILE_WIDTH_BYTES * TILE_HEIGHT; // 128
const TILE_SIZE = PLANE_SIZE * 5; // 640 (1 mask + 4 color planes)
const TILE_PIXELS = TILE_WIDTH_BYTES * 8; // 32

const BLOCKS_TILE_WIDTH_BYTES = 4; // 32px
const BLOCKS_TILE_HEIGHT = 16;
const BLOCKS_PLANE_SIZE = BLOCKS_TILE_WIDTH_BYTES * BLOCKS_TILE_HEIGHT; // 64
const BLOCKS_TILE_SIZE = BLOCKS_PLANE_SIZE * 4; // 256 (4 color planes, no mask)
const BLOCKS_TILE_PIXELS_W = BLOCKS_TILE_WIDTH_BYTES * 8; // 32
const BLOCKS_TILE_PIXELS_H = BLOCKS_TILE_HEIGHT; // 16

function isBlocksFile(inputPath) {
  return /blocks\d*\.pak/i.test(path.basename(inputPath));
}

function parseArgs(argv) {
  const args = { cols: 0, files: [], palette: 'world1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cols') {
      args.cols = parseInt(argv[++i], 10);
    } else if (argv[i] === '--palette') {
      args.palette = argv[++i];
    } else {
      args.files.push(argv[i]);
    }
  }
  return args;
}

function extractSheet(buf, blocksFormat) {
  const tileSize = blocksFormat ? BLOCKS_TILE_SIZE : TILE_SIZE;
  if (buf.length % tileSize !== 0) {
    throw new Error(
      `size ${buf.length} is not a multiple of ${tileSize} -- not a recognized .pak layout`
    );
  }
  const tileCount = buf.length / tileSize;
  return { tileCount, tiles: Array.from({ length: tileCount }, (_, i) => i * tileSize) };
}

function main() {
  const { cols, files, palette: paletteName } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error(
      'Usage: node tools/extract-pak.js <file.pak.raw> [out.png] [--cols N] [--palette worldN]'
    );
    process.exit(1);
  }
  const palette = WORLD_PALETTES[paletteName];
  if (!palette) {
    console.error(`Unknown --palette '${paletteName}'. Options: ${Object.keys(WORLD_PALETTES).join(', ')}`);
    process.exit(1);
  }

  const inputPath = files[0];
  const outputPath = files[1] || inputPath.replace(/(\.raw)?$/, '') + '.png';
  const buf = fs.readFileSync(inputPath);
  const blocksFormat = isBlocksFile(inputPath);
  const { tileCount, tiles } = extractSheet(buf, blocksFormat);

  const tilePixelsW = blocksFormat ? BLOCKS_TILE_PIXELS_W : TILE_PIXELS;
  const tilePixelsH = blocksFormat ? BLOCKS_TILE_PIXELS_H : TILE_PIXELS;
  const sheetCols = cols > 0 ? cols : Math.ceil(Math.sqrt(tileCount));
  const sheetRows = Math.ceil(tileCount / sheetCols);
  const sheetWidth = sheetCols * tilePixelsW;
  const sheetHeight = sheetRows * tilePixelsH;
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4);

  tiles.forEach((offset, i) => {
    const tileRgba = blocksFormat
      ? decodeDirectTile(buf, offset, BLOCKS_TILE_WIDTH_BYTES, BLOCKS_TILE_HEIGHT, palette)
      : decodeMaskedTile(buf, offset, TILE_WIDTH_BYTES, TILE_HEIGHT, palette);
    const tileCol = i % sheetCols;
    const tileRow = Math.floor(i / sheetCols);
    const destX = tileCol * tilePixelsW;
    const destY = tileRow * tilePixelsH;
    for (let y = 0; y < tilePixelsH; y++) {
      const srcStart = y * tilePixelsW * 4;
      const destOffset = ((destY + y) * sheetWidth + destX) * 4;
      tileRgba.copy(sheet, destOffset, srcStart, srcStart + tilePixelsW * 4);
    }
  });

  fs.writeFileSync(outputPath, encodePng(sheetWidth, sheetHeight, sheet));

  // Atlas layout sidecar -- lets consumers (e.g. tools/viewer.html) compute each tile's
  // source rect without hardcoding sheetCols/tile pixel size assumptions.
  const jsonPath = outputPath.replace(/\.png$/, '.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      tileCount,
      tileWidth: tilePixelsW,
      tileHeight: tilePixelsH,
      cols: sheetCols,
      rows: sheetRows,
      format: blocksFormat ? 'direct-32x16' : 'masked-32x32',
    })
  );

  console.log(
    `${path.basename(inputPath)}: ${tileCount} tiles (${tilePixelsW}x${tilePixelsH}) -> ${outputPath} ` +
      `(${sheetWidth}x${sheetHeight}, ${sheetCols}x${sheetRows} grid, palette=${paletteName})`
  );
}

main();
