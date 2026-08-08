// The 14-call main loop driver (docs/engine.md), requestAnimationFrame-paced -- see
// docs/port-plan.md's "RESOLVED: frame/tick rate" note for why rAF (not the ~50.15Hz custom PIT
// timer) is the right analog for Video_WaitVsyncAndCountFrame's vsync busy-wait.
//
// Phase 2 wires up only the calls this phase's checkpoint needs; everything else is a named
// no-op placeholder so the call *order* (and the doc cross-reference) stays intact as later
// phases fill each one in for real. Numbers match docs/engine.md's table exactly.

'use strict';

import { Rng } from './rng.js';

const NOOP = () => {};

export class MainLoop {
  /**
   * @param {object} hooks - override any of the 14 calls by name (see docs/engine.md); anything
   *   not provided defaults to a no-op. `camera`/`input`/`render` are the Phase-2-active ones.
   */
  constructor(hooks = {}) {
    this.rng = new Rng();
    this.hooks = {
      cameraUpdateScroll: hooks.cameraUpdateScroll || NOOP, // 1
      levelUpdateAnimatedTiles: hooks.levelUpdateAnimatedTiles || NOOP, // 2
      gfxDrawObject: hooks.gfxDrawObject || NOOP, // 3
      videoFlipAndScroll: hooks.videoFlipAndScroll || NOOP, // 4
      fxUpdateTransition: hooks.fxUpdateTransition || NOOP, // 5
      levelUpdateEventQueue: hooks.levelUpdateEventQueue || NOOP, // 6
      demoPlaybackInput: hooks.demoPlaybackInput || NOOP, // 7
      entityUpdateAll: hooks.entityUpdateAll || NOOP, // 8
      demoRecordInput: hooks.demoRecordInput || NOOP, // 9
      debugHandleCheatInput: hooks.debugHandleCheatInput || NOOP, // 10
      inputReadState: hooks.inputReadState || NOOP, // 11
      hudUpdateScoreDisplay: hooks.hudUpdateScoreDisplay || NOOP, // 12
      // 13 Rng_NextValue is always real -- see this.rng below, not overridable as a no-op.
      videoWaitVsyncAndCountFrame: hooks.videoWaitVsyncAndCountFrame || NOOP, // 14
    };
    this.frameCount = 0;
    this._running = false;
    this._lastTime = 0;
    this._rafId = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._tick.bind(this));
  }

  stop() {
    this._running = false;
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _tick(now) {
    if (!this._running) return;
    const dtSeconds = Math.min((now - this._lastTime) / 1000, 0.1); // clamp huge gaps (tab backgrounded etc)
    this._lastTime = now;

    const h = this.hooks;
    h.cameraUpdateScroll(dtSeconds); // 1
    h.levelUpdateAnimatedTiles(dtSeconds); // 2
    h.gfxDrawObject(dtSeconds); // 3
    h.videoFlipAndScroll(dtSeconds); // 4
    h.fxUpdateTransition(dtSeconds); // 5
    h.levelUpdateEventQueue(dtSeconds); // 6
    h.demoPlaybackInput(dtSeconds); // 7
    h.entityUpdateAll(dtSeconds); // 8
    h.demoRecordInput(dtSeconds); // 9
    h.debugHandleCheatInput(dtSeconds); // 10
    h.inputReadState(dtSeconds); // 11
    h.hudUpdateScoreDisplay(dtSeconds); // 12
    this.rng.next(); // 13 Rng_NextValue
    h.videoWaitVsyncAndCountFrame(dtSeconds); // 14 (rAF itself is the vsync wait -- this hook is for post-frame bookkeeping)
    this.frameCount++;

    this._rafId = requestAnimationFrame(this._tick.bind(this));
  }
}
