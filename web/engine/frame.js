// The main loop's per-iteration call order, as code a check can drive.
//
// Addresses are Ghidra-static (1000:xxxx) and were matched `[PROVEN]` against the live loop in
// DOSBox on 2026-10-09: the demo starter's copy of the loop (live CS 0x1F5, offsets 0x55-0x7A)
// does `mov [89F6],0`, `mov cs:[2085],3`, makes exactly these 14 calls in this order, then jumps
// back. `FRAME_ORDER` is what MainLoop iterates, so `tools/scope-check.mjs` and verify can assert
// the order without parsing a hand-written call sequence.
//
// One iteration of this list is one logic tick. Its pacing is three timer ticks of the game's own PIT
// reprogramming (see DEFAULT_TICK_HZ below) with call 14's retrace wait aligning the end;
// docs/open-questions-history.md item 2.

'use strict';

export const FRAME_ORDER = [
  { n: 1, hook: 'cameraUpdateScroll', fn: 'Camera_UpdateScroll', addr: '1000:0221' },
  { n: 2, hook: 'levelUpdateAnimatedTiles', fn: 'Level_UpdateAnimatedTiles', addr: '1000:02a3' },
  { n: 3, hook: 'gfxDrawObject', fn: 'Gfx_RenderVisibleEntities', addr: '1000:73a5' },
  { n: 4, hook: 'videoFlipAndScroll', fn: 'Video_FlipAndScroll', addr: '1000:154a' },
  { n: 5, hook: 'fxUpdateTransition', fn: 'Fx_UpdateTransition', addr: '1000:1028' },
  { n: 6, hook: 'levelUpdateEventQueue', fn: 'Level_UpdateEventQueue', addr: '1000:c28f' },
  { n: 7, hook: 'demoPlaybackInput', fn: 'Demo_PlaybackInput', addr: '1000:0159' },
  { n: 8, hook: 'entityUpdateAll', fn: 'Entity_UpdateAll', addr: '1000:c91d' },
  { n: 9, hook: 'demoRecordInput', fn: 'Demo_RecordInput', addr: '1000:01d9' },
  { n: 10, hook: 'debugHandleCheatInput', fn: 'Debug_HandleCheatInput', addr: '1000:088d' },
  { n: 11, hook: 'inputReadState', fn: 'Input_ReadState', addr: '1000:18a4' },
  { n: 12, hook: 'hudUpdateScoreDisplay', fn: 'Hud_UpdateScoreDisplay', addr: '1000:0b92' },
  { n: 13, hook: 'rngNext', fn: 'Rng_NextValue', addr: '1000:11fc' },
  { n: 14, hook: 'videoWaitVsyncAndCountFrame', fn: 'Video_WaitVsyncAndCountFrame', addr: '1000:0142' },
];

/** Nominal vsync rate of the 320x200 16-colour mode DOSBox emulates (70.086 Hz). */
export const VSYNC_HZ = 70.086;

/** The PC's PIT input clock. */
export const PIT_HZ = 1193182;

/**
 * The game reprograms PIT channel 0 (1000:2047: `mov al,36h / out 43h` then `mov al,0ECh / out 40h` and
 * `mov al,5Ch / out 40h`) to a 0x5CEC divisor `[STATIC]`, and its timer ISR (installed with int 21h/25h at
 * 1000:2056, handler 1000:2092) decrements `cs:[2085]` once per tick `[STATIC]`. The main loop sets
 * `cs:[2085] = 3` every iteration (1000:010B) and the pel-pan routine (1000:1605) waits for it to reach 0, so one
 * iteration takes at least 3 timer ticks `[STATIC]`: 1193182 / 23788 / 3 = 16.72 Hz, which agrees with the
 * 16.9 +/- 0.4 calls per second measured live `[PROVEN]` (ledger item 2). The final retrace wait (call 14) can
 * add up to one retrace period; whether it does in practice is the residual uncertainty (about 1%).
 */
export const PIT_DIVISOR = 0x5cec;
export const TICKS_PER_ITERATION = 3;
export const DEFAULT_TICK_HZ = PIT_HZ / PIT_DIVISOR / TICKS_PER_ITERATION;
