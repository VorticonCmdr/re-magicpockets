// EGA/VGA planar bitmap helpers -- isomorphic port of tools/ega.js onto Uint8Array (the original
// only used Buffer.alloc + plain indexing/subarray, both of which Uint8Array supports natively,
// so this is a near-verbatim copy). See tools/ega.js for the full derivation notes.

'use strict';

const PLANE_TO_INDEX_BIT = [0, 1, 2, 3]; // identity -- index bit k = source plane k, confirmed

export const EGA_PALETTE = [
  [0x00, 0x00, 0x00],
  [0x00, 0x00, 0xaa],
  [0x00, 0xaa, 0x00],
  [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00],
  [0xaa, 0x00, 0xaa],
  [0xaa, 0x55, 0x00],
  [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55],
  [0x55, 0x55, 0xff],
  [0x55, 0xff, 0x55],
  [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55],
  [0xff, 0x55, 0xff],
  [0xff, 0xff, 0x55],
  [0xff, 0xff, 0xff],
];

function assembleIndex(planeBitsInOrder) {
  let index = 0;
  for (let bit = 0; bit < 4; bit++) {
    if (planeBitsInOrder[PLANE_TO_INDEX_BIT[bit]]) index |= 1 << bit;
  }
  return index;
}

/**
 * Decode a masked EGA sprite/tile: one AND-mask bitplane followed by four OR-color bitplanes.
 * Returns an RGBA Uint8Array of width*height*4 bytes (width = widthBytes*8).
 */
export function decodeMaskedTile(buf, offset, widthBytes, heightRows, palette = EGA_PALETTE) {
  const width = widthBytes * 8;
  const planeSize = widthBytes * heightRows;
  const maskPlane = buf.subarray(offset, offset + planeSize);
  const colorPlanes = [
    buf.subarray(offset + planeSize, offset + planeSize * 2),
    buf.subarray(offset + planeSize * 2, offset + planeSize * 3),
    buf.subarray(offset + planeSize * 3, offset + planeSize * 4),
    buf.subarray(offset + planeSize * 4, offset + planeSize * 5),
  ];

  const rgba = new Uint8Array(width * heightRows * 4);
  for (let row = 0; row < heightRows; row++) {
    for (let col = 0; col < width; col++) {
      const byteIdx = row * widthBytes + (col >> 3);
      const bitMask = 0x80 >> (col & 7);
      const transparent = (maskPlane[byteIdx] & bitMask) !== 0;
      const pixelOffset = (row * width + col) * 4;
      if (transparent) {
        rgba[pixelOffset + 3] = 0;
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
 * Decode a full-screen EGA picture in the "direct" (no mask, opaque) format used by .pip files.
 * Returns an RGBA Uint8Array of (widthWords*16) x heightRows pixels.
 */
export function decodeDirectPicture(buf, offset, widthWords, heightRows, palette = EGA_PALETTE) {
  const width = widthWords * 16;
  const rgba = new Uint8Array(width * heightRows * 4);
  let src = offset;
  for (let row = 0; row < heightRows; row++) {
    for (let wordGroup = 0; wordGroup < widthWords; wordGroup++) {
      const planeBytes = [
        [buf[src], buf[src + 1]],
        [buf[src + 2], buf[src + 3]],
        [buf[src + 4], buf[src + 5]],
        [buf[src + 6], buf[src + 7]],
      ];
      src += 8;
      for (let bit = 0; bit < 16; bit++) {
        const byteInPair = bit >> 3;
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

/**
 * Decode an unmasked, directly-opaque EGA tile: N consecutive color bitplanes (no AND-mask
 * plane). This is `blocks*.pak`'s tile format (32x16, 4 planes, 120 tiles/file).
 * Returns an RGBA Uint8Array of width*height*4 bytes (width = widthBytes*8), fully opaque.
 */
export function decodeDirectTile(buf, offset, widthBytes, heightRows, palette = EGA_PALETTE) {
  const width = widthBytes * 8;
  const planeSize = widthBytes * heightRows;
  const rgba = new Uint8Array(width * heightRows * 4);
  for (let row = 0; row < heightRows; row++) {
    for (let col = 0; col < width; col++) {
      const byteIdx = row * widthBytes + (col >> 3);
      const bitMask = 0x80 >> (col & 7);
      const planeBits = [0, 1, 2, 3].map((p) => (buf[offset + p * planeSize + byteIdx] & bitMask ? 1 : 0));
      const [r, g, b] = palette[assembleIndex(planeBits)];
      const pixelOffset = (row * width + col) * 4;
      rgba[pixelOffset] = r;
      rgba[pixelOffset + 1] = g;
      rgba[pixelOffset + 2] = b;
      rgba[pixelOffset + 3] = 255;
    }
  }
  return rgba;
}
