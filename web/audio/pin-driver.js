// Host for the ORIGINAL AdLib sound driver: depacked data/player.pin (the driver code) + data/adlib.pin
// (its cue bank) executed by web/audio/x86-lite.js, driven exactly like GAMEU drives it
// (docs/formats/pin-sound.md): init = command 0 (1000:1CB0), play = 1CCF -> command 1 (AH=1, AL=cue,
// BL = round-robin slot 0..7), stop one = 1D4C -> command 4, stop all = 1DAE -> command 3, and
// `tick()` = command 2, which GAMEU issues once per timer IRQ (PIT divisor 0x5CEC = 50.159 Hz).
// Every OPL2 register write the driver makes (OUT 0x388/0x389) goes to `onWrite(reg, val)`.
// The page's `?sound` flag runs this; tools/pin-driver-oracle.mjs records it for the verify suite.
import { Cpu } from './x86-lite.js';

export const TICK_HZ = 1193181.8 / 0x5cec; // [STATIC] PIT reload 0x5CEC at 1000:2047-2051; 1000:2132 divides the BIOS chain

export class PinDriver {
  constructor(playerBytes, bankBytes, onWrite) {
    this.PS = 0x2000; this.DS = 0x3000; this.SS = 0x1000;
    let idx = 0, status = 0;
    this.cpu = new Cpu({
      out: (p, v) => {
        if (p === 0x388) idx = v & 0xff;
        else if (p === 0x389) {
          if (idx === 4) { if (v & 0x80) status = 0; else if (v & 1) status = 0xc0; } // timer-1 detection handshake
          if (this.onWrite) this.onWrite(idx, v & 0xff);
        }
      },
      in: (p) => (p === 0x388 ? status : 0),
    });
    this.onWrite = onWrite;
    this.cpu.mem.set(playerBytes, this.PS << 4);
    this.cpu.mem.set(bankBytes, this.DS << 4);
    this.slot = 0; // cs:1D4B in GAMEU
  }
  call(ax, bx = 0, cx = 0, dx = 0) {
    const c = this.cpu;
    c.ss = this.SS; c.sp = 0xff00; c.ds = 0x5000; c.es = 0x5000;
    c.ax = ax; c.bx = bx; c.cx = cx; c.dx = dx;
    c.push(0xf000); c.push(0);
    c.cs = this.PS; c.ip = 0;
    c.run(20_000_000, 0xf000, 0);
    return c.ax;
  }
  init() { return this.call(0x0001, 0, 0, this.DS); }
  play(id) { const bl = this.slot; this.slot = (this.slot + 1) & 7; return this.call(0x0100 | (id & 0xff), bl); }
  stop(id) { return this.call(0x0400 | (id & 0xff)); }
  stopAll() { return this.call(0x0300); }
  tick() { return this.call(0x0200); }
}
