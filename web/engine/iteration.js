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
import { hudUpdateScoreDisplay, fxUpdateTransition } from './hud.js';
import { levelUpdateAnimatedTiles } from './tiles.js';

const G = { INPUT_A: 0x8b67, INPUT_B: 0x8b68, KEY_A: 0x8b5d, KEY_B: 0x8b58, FREEZE: 0x8ba1, DEMO_FLAG: 0x8baa,
  TAPE_STATE: 0x8ba9, TAPE_LEFT: 0x8ba8, TAPE_PTR: 0x8ba6, RNG_STATE: 0x8b71, RNG_OUT: 0x8b6b };

/**
 * The carry flag call #13 sees: the flags Hud_UpdateScoreDisplay (1000:0B92) leaves `[STATIC]`, found live because every row of a
 * world 3 sea level / world 4 capture advances the generator by a carry-0 step. It returns through 1000:0C6D after `cmp [8C33],0`
 * (carry 0), or after `cmp [8B89],3` (carry 1 below world 3, 0 in world 4), or, in world 3, after `cmp [8B8B],8` (carry 1 below sub-level 8).
 */
export function call13Carry(m) {
  if (m.u8(0x8c33) !== 0) return 0;
  const world = m.u16(0x8b89);
  if (world < 3) return 1;
  if (world === 3) return m.u16(0x8b8b) < 8 ? 1 : 0;
  return 0;
}

/** Call #13, Rng_NextValue, with the carry the HUD routine leaves (see call13Carry). */
export function rngNext(m) {
  const rng = new Rng(m.u16(G.RNG_STATE));
  const v = rng.next(call13Carry(m));
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
  // 1000:77C0: the scroll-mode word [8C34]. 0 draws normally, a negative value skips the redraw, 0x63 and
  // 0x16 start the palette routines (not modelled); any other positive value requests one full redraw and
  // is consumed.
  const mode = m.s16(0x8c34);
  if (mode > 0 && mode !== 0x63 && mode !== 0x16) m.w16(0x8c34, 0xffff);
}

/** An extra Rng_NextValue call from elsewhere in the code, with an explicit carry-in. */
function rngWithCarry(m, carry) {
  const rng = new Rng(m.u16(G.RNG_STATE));
  const v = rng.next(carry);
  m.w16(G.RNG_OUT, v);
  m.w16(G.RNG_STATE, v);
}

export function stepIteration(m, ctx, only = null) {
  m.sound = ctx.sound || null; // sound requests (1CCF/1D4C/1DAE) reach `ctx.sound(id, kind)` through `m`; absent = no-op, touches no DS byte
  ctx.rng = rngWithCarry;
  ctx.modalWait = false;
  // Call 6 of the previous iteration comes after the capture sample (calls 1-3) and before this
  // iteration's call 7, so it opens the step.
  fxUpdateTransition(m, ctx); // call 5
  levelUpdateEventQueue(m, ctx); // call 6
  demoPlaybackInput(m); // call 7
  updateAll(m, ctx, only); // call 8
  hudUpdateScoreDisplay(m, ctx); // call 12 (calls 9-11 only read input hardware)
  rngNext(m); // call 13
  cameraUpdateScroll(m); // call 1 of the next iteration
  levelUpdateAnimatedTiles(m, ctx); // call 2
  renderConsumes(m); // call 3: the capture sample is taken after it
}

/**
 * One iteration from a state sampled right after call #13 (the live-play capture's sample point,
 * tools/attract-capture/capture-live.lua) to the next such state: calls 1-3 of the next
 * iteration, then 5-8, 12 and 13. Input comes from the key bytes [8B5D]/[8B58] that call #7 copies.
 */
export function stepIterationAfterRng(m, ctx, only = null) {
  m.sound = ctx.sound || null;
  ctx.rng = rngWithCarry;
  ctx.modalWait = false;
  cameraUpdateScroll(m); // call 1
  levelUpdateAnimatedTiles(m, ctx); // call 2
  renderConsumes(m); // call 3
  fxUpdateTransition(m, ctx); // call 5
  levelUpdateEventQueue(m, ctx); // call 6
  demoPlaybackInput(m); // call 7
  updateAll(m, ctx, only); // call 8
  if (ctx.levelStart || ctx.gameRestart || ctx.modalWait) return; // opcode 38 waiting for a key / opcode 37 / the game restart (2D20, 2D4F) left the main loop: calls 12 and 13 never run
  hudUpdateScoreDisplay(m, ctx); // call 12
  rngNext(m); // call 13
}
