// One main-loop iteration over a DsMemory image, as far as it has been ported.
//
// The port is built one function at a time and checked by tools/attract-capture/conformance.mjs,
// which loads a DOSBox capture row into a DsMemory, runs `stepIteration`, and diffs the result
// against the next captured row. Anything not ported here simply does not change memory, so the
// harness's mismatch histogram is the to-do list.
//
// Sampling note (see tools/attract-capture/capture-full.lua): a captured row is the state after
// call #8 (Entity_UpdateAll) and before the next call #7, so one transition covers calls 9-14 of
// the previous iteration and calls 1-8 of the next one. Only the parts that change the sampled
// state matter: call #13 (RNG), #7 (demo input) and #8 (entity update).

'use strict';

import { Rng } from './rng.js';

import { updateAll, cameraUpdateScroll } from './entity-behavior.js';
import { levelUpdateEventQueue } from './spawn.js';
import { hudUpdateScoreDisplay } from './hud.js';

const G = { INPUT_A: 0x8b67, INPUT_B: 0x8b68, KEY_A: 0x8b5d, KEY_B: 0x8b58, FREEZE: 0x8ba1, DEMO_FLAG: 0x8baa,
  TAPE_STATE: 0x8ba9, TAPE_LEFT: 0x8ba8, TAPE_PTR: 0x8ba6, RNG_STATE: 0x8b71, RNG_OUT: 0x8b6b };

/** Call #13, Rng_NextValue, with the main loop's carry-in of 1. */
export function rngNext(m) {
  const rng = new Rng(m.u16(G.RNG_STATE));
  const v = rng.next(1);
  m.w16(G.RNG_OUT, v);
  m.w16(G.RNG_STATE, v);
}

/** Call #7, Demo_PlaybackInput (1000:0159), exactly, reading the tape from memory at [8BA6]. */
export function demoPlaybackInput(m) {
  m.w8(G.INPUT_A, m.u8(G.KEY_A));
  m.w8(G.INPUT_B, m.u8(G.KEY_B));
  if (m.u8(G.FREEZE) === 0x45) return;
  if (m.s8(G.DEMO_FLAG) <= 0) return;
  const state = m.u8(G.TAPE_STATE);
  m.w8(G.INPUT_B, state);
  m.w8(G.INPUT_A, state);
  const left = (m.u8(G.TAPE_LEFT) - 1) & 0xff;
  if (left !== 0) { m.w8(G.TAPE_LEFT, left); return; }
  const bx = (m.u16(G.TAPE_PTR) + 2) & 0xffff;
  const next = m.u16(bx);
  if (next === 0xffff) return; // end of tape: the original leaves through 1000:5267
  m.w16(G.TAPE_LEFT, next); // count in [8BA8], state in [8BA9]
  m.w16(G.TAPE_PTR, bx);
}

/**
 * One transition between two captured samples. A sample is taken after call #1 of the NEXT
 * iteration, so the transition is calls 7 and 8, then 13, then the next call #1 (calls 2-6, 9-12
 * and 14 are not ported).
 * @param {import('./ds-memory.js').DsMemory} m
 * @param {{unported:Set<string>, events:any[]}} ctx
 * @param {Set<number>|null} only entity pointers allowed to run (staged porting)
 */
/** Call #3 (1000:73A5): drawing the weapon overlay consumes [8C38]; nothing else it does is sampled. */
export function renderConsumes(m) {
  if (m.u16(0x8c38) !== 0) m.w16(0x8c38, 0);
}

/** An extra Rng_NextValue call from elsewhere in the code, with an explicit carry-in. */
function rngWithCarry(m, carry) {
  const rng = new Rng(m.u16(G.RNG_STATE));
  const v = rng.next(carry);
  m.w16(G.RNG_OUT, v);
  m.w16(G.RNG_STATE, v);
}

export function stepIteration(m, ctx, only = null) {
  ctx.rng = rngWithCarry;
  // Call 6 of the previous iteration comes after the capture sample (calls 1-3) and before this
  // iteration's call 7, so it opens the step.
  levelUpdateEventQueue(m, ctx);
  demoPlaybackInput(m); // call 7
  updateAll(m, ctx, only); // call 8
  hudUpdateScoreDisplay(m, ctx); // call 12 (calls 9-11 only read input hardware)
  rngNext(m); // call 13
  cameraUpdateScroll(m); // call 1 of the next iteration
  renderConsumes(m); // call 3: the capture sample is taken after it
}
