// AdLib sound for the port: the original driver (web/audio/pin-driver.js: data/player.pin code + the data/adlib.pin
// cue bank, run on web/audio/x86-lite.js) produces the OPL2 register stream; web/audio/opl2-chip.js turns it into
// samples. `AdlibPlayer` is pure/testable (no WebAudio): `render(out, n)` advances the driver at its tick rate
// (TICK_HZ = 50.159 Hz, one `tick()` per timer IRQ, docs/formats/pin-sound.md) and the chip at 49716 Hz and
// resamples to the output rate. `startWebAudio(player)` wraps it in a ScriptProcessorNode.
//
// The register stream is `[PROVEN]` against DOSBox (tools/adlib-capture/, `npm run verify`); the chip model is an
// approximation (see opl2-chip.js), so timbre is close, not bit-exact.

import { PinDriver, TICK_HZ } from './pin-driver.js';
import { Opl2, OPL_RATE } from './opl2-chip.js';

export class AdlibPlayer {
  /**
   * @param {Uint8Array} playerBytes depacked data/player.pin
   * @param {Uint8Array} bankBytes depacked data/adlib.pin
   * @param {number} outRate output sample rate
   * @param {(reg:number,val:number)=>void} [tap] optional observer of every register write
   */
  constructor(playerBytes, bankBytes, outRate = 44100, tap = null) {
    this.chip = new Opl2(OPL_RATE);
    this.outRate = outRate;
    this.drv = new PinDriver(playerBytes, bankBytes, (reg, val) => { this.chip.write(reg, val); if (tap) tap(reg, val); });
    this.drv.init();
    this.tickAcc = 0; // fractional driver ticks
    this.chipAcc = 0; // fractional chip samples
    this.last = 0; this.cur = 0; // linear resampling state
    this.ticks = 0;
    this.gain = 3;
  }
  /** 1000:1CCF (AH=1, AL=cue id). */
  trigger(id) { this.drv.play(id); }
  /** 1000:1D4C: stop one cue. */
  stop(id) { this.drv.stop(id); }
  /** 1000:1DAE: stop everything. */
  stopAll() { this.drv.stopAll(); }
  /** Hook for `ctx.sound(id, kind)` (web/engine/iteration.js). */
  sink = (id, kind) => { if (kind === 'stop') this.stop(id); else if (kind === 'stopAll') this.stopAll(); else this.trigger(id); };
  render(out, n) {
    const tickPerSample = TICK_HZ / this.outRate;
    const chipPerSample = OPL_RATE / this.outRate;
    for (let i = 0; i < n; i++) {
      this.tickAcc += tickPerSample;
      while (this.tickAcc >= 1) { this.tickAcc -= 1; this.drv.tick(); this.ticks++; }
      this.chipAcc += chipPerSample;
      while (this.chipAcc >= 1) { this.chipAcc -= 1; this.last = this.cur; this.cur = this.chip.sample(); }
      out[i] = (this.last + (this.cur - this.last) * this.chipAcc) * this.gain; // linear interpolation, one chip sample late
    }
  }
}

/** Browser wrapper; call from a user gesture. Returns {ctx, node, player}. */
export function startWebAudio(playerBytes, bankBytes) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const player = new AdlibPlayer(playerBytes, bankBytes, ctx.sampleRate);
  const node = ctx.createScriptProcessor(2048, 0, 1);
  node.onaudioprocess = (e) => player.render(e.outputBuffer.getChannelData(0), e.outputBuffer.length);
  node.connect(ctx.destination);
  return { ctx, node, player };
}
