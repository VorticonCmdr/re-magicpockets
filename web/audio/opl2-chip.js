// Compact register-level YM3812 (OPL2) model: write(reg, val) in, mono float samples out.
// Written for this project from the chip's documented behaviour (not a port of an existing emulator,
// and not gate-level). `[STATIC]` approximation: waveforms, operator topology, multiplier table,
// frequency formula (f = fnum * 2^block * mul / 2^20 cycles per 49716 Hz sample), attenuation steps
// (EG 0.1875 dB, TL 0.75 dB, KSL table, tremolo/vibrato depths) follow the datasheet; the envelope
// rate/time table is the datasheet's "time for 0-96 dB" series (39.28 s at effective rate 4, halving
// every +4), the attack is an exponential approach, and modulation scales (+-2 cycles at full
// output, feedback >> (9 - fb)) are the usual values. It has NOT been compared sample-for-sample
// against real hardware or DOSBox audio. The register STREAM fed to it is the verified part.
//
// Not modelled: rhythm mode (reg 0xBD bit 5; the shipped AdLib cues only write 0xBD = 0), timer
// IRQs, composite sine/noise.

export const OPL_RATE = 49716;

const MUL = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const KSL_TAB = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [31, 2, 1, 0];
const SLOT_OFF = [0, 1, 2, 8, 9, 10, 16, 17, 18];
const OFF_TO_SLOT = new Int8Array(0x20).fill(-1);
for (let ch = 0; ch < 9; ch++) { OFF_TO_SLOT[SLOT_OFF[ch]] = ch * 2; OFF_TO_SLOT[SLOT_OFF[ch] + 3] = ch * 2 + 1; }

const ATT = 0, DEC = 1, SUS = 2, REL = 3, OFF = 4;

function decayPerSample(R) { // attenuation units (0.1875 dB, 512 = 96 dB) per output sample
  if (R <= 0) return 0;
  const t96 = 39.28 * Math.pow(2, -(R - 4) / 4); // seconds for 0..96 dB
  return 512 / (t96 * OPL_RATE);
}
function attackTau(R) { // seconds-constant of the exponential approach
  if (R <= 0) return Infinity;
  const ta = 2.826 * Math.pow(2, -(R - 4) / 4);
  return ta / 6.2;
}

class Op {
  constructor() { this.reset(); }
  reset() {
    this.am = 0; this.vib = 0; this.egt = 0; this.ksr = 0; this.mul = 1;
    this.ksl = 0; this.tl = 0; this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0; this.ws = 0;
    this.phase = 0; this.env = 511; this.state = OFF; this.out = 0; this.prev = 0;
  }
}

export class Opl2 {
  constructor(rate = OPL_RATE) {
    this.rate = rate;
    this.ops = Array.from({ length: 18 }, () => new Op());
    this.fnum = new Int32Array(9); this.block = new Uint8Array(9); this.keyon = new Uint8Array(9);
    this.fb = new Uint8Array(9); this.cnt = new Uint8Array(9);
    this.wsEnable = 0; this.nts = 0; this.tremDeep = 0; this.vibDeep = 0;
    this.regs = new Uint8Array(256);
    this.t = 0; // samples
    this.acc = 0;
    this.writeLog = null;
  }
  write(reg, val) {
    reg &= 0xff; val &= 0xff;
    this.regs[reg] = val;
    if (this.writeLog) this.writeLog.push(reg, val);
    if (reg === 0x01) { this.wsEnable = (val >> 5) & 1; return; }
    if (reg === 0x08) { this.nts = (val >> 6) & 1; return; }
    if (reg === 0xbd) { this.tremDeep = (val >> 7) & 1; this.vibDeep = (val >> 6) & 1; return; }
    if (reg >= 0x20 && reg <= 0x35) {
      const s = OFF_TO_SLOT[reg - 0x20]; if (s < 0) return; const o = this.ops[s];
      o.am = (val >> 7) & 1; o.vib = (val >> 6) & 1; o.egt = (val >> 5) & 1; o.ksr = (val >> 4) & 1; o.mul = MUL[val & 15];
    } else if (reg >= 0x40 && reg <= 0x55) {
      const s = OFF_TO_SLOT[reg - 0x40]; if (s < 0) return; const o = this.ops[s];
      o.ksl = val >> 6; o.tl = val & 63;
    } else if (reg >= 0x60 && reg <= 0x75) {
      const s = OFF_TO_SLOT[reg - 0x60]; if (s < 0) return; const o = this.ops[s];
      o.ar = val >> 4; o.dr = val & 15;
    } else if (reg >= 0x80 && reg <= 0x95) {
      const s = OFF_TO_SLOT[reg - 0x80]; if (s < 0) return; const o = this.ops[s];
      o.sl = val >> 4; o.rr = val & 15;
    } else if (reg >= 0xe0 && reg <= 0xf5) {
      const s = OFF_TO_SLOT[reg - 0xe0]; if (s < 0) return; this.ops[s].ws = val & 3;
    } else if (reg >= 0xa0 && reg <= 0xa8) {
      const ch = reg - 0xa0; this.fnum[ch] = (this.fnum[ch] & 0x300) | val;
    } else if (reg >= 0xb0 && reg <= 0xb8) {
      const ch = reg - 0xb0;
      this.fnum[ch] = (this.fnum[ch] & 0xff) | ((val & 3) << 8);
      this.block[ch] = (val >> 2) & 7;
      const k = (val >> 5) & 1;
      if (k && !this.keyon[ch]) { this.noteOn(ch * 2); this.noteOn(ch * 2 + 1); }
      else if (!k && this.keyon[ch]) { this.ops[ch * 2].state = this.ops[ch * 2].state === OFF ? OFF : REL; this.ops[ch * 2 + 1].state = this.ops[ch * 2 + 1].state === OFF ? OFF : REL; }
      this.keyon[ch] = k;
    } else if (reg >= 0xc0 && reg <= 0xc8) {
      const ch = reg - 0xc0; this.fb[ch] = (val >> 1) & 7; this.cnt[ch] = val & 1;
    }
  }
  noteOn(s) {
    const o = this.ops[s];
    o.phase = 0; o.state = ATT;
    if (this.effRate(s, o.ar) >= 60) { o.env = 0; o.state = DEC; }
  }
  effRate(s, rate) {
    if (rate === 0) return 0;
    const ch = s >> 1, o = this.ops[s];
    let ks = (this.block[ch] << 1) | ((this.fnum[ch] >> (this.nts ? 8 : 9)) & 1);
    if (!o.ksr) ks >>= 2;
    return Math.min(63, rate * 4 + ks);
  }
  attn(s) { // total attenuation in dB
    const o = this.ops[s], ch = s >> 1;
    let k = 0;
    if (o.ksl) {
      const v = KSL_TAB[(this.fnum[ch] >> 6) & 15] - 8 * (7 - this.block[ch]);
      if (v > 0) k = v >> KSL_SHIFT[o.ksl];
    }
    return o.env * 0.1875 + o.tl * 0.75 + k * 0.375;
  }
  stepEnv(s) {
    const o = this.ops[s];
    switch (o.state) {
      case ATT: {
        const R = this.effRate(s, o.ar);
        if (R >= 60) { o.env = 0; o.state = DEC; break; }
        const tau = attackTau(R) * this.rate;
        o.env -= o.env / tau + 0.01;
        if (o.env <= 0) { o.env = 0; o.state = DEC; }
        break;
      }
      case DEC: {
        const slv = (o.sl === 15 ? 31 : o.sl) * 16;
        o.env += decayPerSample(this.effRate(s, o.dr));
        if (o.env >= slv) { o.env = slv; o.state = SUS; }
        break;
      }
      case SUS:
        if (!o.egt) { o.env += decayPerSample(this.effRate(s, o.rr)); if (o.env >= 511) { o.env = 511; o.state = OFF; } }
        break;
      case REL:
        o.env += decayPerSample(this.effRate(s, o.rr));
        if (o.env >= 511) { o.env = 511; o.state = OFF; }
        break;
    }
  }
  wave(ws, ph) { // ph in cycles [0,1)
    const x = ph - Math.floor(ph);
    const s = Math.sin(x * 2 * Math.PI);
    switch (this.wsEnable ? ws : 0) {
      case 0: return s;
      case 1: return s > 0 ? s : 0;
      case 2: return Math.abs(s);
      default: return (x % 0.5) < 0.25 ? Math.abs(s) : 0;
    }
  }
  genOp(s, modCycles, trem, vib) {
    const o = this.ops[s], ch = s >> 1;
    if (o.state === OFF) { o.out = 0; return 0; }
    this.stepEnv(s);
    let f = this.fnum[ch] * (1 << this.block[ch]) * o.mul / 1048576;
    if (o.vib) f *= vib;
    o.phase += f;
    o.phase -= Math.floor(o.phase);
    let db = this.attn(s);
    if (o.am) db += trem;
    if (db >= 96) { o.out = 0; return 0; }
    const out = this.wave(o.ws, o.phase + modCycles) * Math.pow(10, -db / 20);
    o.out = out;
    return out;
  }
  sample() {
    this.t++;
    const trem = (this.tremDeep ? 4.8 : 1.0) * 0.5 * (1 + Math.sin(2 * Math.PI * 3.7 * this.t / this.rate - Math.PI / 2)) ;
    const vib = 1 + (this.vibDeep ? 14 : 7) / 1200 * Math.log(2) * Math.sin(2 * Math.PI * 6.1 * this.t / this.rate) * 1.0;
    let mix = 0;
    for (let ch = 0; ch < 9; ch++) {
      const m = this.ops[ch * 2], c = this.ops[ch * 2 + 1];
      if (m.state === OFF && c.state === OFF) continue;
      let fbm = 0;
      if (this.fb[ch]) fbm = (m.out + m.prev) * 2036 / (1 << (9 - this.fb[ch])) / 1024;
      m.prev = m.out;
      const mo = this.genOp(ch * 2, fbm, trem, vib);
      if (this.cnt[ch]) mix += mo + this.genOp(ch * 2 + 1, 0, trem, vib);
      else mix += this.genOp(ch * 2 + 1, mo * 2, trem, vib);
    }
    return mix * 0.25;
  }
  render(out, n, offset = 0) { for (let i = 0; i < n; i++) out[offset + i] = this.sample(); }
}
