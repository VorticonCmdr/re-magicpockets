#!/usr/bin/env node
// Extracts a .pip full-screen picture to PNG.
//
// Format (traced from FUN_1000_bd64, the confirmed picture-blit function called right after
// Load_PackedFile reads new.pip in World1_LoadBanks -- see docs/formats/pip.md):
// direct (unmasked) 4-plane EGA picture, 320x192, plane-words interleaved per 16-pixel group
// (NOT stored as 4 separate contiguous planes like .pak sprites). Confirmed picture data
// starts at byte offset 0x22 within the loaded file/segment.
//
// Usage: node tools/extract-pip.js <file.pip.raw> [out.png]

'use strict';

const fs = require('fs');
const path = require('path');
const { decodeDirectPicture } = require('./ega.js');
const { encodePng } = require('./png.js');
const { WORLD_PALETTES } = require('./palette.js');

const PICTURE_OFFSET = 0x22;
const WIDTH_WORDS = 20; // 320px
const HEIGHT_ROWS = 192;

function main() {
  const argv = process.argv.slice(2);
  let paletteName = 'world1';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--palette') {
      paletteName = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  const [inputPath, outputArg] = rest;
  if (!inputPath) {
    console.error('Usage: node tools/extract-pip.js <file.pip.raw> [out.png] [--palette worldN]');
    process.exit(1);
  }
  const palette = WORLD_PALETTES[paletteName];
  if (!palette) {
    console.error(`Unknown --palette '${paletteName}'. Options: ${Object.keys(WORLD_PALETTES).join(', ')}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(inputPath);
  const outputPath = outputArg || inputPath.replace(/(\.raw)?$/, '') + '.png';

  const expectedEnd = PICTURE_OFFSET + WIDTH_WORDS * HEIGHT_ROWS * 8;
  if (buf.length < expectedEnd) {
    console.error(
      `WARNING: ${inputPath} is ${buf.length} bytes, need at least ${expectedEnd} -- ` +
        'proceeding anyway but the image may be truncated/garbage.'
    );
  }

  const rgba = decodeDirectPicture(buf, PICTURE_OFFSET, WIDTH_WORDS, HEIGHT_ROWS, palette);
  fs.writeFileSync(outputPath, encodePng(WIDTH_WORDS * 16, HEIGHT_ROWS, rgba));

  const trailingBytes = buf.length - expectedEnd;
  console.log(
    `${path.basename(inputPath)}: 320x192 picture -> ${outputPath} (palette=${paletteName})` +
      (trailingBytes > 0 ? ` (${trailingBytes} trailing bytes unaccounted for -- see docs/formats/pip.md)` : '')
  );
}

main();
