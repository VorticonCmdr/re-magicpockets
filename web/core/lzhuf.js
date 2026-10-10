// LZHUF (Okumura / Yoshizaki LZSS + adaptive Huffman) decoder: the compressor of KLOGOPOU.EXE's `LOGO*.HUF` resources
// (`Lzh_Decompress` CS:06FB, `Lzh_InitHuffmanTree` 0864, `Lzh_RebalanceHuffmanTree` 08C6, `Lzh_DecodeChar` 09A8, `Lzh_DecodePosition` 0A6A).
// `[STATIC]` structure read from the disassembly: the ring buffer is N = 4096 bytes pre-filled with 0x20 and starts at N - F = 0xFC4
// (CS:079B..07A5), the match length is `c - 253` (CS:080A `add ax,0xff03`) and the stream starts with a 4-byte little-endian size (CS:0769);
// `[PROVEN]` by the decoded picture matching the DOSBox video (tools/front-capture, group checkLogo of `npm run verify`).
// Pure function over Uint8Array: no fs, no Buffer.

'use strict';

const N = 4096, F = 60, THRESHOLD = 2, N_CHAR = 256 - THRESHOLD + F, T = N_CHAR * 2 - 1, R = T - 1, MAX_FREQ = 0x8000;

// position code tables: 64 prefix codes whose bit lengths are 3 (1 code), 4 (3), 5 (8), 6 (12), 7 (24), 8 (16); a code of length L owns 2^(8-L) bytes
const D_CODE = new Uint8Array(256), D_LEN = new Uint8Array(256);
{
  let code = 0, pos = 0;
  for (const [codes, len] of [[1, 3], [3, 4], [8, 5], [12, 6], [24, 7], [16, 8]]) {
    for (let c = 0; c < codes; c++, code++) for (let k = 0; k < (1 << (8 - len)); k++) { D_CODE[pos] = code; D_LEN[pos] = len; pos++; }
  }
}

/** Decode `src` from `start` (the 4-byte size, then the bit stream). Returns `{ data, end }` with `end` = the next unread source offset. */
export function lzhufDecode(src, start = 0) {
  const size = (src[start] | (src[start + 1] << 8) | (src[start + 2] << 16) | (src[start + 3] << 24)) >>> 0;
  let ip = start + 4, bitBuf = 0, bitLen = 0;
  const getBit = () => {
    if (bitLen === 0) { bitBuf = ip < src.length ? src[ip++] : 0; bitLen = 8; }
    bitLen--; return (bitBuf >> bitLen) & 1;
  };
  const getByte = () => { let v = 0; for (let i = 0; i < 8; i++) v = (v << 1) | getBit(); return v; };
  const freq = new Uint32Array(T + 1), prnt = new Uint32Array(T + N_CHAR), son = new Uint32Array(T);
  for (let i = 0; i < N_CHAR; i++) { freq[i] = 1; son[i] = i + T; prnt[i + T] = i; }
  for (let i = 0, j = N_CHAR; j <= R; i += 2, j++) { freq[j] = freq[i] + freq[i + 1]; son[j] = i; prnt[i] = prnt[i + 1] = j; }
  freq[T] = 0xffff; prnt[R] = 0;
  const reconst = () => {
    let j = 0;
    for (let i = 0; i < T; i++) if (son[i] >= T) { freq[j] = (freq[i] + 1) >> 1; son[j] = son[i]; j++; }
    for (let i = 0, jj = N_CHAR; jj < T; i += 2, jj++) {
      let k = i + 1; const f = freq[jj] = freq[i] + freq[k];
      for (k = jj - 1; f < freq[k]; k--);
      k++;
      for (let m = jj; m > k; m--) { freq[m] = freq[m - 1]; son[m] = son[m - 1]; }
      freq[k] = f; son[k] = i;
    }
    for (let i = 0; i < T; i++) { const k = son[i]; if (k >= T) prnt[k] = i; else prnt[k] = prnt[k + 1] = i; }
  };
  const update = (c0) => {
    if (freq[R] === MAX_FREQ) reconst();
    let c = prnt[c0 + T];
    do {
      const k = ++freq[c];
      let l = c + 1;
      if (k > freq[l]) {
        while (k > freq[++l]);
        l--;
        freq[c] = freq[l]; freq[l] = k;
        const i = son[c]; prnt[i] = l; if (i < T) prnt[i + 1] = l;
        const j = son[l]; son[l] = i; prnt[j] = c; if (j < T) prnt[j + 1] = c;
        son[c] = j; c = l;
      }
    } while ((c = prnt[c]) !== 0);
  };
  const decodeChar = () => { let c = son[R]; while (c < T) c = son[c + getBit()]; c -= T; update(c); return c; };
  const decodePosition = () => {
    let i = getByte(); const c = D_CODE[i] << 6; let j = D_LEN[i] - 2;
    while (j-- > 0) i = (i << 1) + getBit();
    return c | (i & 0x3f);
  };

  const out = new Uint8Array(size), buf = new Uint8Array(N).fill(0x20);
  let r = N - F, n = 0;
  while (n < size) {
    const c = decodeChar();
    if (c < 256) { out[n++] = c; buf[r++] = c; r &= N - 1; }
    else {
      const i = (r - decodePosition() - 1) & (N - 1), j = c - 255 + THRESHOLD;
      for (let k = 0; k < j && n < size; k++) { const v = buf[(i + k) & (N - 1)]; out[n++] = v; buf[r++] = v; r &= N - 1; }
    }
  }
  return { data: out, end: ip };
}
