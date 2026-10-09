// Rng_NextValue (1000:11fc) -- the game's PRNG, advanced once per main-loop iteration (call #13,
// docs/engine.md) and occasionally from other call sites. Instruction-level transliteration of
// the disassembly (register-only 8-bit rotate/XOR/shift chain).
//
// Two properties are `[PROVEN]` against a live DOSBox capture of the attract demo (1154
// consecutive iterations, tools/attract-capture/, 2026-10-09):
//   1. Every x86 XOR clears the carry flag, so each RCR that follows an XOR starts with carry 0.
//      An earlier version of this file chained the carry straight through the XORs and could not
//      reproduce a single real value.
//   2. The carry the FIRST `rcr al,1` (1000:1207) consumes is whatever the caller left in CF. At
//      the main loop's call #13 it was 1 on every one of the 1111 transitions that were a single
//      step, and never 0. So next() defaults to carryIn = 1.
// 43 of the 1154 observed transitions advanced the state more than once between two iteration
// samples: something else calls this function too (not identified; ledger item 13).

'use strict';

function rcr8(value, cf) {
  return [((value >>> 1) | (cf << 7)) & 0xff, value & 1];
}

export class Rng {
  constructor(seed = 0x1234) {
    this.state = seed & 0xffff; // mirrors [0x8b71]
    this.lastValue = 0; // mirrors [0x8b6b], the last output
  }

  /** Advance the generator one step. `carryIn` is the CF the caller leaves (1 at call #13). */
  next(carryIn = 1) {
    let DL = this.state & 0xff;
    let CL = (this.state >>> 8) & 0xff;
    let AL = CL;
    let cf = carryIn;

    [AL, cf] = rcr8(AL, cf); // 1207
    CL ^= AL; cf = 0; // 1209 xor clears CF
    [AL, cf] = rcr8(AL, cf); // 120b
    [AL, cf] = rcr8(AL, cf); // 120d
    CL ^= AL; cf = 0; // 120f
    [AL, cf] = rcr8(AL, cf); // 1211
    DL ^= AL; cf = 0; // 1213
    [AL, cf] = rcr8(AL, cf); // 1215
    [AL, cf] = rcr8(AL, cf); // 1217
    AL &= 1; // 1219

    const dlBit7 = (DL >>> 7) & 1;
    DL = (DL << 1) & 0xff; // 121b SHL DL,1 -> CF = old bit 7
    CL = ((CL << 1) | dlBit7) & 0xff; // 121d RCL CL,1

    AL = (AL + DL) & 0xff; // 121f ADD AL,DL
    this.state = ((CL << 8) | AL) & 0xffff;
    this.lastValue = this.state;
    return this.lastValue;
  }
}
