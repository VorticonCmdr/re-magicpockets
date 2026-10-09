// Read-only view of GAMEU.EXE's initialized data segment.
//
// The port never embeds game data tables: like gods-web it reads them from the user's own
// `game/GAMEU.EXE` (served by the dev server or picked with the folder picker). Offsets here are
// the DS-relative addresses used throughout docs/ (`[0xcd88]`, `DS:0xEFA5`, ...).
//
// DS_FILE_OFFSET is the file offset of DS:0000. `[PROVEN]` by `npm run verify`: the per-world
// ground tables found at DS:0xEFA5/0xF097/0xF189 are byte-identical to the live DOSBox dump and
// sit at exactly these file offsets (world 3's at 447225 = DS_FILE_OFFSET + 0xF189). The code
// segment `1000:xxxx` starts at file offset 0x340 (the MZ header size).

'use strict';

export const DS_FILE_OFFSET = 447225 - 0xf189; // 385392 = 0x5E230
export const CODE_FILE_OFFSET = 0x340;
export const EXE_SIZE = 450130;

export class ExeData {
  /** @param {Uint8Array} bytes the whole GAMEU.EXE file */
  constructor(bytes) {
    if (bytes.length !== EXE_SIZE) throw new Error(`GAMEU.EXE must be ${EXE_SIZE} bytes (got ${bytes.length}); this is the unpacked game executable`);
    this.bytes = bytes;
  }

  u8(ds) { return this.bytes[DS_FILE_OFFSET + ds]; }

  s8(ds) { const v = this.u8(ds); return v > 127 ? v - 256 : v; }

  u16(ds) { return this.u8(ds) | (this.u8(ds + 1) << 8); }

  s16(ds) { const v = this.u16(ds); return v >= 0x8000 ? v - 0x10000 : v; }

  slice(ds, length) { return this.bytes.subarray(DS_FILE_OFFSET + ds, DS_FILE_OFFSET + ds + length); }

  /** Code-segment bytes at a Ghidra `1000:offset` address. */
  code(offset, length) { return this.bytes.subarray(CODE_FILE_OFFSET + offset, CODE_FILE_OFFSET + offset + length); }
}
