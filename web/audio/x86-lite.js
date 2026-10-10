// Minimal real-mode 8086/80186 interpreter, written only to run the original sound driver
// (data/player.pin, depacked) off-line so its OPL2 register writes can be recorded and used as
// an oracle for web/audio/opl-player.js. It is NOT a general emulator: no interrupts, no
// segment-limit checks, BCD ops are absent; an unimplemented opcode throws. Dev/test tool only.
// Ports: OUT is forwarded to `io.out(port, value)`, IN to `io.in(port)`.

export class Cpu {
  constructor(io) {
    this.mem = new Uint8Array(0x110000);
    this.r = new Uint16Array(8); // ax cx dx bx sp bp si di
    this.s = new Uint16Array(4); // es cs ss ds
    this.ip = 0;
    this.f = { c: 0, p: 0, a: 0, z: 0, s: 0, o: 0, d: 0, i: 1, t: 0 };
    this.io = io || { out() {}, in() { return 0; } };
    this.steps = 0;
    this.halt = false;
  }
  // ---- memory
  lin(seg, off) { return ((seg << 4) + (off & 0xffff)) & 0xfffff; }
  rb(seg, off) { return this.mem[this.lin(seg, off)]; }
  rw(seg, off) { return this.mem[this.lin(seg, off)] | (this.mem[this.lin(seg, off + 1)] << 8); }
  wb(seg, off, v) { this.mem[this.lin(seg, off)] = v & 0xff; }
  ww(seg, off, v) { this.mem[this.lin(seg, off)] = v & 0xff; this.mem[this.lin(seg, off + 1)] = (v >> 8) & 0xff; }
  // ---- registers
  get ax() { return this.r[0]; } set ax(v) { this.r[0] = v; }
  get cx() { return this.r[1]; } set cx(v) { this.r[1] = v; }
  get dx() { return this.r[2]; } set dx(v) { this.r[2] = v; }
  get bx() { return this.r[3]; } set bx(v) { this.r[3] = v; }
  get sp() { return this.r[4]; } set sp(v) { this.r[4] = v; }
  get bp() { return this.r[5]; } set bp(v) { this.r[5] = v; }
  get si() { return this.r[6]; } set si(v) { this.r[6] = v; }
  get di() { return this.r[7]; } set di(v) { this.r[7] = v; }
  get es() { return this.s[0]; } set es(v) { this.s[0] = v; }
  get cs() { return this.s[1]; } set cs(v) { this.s[1] = v; }
  get ss() { return this.s[2]; } set ss(v) { this.s[2] = v; }
  get ds() { return this.s[3]; } set ds(v) { this.s[3] = v; }
  reg8(n) { return n < 4 ? this.r[n] & 0xff : (this.r[n - 4] >> 8) & 0xff; }
  setReg8(n, v) {
    v &= 0xff;
    if (n < 4) this.r[n] = (this.r[n] & 0xff00) | v; else this.r[n - 4] = (this.r[n - 4] & 0xff) | (v << 8);
  }
  push(v) { this.sp = this.sp - 2; this.ww(this.ss, this.sp, v); }
  pop() { const v = this.rw(this.ss, this.sp); this.sp = this.sp + 2; return v; }
  getFlags() {
    const f = this.f;
    return (f.c) | 2 | (f.p << 2) | (f.a << 4) | (f.z << 6) | (f.s << 7) | (f.t << 8) | (f.i << 9) | (f.d << 10) | (f.o << 11);
  }
  setFlags(v) {
    const f = this.f;
    f.c = v & 1; f.p = (v >> 2) & 1; f.a = (v >> 4) & 1; f.z = (v >> 6) & 1; f.s = (v >> 7) & 1;
    f.t = (v >> 8) & 1; f.i = (v >> 9) & 1; f.d = (v >> 10) & 1; f.o = (v >> 11) & 1;
  }
  fetch8() { const v = this.rb(this.cs, this.ip); this.ip = (this.ip + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch8(); return lo | (this.fetch8() << 8); }
  // ---- flags helpers
  szp(v, w) {
    const m = w ? 0xffff : 0xff;
    v &= m;
    this.f.z = v === 0 ? 1 : 0;
    this.f.s = (v >> (w ? 15 : 7)) & 1;
    let p = v & 0xff; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
    this.f.p = (~p) & 1;
    return v;
  }
  alu(op, a, b, w) {
    const m = w ? 0xffff : 0xff, sb = w ? 0x8000 : 0x80;
    let r;
    const f = this.f;
    switch (op) {
      case 0: r = a + b; f.c = r > m ? 1 : 0; f.a = ((a ^ b ^ r) >> 4) & 1; f.o = (~(a ^ b) & (a ^ r) & sb) ? 1 : 0; break;
      case 1: r = a | b; f.c = 0; f.o = 0; f.a = 0; break;
      case 2: { const c = f.c; r = a + b + c; f.c = r > m ? 1 : 0; f.a = ((a ^ b ^ r) >> 4) & 1; f.o = (~(a ^ b) & (a ^ r) & sb) ? 1 : 0; break; }
      case 3: { const c = f.c; r = a - b - c; f.c = r < 0 ? 1 : 0; f.a = ((a ^ b ^ r) >> 4) & 1; f.o = ((a ^ b) & (a ^ r) & sb) ? 1 : 0; break; }
      case 4: r = a & b; f.c = 0; f.o = 0; f.a = 0; break;
      case 5: case 7: r = a - b; f.c = r < 0 ? 1 : 0; f.a = ((a ^ b ^ r) >> 4) & 1; f.o = ((a ^ b) & (a ^ r) & sb) ? 1 : 0; break;
      case 6: r = a ^ b; f.c = 0; f.o = 0; f.a = 0; break;
    }
    return this.szp(r, w);
  }
  cond(n) {
    const f = this.f;
    let r;
    switch (n >> 1) {
      case 0: r = f.o; break;
      case 1: r = f.c; break;
      case 2: r = f.z; break;
      case 3: r = f.c | f.z; break;
      case 4: r = f.s; break;
      case 5: r = f.p; break;
      case 6: r = f.s ^ f.o; break;
      case 7: r = f.z | (f.s ^ f.o); break;
    }
    return (n & 1) ? !r : !!r;
  }
  // ---- modrm
  modrm() {
    const b = this.fetch8();
    this.mod = b >> 6; this.reg = (b >> 3) & 7; this.rm = b & 7;
    if (this.mod === 3) { this.isReg = true; return; }
    this.isReg = false;
    let ea;
    const rm = this.rm;
    let defSeg = 3;
    switch (rm) {
      case 0: ea = this.bx + this.si; break;
      case 1: ea = this.bx + this.di; break;
      case 2: ea = this.bp + this.si; defSeg = 2; break;
      case 3: ea = this.bp + this.di; defSeg = 2; break;
      case 4: ea = this.si; break;
      case 5: ea = this.di; break;
      case 6: ea = this.bp; defSeg = 2; break;
      case 7: ea = this.bx; break;
    }
    if (this.mod === 0 && rm === 6) { ea = this.fetch16(); defSeg = 3; }
    else if (this.mod === 1) { const d = this.fetch8(); ea += d > 127 ? d - 256 : d; }
    else if (this.mod === 2) { ea += this.fetch16(); }
    this.ea = ea & 0xffff;
    this.eseg = this.segOverride >= 0 ? this.s[this.segOverride] : this.s[defSeg];
  }
  rdRM(w) {
    if (this.isReg) return w ? this.r[this.rm] : this.reg8(this.rm);
    return w ? this.rw(this.eseg, this.ea) : this.rb(this.eseg, this.ea);
  }
  wrRM(v, w) {
    if (this.isReg) { if (w) this.r[this.rm] = v; else this.setReg8(this.rm, v); return; }
    if (w) this.ww(this.eseg, this.ea, v); else this.wb(this.eseg, this.ea, v);
  }
  rdReg(w) { return w ? this.r[this.reg] : this.reg8(this.reg); }
  wrReg(v, w) { if (w) this.r[this.reg] = v; else this.setReg8(this.reg, v); }
  sx8(v) { return v > 127 ? v - 256 : v; }
  shift(op, v, n, w) {
    const bits = w ? 16 : 8, m = w ? 0xffff : 0xff, sb = w ? 0x8000 : 0x80, f = this.f;
    n &= 0x1f;
    if (!n) return v;
    let r = v;
    for (let i = 0; i < n; i++) {
      switch (op) {
        case 0: { const c = (r & sb) ? 1 : 0; r = ((r << 1) | c) & m; f.c = c; f.o = ((r & sb) ? 1 : 0) ^ c; break; }
        case 1: { const c = r & 1; r = ((r >> 1) | (c ? sb : 0)) & m; f.c = c; f.o = ((r >> (bits - 1)) ^ (r >> (bits - 2))) & 1; break; }
        case 2: { const c = (r & sb) ? 1 : 0; r = ((r << 1) | f.c) & m; f.o = ((r & sb) ? 1 : 0) ^ c; f.c = c; break; }
        case 3: { const c = r & 1; r = ((r >> 1) | (f.c ? sb : 0)) & m; f.o = ((r >> (bits - 1)) ^ (r >> (bits - 2))) & 1; f.c = c; break; }
        case 4: case 6: { f.c = (r & sb) ? 1 : 0; r = (r << 1) & m; f.o = ((r & sb) ? 1 : 0) ^ f.c; this.szp(r, w); break; }
        case 5: { f.c = r & 1; f.o = (r & sb) ? 1 : 0; r = r >> 1; this.szp(r, w); break; }
        case 7: { f.c = r & 1; f.o = 0; r = ((r >> 1) | (r & sb)) & m; this.szp(r, w); break; }
      }
    }
    return r;
  }
  call(seg, off) { this.push(this.cs); this.push(this.ip); this.cs = seg; this.ip = off; }
  // Run until `stopCs:stopIp` is reached (used with a sentinel far-return address).
  run(maxSteps, stopCs, stopIp) {
    const lim = this.steps + maxSteps;
    while (this.steps < lim) {
      if (this.cs === stopCs && this.ip === stopIp) return true;
      this.step();
    }
    throw new Error('step limit');
  }
  step() {
    this.steps++;
    this.segOverride = -1;
    let rep = 0;
    const startIp = this.ip;
    let op = this.fetch8();
    for (;;) {
      if (op === 0x26) this.segOverride = 0; else if (op === 0x2e) this.segOverride = 1;
      else if (op === 0x36) this.segOverride = 2; else if (op === 0x3e) this.segOverride = 3;
      else if (op === 0xf2) rep = 2; else if (op === 0xf3) rep = 1; else if (op === 0xf0) { /* lock */ } else break;
      op = this.fetch8();
    }
    const f = this.f;
    if (op < 0x40 && (op & 7) < 6) {
      const alop = op >> 3, k = op & 7, w = k & 1;
      if (k < 4) {
        this.modrm();
        const dir = k & 2;
        const a = dir ? this.rdReg(w) : this.rdRM(w);
        const b = dir ? this.rdRM(w) : this.rdReg(w);
        const r = this.alu(alop, a, b, w);
        if (alop !== 7) { if (dir) this.wrReg(r, w); else this.wrRM(r, w); }
      } else {
        const imm = w ? this.fetch16() : this.fetch8();
        const a = w ? this.ax : this.reg8(0);
        const r = this.alu(alop, a, imm, w);
        if (alop !== 7) { if (w) this.ax = r; else this.setReg8(0, r); }
      }
      return;
    }
    if (op < 0x40 && (op & 7) === 6 && !(op >= 0x26 && op <= 0x3f && (op & 7) === 7)) { this.push(this.s[op >> 3]); return; }
    if (op < 0x20 && (op & 7) === 7) { this.s[op >> 3] = this.pop(); return; }
    if (op >= 0x40 && op < 0x48) {
      const i = op & 7, c = f.c; this.r[i] = this.alu(0, this.r[i], 1, 1); f.c = c; return;
    }
    if (op >= 0x48 && op < 0x50) {
      const i = op & 7, c = f.c; this.r[i] = this.alu(5, this.r[i], 1, 1); f.c = c; return;
    }
    if (op >= 0x50 && op < 0x58) { const v = this.r[op & 7]; this.push(op === 0x54 ? (v) : v); return; }
    if (op >= 0x58 && op < 0x60) { this.r[op & 7] = this.pop(); return; }
    if (op === 0x60) { const t = this.sp; for (const i of [0, 1, 2, 3]) this.push(this.r[i]); this.push(t); for (const i of [5, 6, 7]) this.push(this.r[i]); return; }
    if (op === 0x61) { this.di = this.pop(); this.si = this.pop(); this.bp = this.pop(); this.pop(); this.bx = this.pop(); this.dx = this.pop(); this.cx = this.pop(); this.ax = this.pop(); return; }
    if (op === 0x68) { this.push(this.fetch16()); return; }
    if (op === 0x6a) { this.push(this.sx8(this.fetch8()) & 0xffff); return; }
    if (op === 0x69 || op === 0x6b) {
      this.modrm(); const v = this.rdRM(1); const imm = op === 0x69 ? this.fetch16() : (this.sx8(this.fetch8()) & 0xffff);
      const a = v > 32767 ? v - 65536 : v, b = imm > 32767 ? imm - 65536 : imm;
      const r = a * b; this.wrReg(r & 0xffff, 1); f.c = f.o = (r > 32767 || r < -32768) ? 1 : 0; return;
    }
    if (op >= 0x70 && op < 0x80) { const d = this.sx8(this.fetch8()); if (this.cond(op & 15)) this.ip = (this.ip + d) & 0xffff; return; }
    if (op >= 0x80 && op <= 0x83) {
      const w = op & 1; this.modrm();
      const a = this.rdRM(w);
      let imm;
      if (op === 0x81) imm = this.fetch16(); else if (op === 0x83) imm = this.sx8(this.fetch8()) & 0xffff; else imm = this.fetch8();
      if (!w) imm &= 0xff;
      const r = this.alu(this.reg, a, imm, w);
      if (this.reg !== 7) this.wrRM(r, w);
      return;
    }
    if (op >= 0xb0 && op < 0xb8) { this.setReg8(op & 7, this.fetch8()); return; }
    if (op >= 0xb8 && op < 0xc0) { this.r[op & 7] = this.fetch16(); return; }
    switch (op) {
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: { const i = op & 7, t = this.ax; this.ax = this.r[i]; this.r[i] = t; return; }
      case 0x84: case 0x85: { const w = op & 1; this.modrm(); this.alu(4, this.rdRM(w), this.rdReg(w), w); return; }
      case 0x86: case 0x87: { const w = op & 1; this.modrm(); const a = this.rdRM(w), b = this.rdReg(w); this.wrRM(b, w); this.wrReg(a, w); return; }
      case 0x88: case 0x89: { const w = op & 1; this.modrm(); this.wrRM(this.rdReg(w), w); return; }
      case 0x8a: case 0x8b: { const w = op & 1; this.modrm(); this.wrReg(this.rdRM(w), w); return; }
      case 0x8c: this.modrm(); this.wrRM(this.s[this.reg & 3], 1); return;
      case 0x8d: this.modrm(); this.r[this.reg] = this.ea; return;
      case 0x8e: this.modrm(); this.s[this.reg & 3] = this.rdRM(1); return;
      case 0x8f: { this.modrm(); const v = this.pop(); this.wrRM(v, 1); return; }
      case 0x90: return;
      case 0x98: this.ax = (this.ax & 0x80) ? (this.ax & 0xff) | 0xff00 : (this.ax & 0xff); return;
      case 0x99: this.dx = (this.ax & 0x8000) ? 0xffff : 0; return;
      case 0x9a: { const o = this.fetch16(), s = this.fetch16(); this.call(s, o); return; }
      case 0x9c: this.push(this.getFlags()); return;
      case 0x9d: this.setFlags(this.pop()); return;
      case 0x9e: { const a = this.reg8(4); f.c = a & 1; f.p = (a >> 2) & 1; f.a = (a >> 4) & 1; f.z = (a >> 6) & 1; f.s = (a >> 7) & 1; return; }
      case 0x9f: this.setReg8(4, this.getFlags() & 0xff); return;
      case 0xa0: { const o = this.fetch16(); this.setReg8(0, this.rb(this.segOverride >= 0 ? this.s[this.segOverride] : this.ds, o)); return; }
      case 0xa1: { const o = this.fetch16(); this.ax = this.rw(this.segOverride >= 0 ? this.s[this.segOverride] : this.ds, o); return; }
      case 0xa2: { const o = this.fetch16(); this.wb(this.segOverride >= 0 ? this.s[this.segOverride] : this.ds, o, this.reg8(0)); return; }
      case 0xa3: { const o = this.fetch16(); this.ww(this.segOverride >= 0 ? this.s[this.segOverride] : this.ds, o, this.ax); return; }
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        this.strOp(op, rep); return;
      case 0xa8: this.alu(4, this.reg8(0), this.fetch8(), 0); return;
      case 0xa9: this.alu(4, this.ax, this.fetch16(), 1); return;
      case 0xc0: case 0xc1: { const w = op & 1; this.modrm(); const n = this.fetch8(); this.wrRM(this.shift(this.reg, this.rdRM(w), n, w), w); return; }
      case 0xd0: case 0xd1: { const w = op & 1; this.modrm(); this.wrRM(this.shift(this.reg, this.rdRM(w), 1, w), w); return; }
      case 0xd2: case 0xd3: { const w = op & 1; this.modrm(); this.wrRM(this.shift(this.reg, this.rdRM(w), this.reg8(1), w), w); return; }
      case 0xc2: { const n = this.fetch16(); this.ip = this.pop(); this.sp = this.sp + n; return; }
      case 0xc3: this.ip = this.pop(); return;
      case 0xc4: { this.modrm(); this.r[this.reg] = this.rw(this.eseg, this.ea); this.es = this.rw(this.eseg, this.ea + 2); return; }
      case 0xc5: { this.modrm(); this.r[this.reg] = this.rw(this.eseg, this.ea); this.ds = this.rw(this.eseg, this.ea + 2); return; }
      case 0xc6: { this.modrm(); this.wrRM(this.fetch8(), 0); return; }
      case 0xc7: { this.modrm(); this.wrRM(this.fetch16(), 1); return; }
      case 0xc9: this.sp = this.bp; this.bp = this.pop(); return;
      case 0xca: { const n = this.fetch16(); this.ip = this.pop(); this.cs = this.pop(); this.sp = this.sp + n; return; }
      case 0xcb: this.ip = this.pop(); this.cs = this.pop(); return;
      case 0xcf: this.ip = this.pop(); this.cs = this.pop(); this.setFlags(this.pop()); return;
      case 0xd7: this.setReg8(0, this.rb(this.segOverride >= 0 ? this.s[this.segOverride] : this.ds, this.bx + this.reg8(0))); return;
      case 0xe0: case 0xe1: case 0xe2: { const d = this.sx8(this.fetch8()); this.cx = this.cx - 1; let t = this.cx !== 0; if (op === 0xe0) t = t && !f.z; if (op === 0xe1) t = t && !!f.z; if (t) this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe3: { const d = this.sx8(this.fetch8()); if (this.cx === 0) this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe4: this.setReg8(0, this.io.in(this.fetch8())); return;
      case 0xe5: this.ax = this.io.in(this.fetch8()); return;
      case 0xe6: this.io.out(this.fetch8(), this.reg8(0)); return;
      case 0xe7: this.io.out(this.fetch8(), this.ax); return;
      case 0xe8: { const d = this.fetch16(); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe9: { const d = this.fetch16(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xea: { const o = this.fetch16(), s = this.fetch16(); this.ip = o; this.cs = s; return; }
      case 0xeb: { const d = this.sx8(this.fetch8()); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xec: this.setReg8(0, this.io.in(this.dx)); return;
      case 0xed: this.ax = this.io.in(this.dx); return;
      case 0xee: this.io.out(this.dx, this.reg8(0)); return;
      case 0xef: this.io.out(this.dx, this.ax); return;
      case 0xf4: this.halt = true; return;
      case 0xf5: f.c ^= 1; return;
      case 0xf6: case 0xf7: return this.grp3(op & 1);
      case 0xf8: f.c = 0; return;
      case 0xf9: f.c = 1; return;
      case 0xfa: f.i = 0; return;
      case 0xfb: f.i = 1; return;
      case 0xfc: f.d = 0; return;
      case 0xfd: f.d = 1; return;
      case 0xfe: { this.modrm(); const c = f.c; const v = this.rdRM(0); this.wrRM(this.alu(this.reg === 0 ? 0 : 5, v, 1, 0), 0); f.c = c; return; }
      case 0xff: return this.grp5();
    }
    throw new Error('unimplemented opcode ' + op.toString(16) + ' at ' + this.cs.toString(16) + ':' + startIp.toString(16));
  }
  grp3(w) {
    this.modrm();
    const f = this.f, m = w ? 0xffff : 0xff;
    switch (this.reg) {
      case 0: case 1: { const imm = w ? this.fetch16() : this.fetch8(); this.alu(4, this.rdRM(w), imm, w); return; }
      case 2: this.wrRM(~this.rdRM(w) & m, w); return;
      case 3: { const v = this.rdRM(w); this.wrRM(this.alu(5, 0, v, w), w); f.c = v ? 1 : 0; return; }
      case 4: {
        const v = this.rdRM(w);
        if (w) { const r = this.ax * v; this.ax = r & 0xffff; this.dx = (r >>> 16) & 0xffff; f.c = f.o = this.dx ? 1 : 0; }
        else { const r = this.reg8(0) * v; this.ax = r & 0xffff; f.c = f.o = (r > 0xff) ? 1 : 0; }
        return;
      }
      case 5: {
        const v = this.rdRM(w);
        if (w) { const a = this.ax > 32767 ? this.ax - 65536 : this.ax, b = v > 32767 ? v - 65536 : v; const r = a * b; this.ax = r & 0xffff; this.dx = (r >> 16) & 0xffff; f.c = f.o = (r > 32767 || r < -32768) ? 1 : 0; }
        else { const a = this.sx8(this.reg8(0)), b = this.sx8(v); const r = a * b; this.ax = r & 0xffff; f.c = f.o = (r > 127 || r < -128) ? 1 : 0; }
        return;
      }
      case 6: {
        const v = this.rdRM(w); if (!v) throw new Error('div0');
        if (w) { const n = this.dx * 65536 + this.ax; const q = Math.floor(n / v); if (q > 0xffff) throw new Error('div overflow'); this.ax = q; this.dx = n % v; }
        else { const n = this.ax; const q = Math.floor(n / v); if (q > 0xff) throw new Error('div overflow'); this.setReg8(0, q); this.setReg8(4, n % v); }
        return;
      }
      case 7: {
        const v = this.rdRM(w); if (!v) throw new Error('idiv0');
        if (w) { const b = v > 32767 ? v - 65536 : v; let n = this.dx * 65536 + this.ax; if (n >= 2 ** 31) n -= 2 ** 32; const q = Math.trunc(n / b); this.ax = q & 0xffff; this.dx = (n - q * b) & 0xffff; }
        else { const b = this.sx8(v); let n = this.ax; if (n > 32767) n -= 65536; const q = Math.trunc(n / b); this.setReg8(0, q); this.setReg8(4, (n - q * b)); }
        return;
      }
    }
  }
  grp5() {
    this.modrm();
    switch (this.reg) {
      case 0: case 1: { const c = this.f.c; const v = this.rdRM(1); this.wrRM(this.alu(this.reg === 0 ? 0 : 5, v, 1, 1), 1); this.f.c = c; return; }
      case 2: { const t = this.rdRM(1); this.push(this.ip); this.ip = t; return; }
      case 3: { const o = this.rw(this.eseg, this.ea), s = this.rw(this.eseg, this.ea + 2); this.call(s, o); return; }
      case 4: this.ip = this.rdRM(1); return;
      case 5: { const o = this.rw(this.eseg, this.ea), s = this.rw(this.eseg, this.ea + 2); this.ip = o; this.cs = s; return; }
      case 6: this.push(this.rdRM(1)); return;
    }
    throw new Error('bad grp5');
  }
  strOp(op, rep) {
    const w = op & 1, step = (this.f.d ? -1 : 1) * (w ? 2 : 1);
    const srcSeg = this.segOverride >= 0 ? this.s[this.segOverride] : this.ds;
    const once = () => {
      switch (op & 0xfe) {
        case 0xa4: if (w) this.ww(this.es, this.di, this.rw(srcSeg, this.si)); else this.wb(this.es, this.di, this.rb(srcSeg, this.si)); this.si += step; this.di += step; break;
        case 0xa6: { const a = w ? this.rw(srcSeg, this.si) : this.rb(srcSeg, this.si), b = w ? this.rw(this.es, this.di) : this.rb(this.es, this.di); this.alu(7, a, b, w); this.si += step; this.di += step; break; }
        case 0xaa: if (w) this.ww(this.es, this.di, this.ax); else this.wb(this.es, this.di, this.reg8(0)); this.di += step; break;
        case 0xac: if (w) this.ax = this.rw(srcSeg, this.si); else this.setReg8(0, this.rb(srcSeg, this.si)); this.si += step; break;
        case 0xae: { const b = w ? this.rw(this.es, this.di) : this.rb(this.es, this.di); this.alu(7, w ? this.ax : this.reg8(0), b, w); this.di += step; break; }
      }
    };
    if (!rep) { once(); return; }
    const cmp = (op & 0xfe) === 0xa6 || (op & 0xfe) === 0xae;
    while (this.cx !== 0) {
      once();
      this.cx = this.cx - 1;
      if (cmp) { if (rep === 1 && !this.f.z) break; if (rep === 2 && this.f.z) break; }
    }
  }
}
