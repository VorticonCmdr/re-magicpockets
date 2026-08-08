// Real, code-derived VGA DAC palettes -- verbatim port of tools/palette.js (that file was already
// isomorphic: no Buffer/fs usage), just re-exported as an ES module. See tools/palette.js for the
// full derivation notes (Video_ApplyVgaPalette, Video_SelectAndLoadPalette).

'use strict';

function scaleComponent(n) {
  if (n === 0) return 0;
  let v = Math.floor((n * 0x3f) / 7) + 6;
  if (v >= 0x3f) v = 0x3f;
  return v;
}

function to8(v6) {
  return Math.round((v6 * 255) / 63);
}

function decodeBank(bytes) {
  const colors = [];
  for (let i = 0; i < 16; i++) {
    const b0 = bytes[i * 2];
    const b1 = bytes[i * 2 + 1];
    const r = to8(scaleComponent(b1));
    const g = to8(scaleComponent((b0 >> 4) & 0xf));
    const b = to8(scaleComponent(b0 & 7));
    colors.push([r, g, b]);
  }
  return colors;
}

const RAW_BANKS = {
  world0_current: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  world1: [0,0,19,1,36,3,54,3,71,4,119,7,84,7,67,7,50,6,32,4,0,3,50,0,67,0,100,4,115,7,0,0],
  world2: [0,0,18,0,34,1,54,3,71,4,119,7,84,7,67,7,50,6,32,4,0,3,49,0,66,0,83,4,115,7,0,0],
  world3: [0,0,18,0,34,1,54,3,71,4,119,7,84,7,67,7,50,6,32,4,0,3,49,0,66,0,83,4,115,7,0,0],
  world4: [0,0,19,1,36,2,54,3,71,4,119,7,84,7,67,7,50,6,32,4,0,3,49,0,67,0,101,4,115,7,0,0],
};

export const WORLD_PALETTES = {};
for (const [name, bytes] of Object.entries(RAW_BANKS)) {
  WORLD_PALETTES[name] = decodeBank(bytes);
}

export { decodeBank, scaleComponent };
