// A 64-bit (two interleaved 32-bit FNV-1a) fingerprint of a byte range: how the committed DOSBox reference captures (tools/front-capture/
// prelude.capture.json.gz) identify a whole 320 x 200 RGB frame. Not cryptographic; it only has to tell different frames apart.

'use strict';

export function fnv64(buf, o = 0, len = buf.length - o) {
  let a = 0x811c9dc5, b = 0x84222325;
  for (let i = 0; i < len; i++) { const v = buf[o + i]; a = Math.imul(a ^ v, 0x01000193) >>> 0; b = Math.imul(b ^ v, 0x01000193 + 0x9e) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
