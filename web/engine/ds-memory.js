// A 64 KB image of GAMEU.EXE's data segment, addressed by the same DS-relative offsets the
// disassembly uses, so ported code can be a line-by-line transliteration (`[si+0x6]` becomes
// `m.w16(si + 6)`). Initialized from the EXE (static tables, scripts) and overlaid with captured
// or live state.

'use strict';

import { DS_FILE_OFFSET } from '../core/exe-data.js';

export const DS_SIZE = 0x10000;
export const ENTITY_SIZE = 0x42;
export const ENTITY_ARRAY = 0x9090; // pointer array, 140 slots, 0 = empty
export const ENTITY_ARRAY_END = 0x91a8;
export const VISIBLE_LIST = 0x91be; // rebuilt every frame, terminated by 0xFFFF

export class DsMemory {
  /** @param {Uint8Array} exeBytes the whole GAMEU.EXE */
  constructor(exeBytes) {
    this.b = new Uint8Array(DS_SIZE);
    const avail = Math.min(DS_SIZE, exeBytes.length - DS_FILE_OFFSET);
    this.b.set(exeBytes.subarray(DS_FILE_OFFSET, DS_FILE_OFFSET + avail));
  }

  clone() { const m = Object.create(DsMemory.prototype); m.b = this.b.slice(); return m; }

  u8(o) { return this.b[o & 0xffff]; }

  s8(o) { const v = this.b[o & 0xffff]; return v > 127 ? v - 256 : v; }

  w8(o, v) { this.b[o & 0xffff] = v & 0xff; }

  u16(o) { return this.b[o & 0xffff] | (this.b[(o + 1) & 0xffff] << 8); }

  s16(o) { const v = this.u16(o); return v >= 0x8000 ? v - 0x10000 : v; }

  w16(o, v) { this.b[o & 0xffff] = v & 0xff; this.b[(o + 1) & 0xffff] = (v >> 8) & 0xff; }

  /** Copy `bytes` to DS:`o`. */
  put(o, bytes) { this.b.set(bytes, o); }

  get(o, n) { return this.b.subarray(o, o + n); }
}

const BLOCK_START = 0x9398;
const BLOCK_END = 0xb918;

/** 1000:C18C. First entity record in the block whose class (+2) equals `cls`, or 0. */
export function findByClass(m, cls) {
  for (let bx = BLOCK_START; bx < BLOCK_END; bx += ENTITY_SIZE) if (m.u16(bx + 2) === cls) return bx;
  return 0;
}
