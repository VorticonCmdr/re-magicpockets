// Sound-effect/music .pin resource-table decoder -- isomorphic port of tools/extract-pin.js onto
// Uint8Array/DataView, minus the CLI/file-writing plumbing. Two shapes, both confirmed via Ghidra
// disassembly of player.pin's own driver code (see docs/formats/pin.md): adlib.pin/roland.pin are
// sound-effect BANKS (2-byte entry count + that many 4-byte little-endian file offsets, one per
// sound_id -- table entry N *is* sound_id N, always, fixed 4-byte stride, no compaction);
// roland2.pin/soundbnk.pin are single embedded songs, the same shape with count==1.
//
// The AdLib bank's cues have no End-of-Track meta event in the source data (the driver uses its
// own length table instead); this decoder synthesizes one per track, matching extract-pin.js, so
// every returned cue is a valid standalone SMF a browser MIDI parser (core/midi.js) can read.

'use strict';

function ascii(buf, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]);
  return s;
}

function readChunkHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  const id = ascii(buf, offset, 4);
  const len = (buf[offset + 4] << 24) | (buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7];
  return { id, len: len >>> 0, dataStart: offset + 8 };
}

/** Walks MThd + consecutive MTrk chunks starting at `start`. Returns {length} or null. */
function extractMidiAt(buf, start) {
  const mthd = readChunkHeader(buf, start);
  if (!mthd || mthd.id !== 'MThd') return null;
  if (mthd.len !== 6) return null;
  if (mthd.dataStart + mthd.len > buf.length) return null;

  let offset = mthd.dataStart + mthd.len;
  const ntrks = (buf[mthd.dataStart + 2] << 8) | buf[mthd.dataStart + 3];
  let tracksFound = 0;

  while (tracksFound < ntrks) {
    const chunk = readChunkHeader(buf, offset);
    if (!chunk || chunk.id !== 'MTrk') break;
    if (chunk.dataStart + chunk.len > buf.length) break;
    offset = chunk.dataStart + chunk.len;
    tracksFound++;
  }

  if (tracksFound === 0) return null;
  return { length: offset - start };
}

function endsWithEndOfTrack(data) {
  const n = data.length;
  return n >= 3 && data[n - 3] === 0xff && data[n - 2] === 0x2f && data[n - 1] === 0x00;
}

/** Rebuilds a raw MThd+MTrk* cue into a valid SMF Uint8Array, adding a missing End-of-Track per track. */
function ensureEndOfTrack(cueBuf) {
  const mthd = readChunkHeader(cueBuf, 0);
  const parts = [cueBuf.subarray(0, 8 + mthd.len)];
  let pos = 8 + mthd.len;

  while (pos < cueBuf.length) {
    const chunk = readChunkHeader(cueBuf, pos);
    if (!chunk || chunk.id !== 'MTrk') break;
    let data = cueBuf.subarray(chunk.dataStart, chunk.dataStart + chunk.len);
    if (!endsWithEndOfTrack(data)) {
      const padded = new Uint8Array(data.length + 4);
      padded.set(data, 0);
      padded.set([0x00, 0xff, 0x2f, 0x00], data.length);
      data = padded;
    }
    const header = new Uint8Array(8);
    header.set([0x4d, 0x54, 0x72, 0x6b]); // "MTrk"
    const len = data.length;
    header[4] = (len >>> 24) & 0xff;
    header[5] = (len >>> 16) & 0xff;
    header[6] = (len >>> 8) & 0xff;
    header[7] = len & 0xff;
    parts.push(header, data);
    pos = chunk.dataStart + chunk.len;
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Decodes a depacked sound .pin buffer as a resource-offset table (adlib.pin/roland.pin's
 * sound-effect-bank shape, or roland2.pin/soundbnk.pin's degenerate 1-entry song shape). Returns
 * null if the buffer doesn't look like this shape (at least half the entries must resolve to a
 * real MThd chunk, same heuristic as tools/extract-pin.js). Non-MIDI entries (docs/formats/pin.md:
 * a handful of OPL2 hardware-reset byte sequences, not decoded) get `midi: null`.
 */
export function decodePinSoundBank(buf) {
  if (buf.length < 2) return null;
  const count = buf[0] | (buf[1] << 8);
  if (count < 1 || count > 500) return null;
  const tableEnd = 2 + count * 4;
  if (tableEnd > buf.length) return null;

  const entries = [];
  let mthdHits = 0;
  for (let i = 0; i < count; i++) {
    const p = 2 + 4 * i;
    const offset = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
    const midi = offset >= 0 && offset < buf.length ? extractMidiAt(buf, offset) : null;
    if (midi) mthdHits++;
    entries.push({ index: i, offset, midiLength: midi ? midi.length : null });
  }
  if (mthdHits < count / 2) return null;
  return { count, entries, sourceBuf: buf };
}

/** Extracts entry `index`'s cue as a valid, playable SMF Uint8Array, or null if it isn't a MIDI cue. */
export function extractCue(bank, index) {
  const entry = bank.entries[index];
  if (!entry || entry.midiLength == null) return null;
  const rawCue = bank.sourceBuf.subarray(entry.offset, entry.offset + entry.midiLength);
  return ensureEndOfTrack(rawCue);
}
