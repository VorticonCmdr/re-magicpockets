// Fixed-timestep logic clock. Adapted from gods-web's src/engine/clock.js.
//
// The logic rate is a parameter, not a recovered constant: the original runs one main-loop
// iteration per retrace-aligned frame and its real rate varies with CPU speed (see
// docs/open-questions-history.md item 2). Replays and parity are indexed by iteration, never by
// wall-clock time, so the only effect of `tickHz` is how fast the port plays in a browser.

'use strict';

import { DEFAULT_TICK_HZ } from './frame.js';

export class Clock {
  /**
   * @param {() => void} onTick one main-loop iteration
   * @param {object} [opts]
   * @param {number} [opts.tickHz] iterations per second
   * @param {() => void} [opts.onRender] called once per animation frame, after the ticks
   */
  constructor(onTick, { tickHz = DEFAULT_TICK_HZ, onRender = null } = {}) {
    this.onTick = onTick;
    this.onRender = onRender;
    this.tickMs = 1000 / tickHz;
    this.acc = 0;
    this.last = 0;
    this.ticks = 0;
    this.running = false;
    this._raf = null;
  }

  /** Run `n` iterations immediately (headless/debug); does not touch the accumulator. */
  step(n = 1) {
    for (let i = 0; i < n; i++) { this.onTick(); this.ticks++; }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now) => {
      if (!this.running) return;
      let dt = now - this.last;
      this.last = now;
      if (dt > 250) dt = 250; // a backgrounded tab must not spiral
      this.acc += dt;
      while (this.acc >= this.tickMs) {
        this.onTick();
        this.ticks++;
        this.acc -= this.tickMs;
      }
      if (this.onRender) this.onRender();
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
}
