// Replays a DOSBox capture of the original AdLib driver through web/audio/pin-driver.js and compares the OPL2
// register-write stream. Capture format (docs/formats/pin-sound.md "DOSBox capture"): whitespace-separated tokens,
// `T` = one driver tick (command 2 entered), or a 4-digit hex WORD:
//   0xFF00 re-init (command 0; followed by the filler word 0xFA00)        0xFE<id> play (1CCF), then 0xFB<slot> = its BL
//   0xFD<id> stop one (1D4C, command 4)                                   0xFC00 stop all (1DAE, command 3)
//   anything else = 0xRRVV: OPL2 register RR written with VV.
// The stimulus (commands and tick count) comes from the capture; the comparison is of the writes the driver makes.
import { PinDriver } from './pin-driver.js';

export function parseTrace(text) {
  let tick = 0;
  const out = [];
  for (const t of text.trim().split(/\s+/).filter(Boolean)) {
    if (t === 'T') { tick++; continue; }
    out.push({ tick, w: parseInt(t, 16) });
  }
  return out;
}

/** @returns {{dos:string[], ora:string[], first:number, n:number, plays:number[]}} first = index of the first differing token or -1 */
export function replay(tokens, player, bank) {
  const dos = [], ora = [], plays = [];
  const hex = (r, v) => r.toString(16).padStart(2, '0') + v.toString(16).padStart(2, '0');
  const drv = new PinDriver(player, bank, (r, v) => ora.push(hex(r, v)));
  let cur = 0, started = false, pendingId = null;
  for (const t of tokens) {
    const hi = t.w >> 8, lo = t.w & 255;
    if (!started) { if (hi === 0xff) { started = true; cur = t.tick; } else continue; }
    while (cur < t.tick) { dos.push('T'); ora.push('T'); drv.tick(); cur++; }
    if (hi === 0xff) { dos.push('INIT'); ora.push('INIT'); drv.init(); }
    else if (hi === 0xfa) { /* filler word after INIT */ }
    else if (hi === 0xfe) { pendingId = lo; dos.push(`P${lo}`); }
    else if (hi === 0xfb) { drv.slot = lo; ora.push(`P${pendingId}`); plays.push(pendingId); drv.play(pendingId); }
    else if (hi === 0xfd) { dos.push(`S${lo}`); ora.push(`S${lo}`); drv.stop(lo); }
    else if (hi === 0xfc) { dos.push('SA'); ora.push('SA'); drv.stopAll(); }
    else dos.push(hex(hi, lo));
  }
  let first = -1;
  const n = Math.min(dos.length, ora.length);
  for (let i = 0; i < n; i++) if (dos[i] !== ora[i]) { first = i; break; }
  if (first < 0 && dos.length !== ora.length) first = n;
  return { dos, ora, first, n, plays };
}
