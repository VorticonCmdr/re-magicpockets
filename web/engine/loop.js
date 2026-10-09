// The 14-call main loop driver (docs/engine.md), one fixed-step iteration per tick.
//
// Order comes from frame.js's FRAME_ORDER (matched against the live loop in DOSBox); this class
// only iterates it. Any call without a hook is a named no-op, so the order stays intact while
// individual calls are ported for real. Call 13 (Rng_NextValue) is always real.

'use strict';

import { Rng } from './rng.js';
import { FRAME_ORDER, DEFAULT_TICK_HZ } from './frame.js';
import { Clock } from './clock.js';

const NOOP = () => {};

export class MainLoop {
  /**
   * @param {object} hooks - override any call by its FRAME_ORDER `hook` name.
   * @param {object} [opts]
   * @param {number} [opts.tickHz] logic iterations per second (a port choice, see frame.js)
   * @param {number} [opts.rngSeed] initial Rng_NextValue state
   */
  constructor(hooks = {}, { tickHz = DEFAULT_TICK_HZ, rngSeed } = {}) {
    this.rng = rngSeed === undefined ? new Rng() : new Rng(rngSeed);
    this.hooks = {};
    for (const call of FRAME_ORDER) {
      if (call.hook === 'rngNext') continue;
      this.hooks[call.hook] = hooks[call.hook] || NOOP;
    }
    this.frameCount = 0;
    this.clock = new Clock(() => this.tick(), { tickHz });
  }

  /** One main-loop iteration: all 14 calls in FRAME_ORDER. */
  tick() {
    for (const call of FRAME_ORDER) {
      if (call.hook === 'rngNext') this.rng.next();
      else this.hooks[call.hook]();
    }
    this.frameCount++;
  }

  /** Headless/debug: run n iterations right now. */
  step(n = 1) { this.clock.step(n); }

  start() { this.clock.start(); }

  stop() { this.clock.stop(); }
}
