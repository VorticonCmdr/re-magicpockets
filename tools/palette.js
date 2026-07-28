// Real, code-derived VGA DAC palettes, found by tracing Video_ApplyVgaPalette (1000:170b) and
// Video_SelectAndLoadPalette (1000:3bbf) -- see docs/memory-map.md "Palette setting". Only
// reached on the 'C' ("Colour VGA") driver path, which is what this project's own shipped
// pockets.ini actually selects.
//
// 24 contiguous 32-byte (16-word) palette banks live at 6de3:da96 (bank[i] = da96 + i*32).
// Bank 0 is the "current" slot, populated at runtime from loaded level data (all-zero
// statically). Banks 7 / 0x13 / 0x14 / 0x15 (19/20/21) are the ones Video_SelectAndLoadPalette
// special-cases by current world when called with AL==7 -- confirmed directly from
// Debug_HandleCheatInput's level-select cheat handler, which reads a (world, palette-bank)
// pair straight out of its cheat-code table and calls Video_SelectAndLoadPalette(paletteBank)
// *before* loading that world's level data. These four banks are used here as each world's
// "starting area" palette; other sub-levels within a world may use other banks in the 24-bank
// table that haven't been individually mapped yet (open question).
//
// Per-color word format (confirmed from Video_ApplyVgaPalette's disassembly): LODSW reads a
// little-endian word (byte0 = low memory byte, byte1 = high memory byte). R = byte1, G = high
// nibble of byte0, B = low 3 bits of byte0. Each component is scaled 0-7(ish) -> 6-bit VGA DAC
// value by Video_ScaleColorComponent (see scaleComponent below), and the resulting 6-bit values
// are here rescaled to 8-bit (v*255/63) for RGBA output.
//
// Raw bytes below were read directly from 6de3:<bank address> via Ghidra's read_memory (in
// small, individually-verified 32-byte chunks -- the table's long runs of repeated bytes made
// larger reads risky to hand-transcribe without introducing an off-by-a-few-bytes error).

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
  // 6de3:da96 -- "current" slot, runtime-populated, all-zero in the static image
  world0_current: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  // 6de3:db76 -- bank 7
  world1: [0,0,19,1,36,3,54,3,71,4,119,7,84,7,67,7,50,6,32,4,0,3,50,0,67,0,100,4,115,7,0,0],
  // 6de3:dcf6 -- bank 0x13 (19)
  world2: [0,0,18,0,34,1,54,3,71,4,119,7,84,7,67,7,50,6,32,4,0,3,49,0,66,0,83,4,115,7,0,0],
  // 6de3:dd16 -- bank 0x14 (20)
  world3: [0,0,18,0,34,1,54,3,71,4,119,7,84,7,67,7,50,6,32,4,0,3,49,0,66,0,83,4,115,7,0,0],
  // 6de3:dd36 -- bank 0x15 (21)
  world4: [0,0,19,1,36,2,54,3,71,4,119,7,84,7,67,7,50,6,32,4,0,3,49,0,67,0,101,4,115,7,0,0],
};

const WORLD_PALETTES = {};
for (const [name, bytes] of Object.entries(RAW_BANKS)) {
  WORLD_PALETTES[name] = decodeBank(bytes);
}

module.exports = { WORLD_PALETTES, decodeBank, scaleComponent };
