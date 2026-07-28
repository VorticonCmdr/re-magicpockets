#!/usr/bin/env node
// Dumps a .pap level tile-map as a tile-index heatmap PNG (one pixel per tile) for visual
// sanity-checking, plus the raw grid as JSON.
//
// Format (traced from Level_TransposeMapToColumnMajor's transpose arithmetic -- see
// docs/formats/pap.md): 128x128 bytes, ROW-MAJOR on disk, no header.
//   byte at (row*128 + col) = tile index for map row `row`, column `col`.
// (The engine transposes this into a column-major in-memory buffer for fast scrolling access;
// that transposed layout is an engine-internal detail, not the on-disk format.)
//
// This is NOT yet a true rendered level (the tile-index -> .pak-tile mapping isn't confirmed),
// just a heatmap: distinct tile values get visually distinct colors so level structure
// (platforms, gaps, repeating patterns) is visible at a glance.
//
// Usage: node tools/extract-pap.js <file.pap.raw> [out.png]

'use strict';

const fs = require('fs');
const path = require('path');
const { encodePng } = require('./png.js');

const GRID_SIZE = 128;
const EXPECTED_SIZE = GRID_SIZE * GRID_SIZE;

// Deterministic, visually-distinct color per tile-index byte value (not the game's real
// palette -- there isn't one confirmed for tile indices yet, see docs/formats/pap.md).
function colorForValue(v) {
  if (v === 0) return [0, 0, 0];
  const hue = (v * 47) % 256;
  const r = (hue * 3) % 256;
  const g = (hue * 5 + 60) % 256;
  const b = (hue * 7 + 120) % 256;
  return [r, g, b];
}

function main() {
  const [inputPath, outputArg] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: node tools/extract-pap.js <file.pap.raw> [out.png]');
    process.exit(1);
  }
  const buf = fs.readFileSync(inputPath);
  if (buf.length !== EXPECTED_SIZE) {
    console.error(
      `WARNING: ${inputPath} is ${buf.length} bytes, expected ${EXPECTED_SIZE} (128x128) -- ` +
        'proceeding anyway but the grid may be misaligned.'
    );
  }

  const outputPath = outputArg || inputPath.replace(/(\.raw)?$/, '') + '.png';
  const scale = 4; // upscale so individual tiles are visible
  const size = GRID_SIZE * scale;
  const rgba = Buffer.alloc(size * size * 4);

  const grid = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    const rowValues = [];
    for (let col = 0; col < GRID_SIZE; col++) {
      const idx = row * GRID_SIZE + col;
      const value = idx < buf.length ? buf[idx] : 0;
      rowValues.push(value);
      const [r, g, b] = colorForValue(value);
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = col * scale + sx;
          const py = row * scale + sy;
          const off = (py * size + px) * 4;
          rgba[off] = r;
          rgba[off + 1] = g;
          rgba[off + 2] = b;
          rgba[off + 3] = 255;
        }
      }
    }
    grid.push(rowValues);
  }

  fs.writeFileSync(outputPath, encodePng(size, size, rgba));
  const jsonPath = outputPath.replace(/\.png$/, '.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ width: GRID_SIZE, height: GRID_SIZE, rows: grid }));

  const uniqueValues = new Set(buf).size;
  console.log(
    `${path.basename(inputPath)}: 128x128 row-major grid, ${uniqueValues} unique tile values ` +
      `-> ${outputPath}, ${jsonPath}`
  );
}

main();
