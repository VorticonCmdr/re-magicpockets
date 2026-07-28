// RNC ProPack "method 1" decompressor.
//
// This is a line-by-line transliteration of GAMEU.EXE's Rnc_Depack (Ghidra: 1000:fcc4) and its
// helpers Rnc_GetBits (1000:fec2), Rnc_BuildHuffTable (1000:ff22) and Rnc_DecodeSymbol
// (1000:fe86), read from the x86 disassembly (not the decompiler's pseudo-C, which mangles the
// register-passed arguments and the bit-shift idioms into misleading fake globals). See
// docs/formats/rnc.md for the write-up of how each piece was derived.
//
// The original decompresses in-place inside a single 64K real-mode segment and spends real
// effort shuffling data to avoid the source/dest overlapping; none of that applies to a flat
// Node.js Buffer; we just decompress src -> a separate, correctly-sized dest buffer.

'use strict';

const RNC_HEADER_SIZE = 18;
const RNC_MAGIC = 0x434e52; // 'R','N','C' as read low-to-high (bytes 0-2), method byte (1) is byte 3

/**
 * Rotate a 16-bit value right by `count` bits (count 0..15).
 */
function ror16(value, count) {
  value &= 0xffff;
  count &= 15;
  if (count === 0) return value;
  return ((value >>> count) | (value << (16 - count))) & 0xffff;
}

/** Reverse the low `bits` bits of `value` (matches the RCR/RCL loop in Rnc_BuildHuffTable). */
function bitReverse(value, bits) {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (value & 1);
    value >>>= 1;
  }
  return result & 0xffff;
}

/**
 * Returns null if `input` doesn't start with the RNC method-1 signature ("RNC\x01").
 * Otherwise returns { data, unpackedLen, unpackedCrc, packedLen, packedCrc, leeway, numChunks }.
 * Throws on structurally malformed compressed data (shouldn't happen on genuine game files).
 */
function rncUnpack(input) {
  if (input.length < RNC_HEADER_SIZE) return null;
  if (!(input[0] === 0x52 && input[1] === 0x4e && input[2] === 0x43 && input[3] === 0x01)) {
    return null; // not "RNC\x01"
  }

  const unpackedLen = input.readUInt32BE(4);
  const packedLen = input.readUInt32BE(8);
  const unpackedCrc = input.readUInt16BE(12);
  const packedCrc = input.readUInt16BE(14);
  const leeway = input.readUInt8(16);
  const numChunks = input.readUInt8(17);

  const out = Buffer.alloc(unpackedLen);
  let outPos = 0;
  let si = RNC_HEADER_SIZE; // byte offset into `input`

  // --- bit reader state (mirrors CS:[0xfcbb]/[0xfcbd]/[0xfcc3] in the original) ---
  let fcbb = readWordSafe(input, si); // "current" 16-bit window, low bits = next bits to emit
  let fcbd = 0; // "reserve" word, not yet merged in
  let fcc3 = 0; // count of valid unconsumed bits currently sitting in fcbb

  function readWordSafe(buf, pos) {
    if (pos + 1 < buf.length) return buf.readUInt16LE(pos);
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
  // Table entries carry (mask, code, codeLen, classIndex) — classIndex is the symbol's 0-based
  // position in the code-length list as read, which doubles as the "value class" consumed by
  // Rnc_DecodeSymbol below (this is RNC's self-describing length/distance encoding).
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
          'wrong offset, or a table-building bug in tools/rnc.js)'
      );
    }
    // The first GetBits call only *advances the stream* past the matched Huffman code; its
    // result is discarded (Rnc_GetBits returns in AX, but Rnc_DecodeSymbol returns via CX,
    // which Rnc_GetBits's own prologue/epilogue (PUSH CX .. POP CX) preserves untouched across
    // the call — so the value actually returned for classIndex<2 is classIndex itself).
    getBits(entry.codeLen);
    if (entry.classIndex >= 2) {
      const n = entry.classIndex - 1;
      return getBits(n) | (1 << n);
    }
    return entry.classIndex;
  }

  // Re-sync the bit window after copying a run of raw (byte-aligned, not bit-packed) literal
  // bytes straight out of the compressed stream. Mirrors 1000:fded-fe13 exactly; note the
  // original does NOT touch `si` here (only the REP MOVSB that preceded it did).
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
    input.copy(out, outPos, si, si + len);
    outPos += len;
    si += len;
    resyncAfterLiteralCopy();
  }

  function copyMatch(len, dist) {
    // Byte-by-byte: distance can be smaller than length (self-overlapping runs), matching
    // REP MOVSB's forward-copy semantics.
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

/** CRC-16/ARC (poly 0xA001, reflected, init 0) — the classic "CRC-16" used by many DOS tools. */
function crc16arc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, not reflected). */
function crc16ccitt(buf, init = 0xffff) {
  let crc = init;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

module.exports = { rncUnpack, crc16arc, crc16ccitt, RNC_HEADER_SIZE };
