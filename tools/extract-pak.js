#!/usr/bin/env node
// Extracts .pak sprite/tile banks to a PNG sprite sheet.
//
// Three distinct on-disk formats, all confirmed against build/raw/*.pak.raw -- see
// docs/formats/pak.md:
//
// 1. Sprite banks (special/kidx/nasty/bitkid/ape): a flat array of fixed-size 640-byte tile
//    records, no header. Each record is a 32x32 masked EGA sprite: one AND-mask bitplane
//    followed by four OR-color bitplanes, each 32 rows x 4 bytes (128 bytes/plane), matching
//    Gfx_BlitSpriteMasked's on-disk layout.
//
// 2. blocks1-4.pak (level background/terrain tiles): a flat array of fixed-size 256-byte tile
//    records, no header, no mask plane. Each record is an UNMASKED, directly-opaque 32x16 EGA
//    tile: four consecutive color bitplanes, each 16 rows x 4 bytes (64 bytes/plane). Confirmed
//    via Gfx_CopyTileBankPlanes/Gfx_CopyPlaneRow32Words's disassembly (CX=0x78=120 tiles/call)
//    and by rendering -- every blocksN.pak produces a clean, coherent 120-tile terrain sheet
//    (rock/brick/crystal/signage tiles, one file even contains a legible "EXIT" sign tile).
//
// 3. extras.pak/extrax1-4.pak (HUD/bonus-item icons): a flat array of fixed-size 160-byte tile
//    records, no header. Each record is a 16x16 masked EGA sprite: one AND-mask bitplane
//    followed by four OR-color bitplanes, each 16 rows x 2 bytes (32 bytes/plane) -- HALF the
//    width and height of the "sprite bank" format above, despite the total file size dividing
//    evenly by 640 too (a coincidence: 38400/640=60 and 38400/160=240 are both exact). Found via
//    the shape-descriptor table at 6de3:b91a (96 fixed 28-byte records, indexed through
//    Entity_LookupShapeDescriptor's *real* table lookup -- it was wrongly tagged a no-op passthrough
//    because that check only looked at its AX return value and missed that DI carries the real
//    result): every descriptor whose bank-id field (+0xe) is 6 (segment 0x5c53, where
//    extras.pak+extraxN.pak load) has height field (+0x14) == 16, not 32. Confirmed by
//    rendering: extras.pak is a full HUD sheet (score digits 100-1000, A-Z, 0-9, food/drink
//    icons), and extrax1-4.pak are per-world bonus-item icons (spinning weights/gems, power-ups,
//    one file has a legible "EXIT" sign tile) -- all clean, no noise, unlike the previous
//    640-byte reading of the same bytes.
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

const EXTRAS_TILE_WIDTH_BYTES = 2; // 16px
const EXTRAS_TILE_HEIGHT = 16;
const EXTRAS_PLANE_SIZE = EXTRAS_TILE_WIDTH_BYTES * EXTRAS_TILE_HEIGHT; // 32
const EXTRAS_TILE_SIZE = EXTRAS_PLANE_SIZE * 5; // 160 (1 mask + 4 color planes)
const EXTRAS_TILE_PIXELS = EXTRAS_TILE_WIDTH_BYTES * 8; // 16

function isBlocksFile(inputPath) {
  return /blocks\d*\.pak/i.test(path.basename(inputPath));
}

function isExtrasFile(inputPath) {
  return /^extra[sx]\d*\.pak/i.test(path.basename(inputPath));
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

function formatFor(inputPath) {
  if (isBlocksFile(inputPath)) return 'blocks';
  if (isExtrasFile(inputPath)) return 'extras';
  return 'sprite';
}

const TILE_SIZE_BY_FORMAT = { sprite: TILE_SIZE, blocks: BLOCKS_TILE_SIZE, extras: EXTRAS_TILE_SIZE };
const TILE_PIXELS_BY_FORMAT = {
  sprite: { w: TILE_PIXELS, h: TILE_HEIGHT },
  blocks: { w: BLOCKS_TILE_PIXELS_W, h: BLOCKS_TILE_PIXELS_H },
  extras: { w: EXTRAS_TILE_PIXELS, h: EXTRAS_TILE_HEIGHT },
};
const JSON_FORMAT_NAME = {
  sprite: 'masked-32x32',
  blocks: 'direct-32x16',
  extras: 'masked-16x16',
};

function decodeTile(format, buf, offset, palette) {
  if (format === 'blocks') return decodeDirectTile(buf, offset, BLOCKS_TILE_WIDTH_BYTES, BLOCKS_TILE_HEIGHT, palette);
  if (format === 'extras') return decodeMaskedTile(buf, offset, EXTRAS_TILE_WIDTH_BYTES, EXTRAS_TILE_HEIGHT, palette);
  return decodeMaskedTile(buf, offset, TILE_WIDTH_BYTES, TILE_HEIGHT, palette);
}

function extractSheet(buf, format) {
  const tileSize = TILE_SIZE_BY_FORMAT[format];
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
  const format = formatFor(inputPath);
  const { tileCount, tiles } = extractSheet(buf, format);

  const { w: tilePixelsW, h: tilePixelsH } = TILE_PIXELS_BY_FORMAT[format];
  const sheetCols = cols > 0 ? cols : Math.ceil(Math.sqrt(tileCount));
  const sheetRows = Math.ceil(tileCount / sheetCols);
  const sheetWidth = sheetCols * tilePixelsW;
  const sheetHeight = sheetRows * tilePixelsH;
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4);

  tiles.forEach((offset, i) => {
    const tileRgba = decodeTile(format, buf, offset, palette);
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

  // Atlas layout sidecar -- lets consumers (e.g. level.html) compute each tile's
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
      format: JSON_FORMAT_NAME[format],
    })
  );

  console.log(
    `${path.basename(inputPath)}: ${tileCount} tiles (${tilePixelsW}x${tilePixelsH}) -> ${outputPath} ` +
      `(${sheetWidth}x${sheetHeight}, ${sheetCols}x${sheetRows} grid, palette=${paletteName})`
  );
}

main();
