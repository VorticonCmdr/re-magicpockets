// The main loop's per-iteration call order, as code a check can drive.
//
// Addresses are Ghidra-static (1000:xxxx) and were matched `[PROVEN]` against the live loop in
// DOSBox on 2026-10-09: the demo starter's copy of the loop (live CS 0x1F5, offsets 0x55-0x7A)
// does `mov [89F6],0`, `mov cs:[2085],3`, makes exactly these 14 calls in this order, then jumps
// back. `FRAME_ORDER` is what MainLoop iterates, so `tools/scope-check.mjs` and verify can assert
// the order without parsing a hand-written call sequence.
//
// One iteration of this list is one logic tick. The original's only pacing is call 14's single
// retrace wait, so its real rate is 70.086 Hz / a whole number of retraces (about 17 Hz when
// measured); see docs/open-questions-history.md item 2. TICK_HZ below is a PORT display choice,
// not a recovered constant.

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

/** Default logic rate for the browser: VSYNC_HZ / 4, close to the ~17 Hz measured live. */
export const DEFAULT_TICK_HZ = VSYNC_HZ / 4;
