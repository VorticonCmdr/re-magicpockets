#!/usr/bin/env node
// Extracts .pak sprite/tile banks to a PNG sprite sheet.
//
// Format (empirically confirmed against build/raw/*.pak.raw -- see docs/formats/pak.md):
// a flat array of fixed-size 640-byte tile records, no header at all. Each record is a
// 32x32 masked EGA sprite: one AND-mask bitplane followed by four OR-color bitplanes,
// each 32 rows x 4 bytes (128 bytes/plane), matching Gfx_BlitSpriteMasked's on-disk layout.
// tile count = file size / 640 (confirmed to divide evenly for every shipped .pak file).
//
// Usage: node tools/extract-pak.js <file.pak.raw> [out.png] [--cols N]

'use strict';

const fs = require('fs');
const path = require('path');
const { decodeMaskedTile } = require('./ega.js');
const { encodePng } = require('./png.js');
const { WORLD_PALETTES } = require('./palette.js');

const TILE_WIDTH_BYTES = 4; // 32px
const TILE_HEIGHT = 32;
const PLANE_SIZE = TILE_WIDTH_BYTES * TILE_HEIGHT; // 128
const TILE_SIZE = PLANE_SIZE * 5; // 640 (1 mask + 4 color planes)
const TILE_PIXELS = TILE_WIDTH_BYTES * 8; // 32

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

function extractSheet(buf) {
  if (buf.length % TILE_SIZE !== 0) {
    throw new Error(
      `size ${buf.length} is not a multiple of ${TILE_SIZE} -- not a recognized .pak layout`
    );
  }
  const tileCount = buf.length / TILE_SIZE;
  return { tileCount, tiles: Array.from({ length: tileCount }, (_, i) => i * TILE_SIZE) };
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
  const { tileCount, tiles } = extractSheet(buf);

  const sheetCols = cols > 0 ? cols : Math.ceil(Math.sqrt(tileCount));
  const sheetRows = Math.ceil(tileCount / sheetCols);
  const sheetWidth = sheetCols * TILE_PIXELS;
  const sheetHeight = sheetRows * TILE_PIXELS;
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4);

  tiles.forEach((offset, i) => {
    const tileRgba = decodeMaskedTile(buf, offset, TILE_WIDTH_BYTES, TILE_HEIGHT, palette);
    const tileCol = i % sheetCols;
    const tileRow = Math.floor(i / sheetCols);
    const destX = tileCol * TILE_PIXELS;
    const destY = tileRow * TILE_PIXELS;
    for (let y = 0; y < TILE_PIXELS; y++) {
      const srcStart = y * TILE_PIXELS * 4;
      const destOffset = ((destY + y) * sheetWidth + destX) * 4;
      tileRgba.copy(sheet, destOffset, srcStart, srcStart + TILE_PIXELS * 4);
    }
  });

  fs.writeFileSync(outputPath, encodePng(sheetWidth, sheetHeight, sheet));
  console.log(
    `${path.basename(inputPath)}: ${tileCount} tiles (32x32) -> ${outputPath} ` +
      `(${sheetWidth}x${sheetHeight}, ${sheetCols}x${sheetRows} grid, palette=${paletteName})`
  );
}

main();
