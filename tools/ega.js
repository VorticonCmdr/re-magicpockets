// EGA/VGA planar bitmap helpers.
//
// The game never programs a custom palette anywhere (see docs/memory-map.md "Sprite
// rendering" -- confirmed by an exhaustive port/interrupt search), so we use the fixed
// default 16-colour EGA/VGA palette.
//
// Plane read/write ORDER (which source plane is processed 1st/2nd/3rd/4th) is confirmed from
// disassembly: both Gfx_BlitSpriteMasked and Gfx_DrawFullScreenPicture cycle the Sequencer Map
// Mask register through 0x01,0x02,0x04,0x08 in that exact sequence, reading/writing the 4
// source planes in the same 0..3 temporal order. That part is not in question.
//
// The mapping from "which plane" to "which bit of the palette index" is a separate question --
// nominally a fixed EGA/VGA hardware convention (plane0=Blue,1=Green,2=Red,3=Intensity), but
// empirically the game's actual pictures only looked correct once the sample bits were
// reassigned as PLANE_TO_INDEX_BIT below (confirmed against a decoded .pip screen by direct
// visual inspection -- see docs/formats/pip.md). Left unexplained why this differs from the
// textbook hardware default; worth revisiting if a definitive reference for this specific game
// build turns up.

'use strict';

const PLANE_TO_INDEX_BIT = [1, 0, 3, 2]; // index bit k = source plane PLANE_TO_INDEX_BIT[k]

// Standard default EGA/VGA 16-colour palette (index = intensity<<3 | red<<2 | green<<1 | blue).
const EGA_PALETTE = [
  [0x00, 0x00, 0x00], // 0 black
  [0x00, 0x00, 0xaa], // 1 blue
  [0x00, 0xaa, 0x00], // 2 green
  [0x00, 0xaa, 0xaa], // 3 cyan
  [0xaa, 0x00, 0x00], // 4 red
  [0xaa, 0x00, 0xaa], // 5 magenta
  [0xaa, 0x55, 0x00], // 6 brown
  [0xaa, 0xaa, 0xaa], // 7 light gray
  [0x55, 0x55, 0x55], // 8 dark gray
  [0x55, 0x55, 0xff], // 9 light blue
  [0x55, 0xff, 0x55], // 10 light green
  [0x55, 0xff, 0xff], // 11 light cyan
  [0xff, 0x55, 0x55], // 12 light red
  [0xff, 0x55, 0xff], // 13 light magenta
  [0xff, 0xff, 0x55], // 14 yellow
  [0xff, 0xff, 0xff], // 15 white
];

function assembleIndex(planeBitsInOrder) {
  let index = 0;
  for (let bit = 0; bit < 4; bit++) {
    if (planeBitsInOrder[PLANE_TO_INDEX_BIT[bit]]) index |= 1 << bit;
  }
  return index;
}

/**
 * Decode a masked EGA sprite/tile: one AND-mask bitplane followed by four OR-color
 * bitplanes, each `heightRows` rows of `widthBytes` bytes (MSB = leftmost pixel), tightly
 * packed with no row padding (matches Gfx_AndMaskRow/Gfx_OrPlaneRow's source-side stride).
 *
 * Returns an RGBA Buffer of width*height*4 bytes (width = widthBytes*8).
 * Mask bit 1 = transparent (background shows through); bit 0 = opaque sprite pixel --
 * matches the AND semantics (mask bit 1 leaves the destination unchanged, bit 0 clears it
 * for the following OR pass).
 */
function decodeMaskedTile(buf, offset, widthBytes, heightRows, palette = EGA_PALETTE) {
  const width = widthBytes * 8;
  const planeSize = widthBytes * heightRows;
  const maskPlane = buf.subarray(offset, offset + planeSize);
  const colorPlanes = [
    buf.subarray(offset + planeSize, offset + planeSize * 2),
    buf.subarray(offset + planeSize * 2, offset + planeSize * 3),
    buf.subarray(offset + planeSize * 3, offset + planeSize * 4),
    buf.subarray(offset + planeSize * 4, offset + planeSize * 5),
  ];

  const rgba = Buffer.alloc(width * heightRows * 4);
  for (let row = 0; row < heightRows; row++) {
    for (let col = 0; col < width; col++) {
      const byteIdx = row * widthBytes + (col >> 3);
      const bitMask = 0x80 >> (col & 7);
      const transparent = (maskPlane[byteIdx] & bitMask) !== 0;
      const pixelOffset = (row * width + col) * 4;
      if (transparent) {
        rgba[pixelOffset + 3] = 0; // alpha 0, RGB left as 0
        continue;
      }
      const planeBits = colorPlanes.map((p) => (p[byteIdx] & bitMask ? 1 : 0));
      const [r, g, b] = palette[assembleIndex(planeBits)];
      rgba[pixelOffset] = r;
      rgba[pixelOffset + 1] = g;
      rgba[pixelOffset + 2] = b;
      rgba[pixelOffset + 3] = 255;
    }
  }
  return rgba;
}

/**
 * Decode a full-screen EGA picture in the "direct" (no mask, opaque) format used by .pip
 * files -- confirmed from FUN_1000_bd64's disassembly. Unlike sprites, planes are NOT stored
 * as 4 separate contiguous blocks; instead each group of 16 pixels (one destination word) has
 * its 4 plane-words interleaved together: [plane0, plane1, plane2, plane3] (8 bytes), then the
 * next 16-pixel group's 4 plane-words, etc, row by row. `widthWords` = groups of 16px per row.
 *
 * Returns an RGBA Buffer of (widthWords*16) x heightRows pixels.
 */
function decodeDirectPicture(buf, offset, widthWords, heightRows, palette = EGA_PALETTE) {
  const width = widthWords * 16;
  const rgba = Buffer.alloc(width * heightRows * 4);
  let src = offset;
  for (let row = 0; row < heightRows; row++) {
    for (let wordGroup = 0; wordGroup < widthWords; wordGroup++) {
      // Each plane's 16-pixel group is 2 physical bytes; process them in memory order
      // (byte 0 = pixels 0-7 MSB-first, byte 1 = pixels 8-15 MSB-first) -- NOT as a combined
      // 16-bit little-endian integer, which would swap the two bytes' pixel order (byte 1's
      // bits would be read before byte 0's).
      const planeBytes = [
        [buf[src], buf[src + 1]],
        [buf[src + 2], buf[src + 3]],
        [buf[src + 4], buf[src + 5]],
        [buf[src + 6], buf[src + 7]],
      ];
      src += 8;
      for (let bit = 0; bit < 16; bit++) {
        const byteInPair = bit >> 3; // 0 for pixels 0-7, 1 for pixels 8-15
        const bitMask = 0x80 >> (bit & 7);
        const planeBits = planeBytes.map((p) => (p[byteInPair] & bitMask ? 1 : 0));
        const col = wordGroup * 16 + bit;
        const [r, g, b] = palette[assembleIndex(planeBits)];
        const pixelOffset = (row * width + col) * 4;
        rgba[pixelOffset] = r;
        rgba[pixelOffset + 1] = g;
        rgba[pixelOffset + 2] = b;
        rgba[pixelOffset + 3] = 255;
      }
    }
  }
  return rgba;
}

module.exports = { EGA_PALETTE, decodeMaskedTile, decodeDirectPicture };
