// Fx_UpdateTransition/Fx_TransitionStep equivalent (docs/engine.md, docs/memory-map.md's
// "Palette setting" section): the original fades between levels by walking `[0x8ba2]` through a
// 24-bank palette table once per frame and re-applying the VGA DAC registers -- a 4-bit-per-
// channel palette animation, not a pixel effect. This port has no palette hardware to animate (the
// decoded tiles are already full RGBA), so this is a plain black-alpha canvas overlay fade instead
// -- the same NARRATIVE effect (screen fades to black, next level fades in) via a completely
// different mechanism. Not a port of the real 24-bank fade table.

'use strict';

const FADE_FRAMES = 30; // ~0.5s at 60fps, placeholder

export class Transition {
  constructor() {
    this.state = 'idle'; // 'idle' | 'out' | 'in'
    this.t = 0;
    this.onMidpoint = null; // called once, at full-black, to swap level content
  }

  start(onMidpoint) {
    this.state = 'out';
    this.t = 0;
    this.onMidpoint = onMidpoint;
  }

  get active() {
    return this.state !== 'idle';
  }

  /** Advances one frame. Returns the current black-overlay alpha (0-1). */
  tick() {
    if (this.state === 'idle') return 0;
    this.t++;
    if (this.state === 'out') {
      if (this.t >= FADE_FRAMES) {
        this.onMidpoint?.();
        this.onMidpoint = null;
        this.state = 'in';
        this.t = 0;
        return 1;
      }
      return this.t / FADE_FRAMES;
    }
    // 'in'
    if (this.t >= FADE_FRAMES) {
      this.state = 'idle';
      this.t = 0;
      return 0;
    }
    return 1 - this.t / FADE_FRAMES;
  }
}
