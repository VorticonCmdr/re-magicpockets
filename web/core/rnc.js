// RNC ProPack "method 1" decompressor -- isomorphic port of tools/rnc.js onto Uint8Array/DataView
// (no Node Buffer) so it runs unmodified in the browser. Algorithm and comments are unchanged
// from tools/rnc.js; see docs/formats/rnc.md for the derivation. Keep these two files in sync by
// hand -- this is a deliberate fork (Buffer -> Uint8Array/DataView), not a shared module, per
// docs/port-plan.md Phase 0's module-layout note.

'use strict';

const RNC_HEADER_SIZE = 18;

function ror16(value, count) {
  value &= 0xffff;
  count &= 15;
  if (count === 0) return value;
  return ((value >>> count) | (value << (16 - count))) & 0xffff;
}

function bitReverse(value, bits) {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (value & 1);
    value >>>= 1;
  }
  return result & 0xffff;
}

/**
 * Returns null if `input` (a Uint8Array) doesn't start with the RNC method-1 signature
 * ("RNC\x01"). Otherwise returns { data, unpackedLen, unpackedCrc, packedLen, packedCrc, leeway,
 * numChunks } where `data` is a Uint8Array.
 */
export function rncUnpack(input) {
  if (input.length < RNC_HEADER_SIZE) return null;
  if (!(input[0] === 0x52 && input[1] === 0x4e && input[2] === 0x43 && input[3] === 0x01)) {
    return null; // not "RNC\x01"
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const unpackedLen = view.getUint32(4, false);
  const packedLen = view.getUint32(8, false);
  const unpackedCrc = view.getUint16(12, false);
  const packedCrc = view.getUint16(14, false);
  const leeway = view.getUint8(16);
  const numChunks = view.getUint8(17);

  const out = new Uint8Array(unpackedLen);
  let outPos = 0;
  let si = RNC_HEADER_SIZE; // byte offset into `input`

  // --- bit reader state (mirrors CS:[0xfcbb]/[0xfcbd]/[0xfcc3] in the original) ---
  let fcbb = readWordSafe(input, si); // "current" 16-bit window, low bits = next bits to emit
  let fcbd = 0; // "reserve" word, not yet merged in
  let fcc3 = 0; // count of valid unconsumed bits currently sitting in fcbb

  function readWordSafe(buf, pos) {
    if (pos + 1 < buf.length) return buf[pos] | (buf[pos + 1] << 8);
    if (pos < buf.length) return buf[pos];
    return 0;
  }

  // Rnc_GetBits (1000:fec2): consume and return the next `n` bits (n = 0..16), LSB-first.
  function getBits(n) {
    const result = fcbb & ((1 << n) - 1);
    let workBB = fcbb;
    let workBD = fcbd;
    let useLen = n;
    let newCount;
    if (fcc3 < n) {
      const avail = fcc3;
      const mask = avail === 0 ? 0 : (1 << avail) - 1;
      const topBits = ror16(fcbd & mask, avail);
      workBB = ((fcbb >>> avail) | topBits) & 0xffff;
      si += 2;
      workBD = readWordSafe(input, si);
      useLen = n - avail;
      newCount = 16 - useLen;
    } else {
      newCount = fcc3 - n;
    }
    const mask2 = useLen === 0 ? 0 : (1 << useLen) - 1;
    const topBits2 = ror16(workBD & mask2, useLen);
    fcbb = ((workBB >>> useLen) | topBits2) & 0xffff;
    fcbd = (workBD >>> useLen) & 0xffff;
    fcc3 = newCount;
    return result;
  }

  // Rnc_BuildHuffTable (1000:ff22): reads a canonical Huffman table off the bitstream.
  function buildHuffTable() {
    const count = getBits(5);
    const table = [];
    if (count === 0) return table;
    const lengths = new Array(count);
    for (let i = 0; i < count; i++) lengths[i] = getBits(4);
    let code = 0; // running canonical code, left-justified in 16 bits
    let weight = 0x8000;
    for (let len = 1; len <= 16; len++) {
      for (let i = 0; i < count; i++) {
        if (lengths[i] === len) {
          const mask = (1 << len) - 1;
          const rightJustified = (code >>> (16 - len)) & mask;
          const reversed = bitReverse(rightJustified, len);
          table.push({ mask, code: reversed, codeLen: len, classIndex: i });
          code = (code + weight) & 0xffff;
        }
      }
      weight >>>= 1;
    }
    return table;
  }

  // Rnc_DecodeSymbol (1000:fe86): scan `table` for the entry whose (mask,code) matches the
  // current bit window, then read the value using the hybrid codeLen/classIndex scheme.
  function decodeSymbol(table) {
    let entry = null;
    for (const e of table) {
      if ((fcbb & e.mask) === e.code) {
        entry = e;
        break;
      }
    }
    if (!entry) {
      throw new Error(
        `RNC: no Huffman code matched bit window 0x${fcbb.toString(16)} (corrupt stream, ` +
          'wrong offset, or a table-building bug in web/core/rnc.js)'
      );
    }
    getBits(entry.codeLen);
    if (entry.classIndex >= 2) {
      const n = entry.classIndex - 1;
      return getBits(n) | (1 << n);
    }
    return entry.classIndex;
  }

  // Re-sync the bit window after copying a run of raw (byte-aligned, not bit-packed) literal
  // bytes straight out of the compressed stream. Mirrors 1000:fded-fe13 exactly; note the
  // original does NOT touch `si` here (only the byte copy that preceded it did).
  function resyncAfterLiteralCopy() {
    const keep = fcc3;
    const w0 = readWordSafe(input, si);
    const w1 = readWordSafe(input, si + 2);
    const mask = keep === 0 ? 0 : (1 << keep) - 1;
    const keptLowBits = fcbb & mask;
    const topBitsOfW0 = keep === 0 ? 0 : w0 >>> (16 - keep);
    const shiftedW0 = (w0 << keep) & 0xffff;
    const shiftedW1 = (w1 << keep) & 0xffff;
    fcbd = (shiftedW1 | topBitsOfW0) & 0xffff;
    fcbb = (keptLowBits | shiftedW0) & 0xffff;
    // fcc3 (bitCount) and si are intentionally left unchanged.
  }

  function copyLiteral(len) {
    if (len === 0) return;
    out.set(input.subarray(si, si + len), outPos);
    outPos += len;
    si += len;
    resyncAfterLiteralCopy();
  }

  function copyMatch(len, dist) {
    // Byte-by-byte: distance can be smaller than length (self-overlapping runs).
    for (let k = 0; k < len; k++) {
      out[outPos] = out[outPos - dist];
      outPos++;
    }
  }

  getBits(2); // one-time bootstrap: pulls the 2nd stream word into fcbd (result discarded)

  for (let chunk = 0; chunk < numChunks; chunk++) {
    const rawTable = buildHuffTable();
    const distTable = buildHuffTable();
    const lenTable = buildHuffTable();
    let count = getBits(16);

    copyLiteral(decodeSymbol(rawTable));
    count--;

    while (count > 0) {
      const distRaw = decodeSymbol(distTable);
      const lenRaw = decodeSymbol(lenTable);
      copyMatch(lenRaw + 2, distRaw + 1);
      copyLiteral(decodeSymbol(rawTable));
      count--;
    }
  }

  return { data: out, unpackedLen, unpackedCrc, packedLen, packedCrc, leeway, numChunks };
}

/** CRC-16/ARC (poly 0xA001, reflected, init 0) -- used to verify RNC's embedded checksum. */
export function crc16arc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

export { RNC_HEADER_SIZE };
