// Rng_NextValue (1000:11fc) -- the game's per-frame PRNG, advanced exactly once per frame (main
// loop call #13, docs/engine.md). Direct instruction-level transliteration of the raw disassembly
// (the Ghidra decompile mangles this one badly -- register-only 8-bit rotate/XOR/shift chain, not
// worth reading as pseudo-C). See docs/engine.md's main-loop table for the call-site context.
//
// CAVEAT: the very first RCR AL,1 (1000:1207) consumes the CPU carry flag *as left by whatever
// instruction ran immediately before this function was called* -- the disassembly never sets it
// explicitly first. True bit-for-bit parity with the original's frame-by-frame RNG stream would
// require tracking CPU flags across the entire main loop, which is out of scope (this project's
// non-goals already exclude demo/replay-file compatibility, the only thing that would need exact
// parity). This port assumes carry-in = 0 at the start of every call, which still produces a
// full, well-mixed 16-bit LFSR-style stream -- just not one guaranteed identical to a real trace.

'use strict';

function rcr8(value, cf) {
  const bitOut = value & 1;
  const newValue = ((value >>> 1) | (cf << 7)) & 0xff;
  return [newValue, bitOut];
}

function rcl8(value, cf) {
  const newValue = ((value << 1) | cf) & 0xff;
  return newValue & 0xff;
}

export class Rng {
  constructor(seed = 0x1234) {
    this.state = seed & 0xffff; // mirrors [0x8b71]
    this.lastValue = 0; // mirrors [0x8b6b], this frame's output
  }

  /** Advance the LFSR by one step (call once per frame, like the original's call #13). */
  next() {
    let L = this.state & 0xff;
    let H = (this.state >>> 8) & 0xff;
    let DL = L;
    let CL = H;
    let AL = CL; // = H
    let cf = 0; // see CAVEAT above

    [AL, cf] = rcr8(AL, cf); // 1207
    CL = CL ^ AL; // 1209
    [AL, cf] = rcr8(AL, cf); // 120b
    [AL, cf] = rcr8(AL, cf); // 120d
    CL = CL ^ AL; // 120f
    [AL, cf] = rcr8(AL, cf); // 1211
    DL = DL ^ AL; // 1213
    [AL, cf] = rcr8(AL, cf); // 1215
    [AL, cf] = rcr8(AL, cf); // 1217
    AL = AL & 1; // 1219

    const dlBit7 = (DL >>> 7) & 1;
    DL = (DL << 1) & 0xff; // 121b SHL DL,1
    cf = dlBit7;

    CL = rcl8(CL, cf); // 121d RCL CL,1

    AL = (AL + DL) & 0xff; // 121f ADD AL,DL
    DL = AL; // 1221
    const AH = CL; // 1223
    AL = DL; // 1225

    this.state = ((AH << 8) | AL) & 0xffff;
    this.lastValue = this.state;
    return this.lastValue;
  }
}
