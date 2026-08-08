// .pap level tile-map decoder -- port of tools/extract-pap.js's grid parser, minus the CLI/PNG
// heatmap bits. Format: 128x128 bytes, row-major, no header. Value 1-120 indexes 1:1 (V-1, 0
// based) into the matching blocksN.pak; 0 = empty/background. See docs/formats/pap.md.

'use strict';

const GRID_SIZE = 128;

/** Decode a depacked .pap buffer (Uint8Array) into a 128x128 row-major Uint8Array grid. */
export function decodePap(buf) {
  if (buf.length !== GRID_SIZE * GRID_SIZE) {
    console.warn(`.pap: ${buf.length} bytes, expected ${GRID_SIZE * GRID_SIZE} (128x128) -- proceeding anyway`);
  }
  const grid = new Uint8Array(GRID_SIZE * GRID_SIZE);
  grid.set(buf.subarray(0, Math.min(buf.length, grid.length)));
  return { size: GRID_SIZE, grid };
}

export { GRID_SIZE };
