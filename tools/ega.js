// EGA/VGA planar bitmap helpers.
//
// The game never programs a custom palette anywhere (see docs/memory-map.md "Sprite
// rendering" -- confirmed by an exhaustive port/interrupt search), so we use the fixed
// default 16-colour EGA/VGA palette. Plane-to-color-bit order (0=Blue,1=Green,2=Red,
// 3=Intensity) matches the Sequencer Map Mask cycling order confirmed in
// Gfx_BlitSpriteMasked (1000:7ea0): the OR passes select planes via mask values
// 0x01,0x02,0x04,0x08 in that exact sequence, and the on-disk sprite/tile format stores
// planes in the same 0..3 order immediately after the AND-mask plane (see
// docs/formats/pak.md).

'use strict';

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
function decodeMaskedTile(buf, offset, widthBytes, heightRows) {
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
      let index = 0;
      for (let plane = 0; plane < 4; plane++) {
        if (colorPlanes[plane][byteIdx] & bitMask) index |= 1 << plane;
      }
      const [r, g, b] = EGA_PALETTE[index];
      rgba[pixelOffset] = r;
      rgba[pixelOffset + 1] = g;
      rgba[pixelOffset + 2] = b;
      rgba[pixelOffset + 3] = 255;
    }
  }
  return rgba;
}

module.exports = { EGA_PALETTE, decodeMaskedTile };
