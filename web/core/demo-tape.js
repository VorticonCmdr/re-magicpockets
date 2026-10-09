// Attract-demo input tape (data/autoplay.pin) decoder and playback cursor.
//
// Format [STATIC] (read from live disassembly of Demo_PlaybackInput 1000:0159, Demo_RecordInput
// 1000:01d9 and Game_StartAttractDemoAndRunLoop 1000:0089; see docs/open-questions-history.md
// item 1): a run of (count, state) byte pairs, terminated by the word 0xFFFF. The depacked file
// is loaded at DS:0x8200 and [8BA6] points at the CURRENT record. Each loop iteration, playback:
//   1. overwrites both input bytes ([8B67] and [8B68]) with the current record's state byte;
//   2. decrements the remaining-count byte [8BA8]; when that reaches 0 it advances [8BA6] by 2,
//      loads the next word into [8BA8]/[8BA9] (count in the low byte, state in the high byte),
//      and a word of 0xFFFF ends the demo instead.
// So a record with count N is applied on exactly N iterations (count 0 would run 256). The
// state byte is the same layout the keyboard ISR builds (CS:0x1E27 scancode table) and
// Input_ReadState passes through: see INPUT_BITS.

'use strict';

export const INPUT_BITS = { up: 0x01, down: 0x02, left: 0x04, right: 0x08, fire: 0x80 };

/** Seed the original writes to the RNG state [8B71] when it starts the attract demo. */
export const DEMO_RNG_SEED = 0x3141;

export function decodeDemoTape(buf) {
  const records = [];
  let frames = 0;
  let i = 0;
  let terminated = false;
  while (i + 1 < buf.length) {
    if (buf[i] === 0xff && buf[i + 1] === 0xff) { terminated = true; break; }
    const count = buf[i] === 0 ? 256 : buf[i];
    records.push({ count, state: buf[i + 1] });
    frames += count;
    i += 2;
  }
  return { records, frames, terminated, terminatorOffset: terminated ? i : -1 };
}

/** One call to next() == one Demo_PlaybackInput call == one main-loop iteration. */
export class DemoPlayback {
  constructor(tape) {
    this.tape = tape;
    this.index = 0;
    this.remaining = tape.records.length ? tape.records[0].count : 0;
    this.done = tape.records.length === 0;
  }

  /** Returns the input state byte for this iteration, or null once the tape has ended. */
  next() {
    if (this.done) return null;
    const state = this.tape.records[this.index].state;
    this.remaining -= 1;
    if (this.remaining === 0) {
      this.index += 1;
      if (this.index >= this.tape.records.length) this.done = true;
      else this.remaining = this.tape.records[this.index].count;
    }
    return state;
  }
}
