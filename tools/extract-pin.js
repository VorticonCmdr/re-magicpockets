#!/usr/bin/env node
// Extracts embedded Standard MIDI File (SMF) resources from a depacked .pin sound-driver/data
// file, as playable .mid files.
//
// Two shapes, both confirmed by Ghidra disassembly of player.pin's driver code (the shared x86
// module all hardware backends load): Snd_TriggerEffect (GAMEU.EXE, 1000:1ccf) far-calls into
// player.pin with AH=1 (trigger) and AL=sound_id; that command handler (player.pin offset
// 0x01c6) ends up at the per-backend "walk the resource table" routine (offset 0x231f for the
// AdLib-family path, structurally identical for Roland): it bounds-checks AL against a count
// byte at the table's start, then indexes the table with a FIXED 4-BYTE STRIDE directly by
// sound_id -- no compaction, no skipping. So table entry N *is* sound_id N, always, even when
// entry N isn't a MIDI cue.
//   - adlib.pin / roland.pin: a SOUND-EFFECT BANK. 2-byte entry count, then that many 4-byte
//     little-endian file offsets, one per sound_id. Most entries point at a standalone MIDI cue
//     ("MThd" + MTrk chunks); a handful (adlib.pin: 11, 52, 59, 69; roland.pin: 19) point instead
//     at non-MIDI OPL2 hardware reset sequences -- see NON-MIDI logging below.
//   - roland2.pin / soundbnk.pin: a single embedded song. Degenerate case of the exact same
//     shape (count == 1, one 4-byte offset pointing at the song's "MThd").
// A file is treated as this offset-table shape only if resolving every entry and checking for
// "MThd" at each resulting offset succeeds for at least half of them (see isOffsetTable below) --
// comfortably separates real tables (78/82, 81/82, 1/1, 1/1 hits) from everything else (0 hits,
// or the count word doesn't even fit the file) with no false positives across every .pin in
// data/. Files that don't pass fall back to a whole-file "MThd" scan, which is how the two
// standalone-song files were understood before this table format was confirmed, and still
// correctly handles driver-code-only .pin files (beeper.pin, tandy.pin, player.pin, level*.pin,
// sblaster.pin, adlib2/3.pin, autoplay.pin -- none of these contain a byte-valid SMF at all).
//
// The AdLib bank's cues (unlike Roland's, and unlike the two standalone songs) have no
// End-of-Track meta event in the source data -- the driver relies on its own length table
// instead. That makes each extracted cue a technically-invalid standalone SMF; players that
// don't tolerate a missing trailer can misbehave past the last real event (observed: VLC
// crashing on playback). This tool appends a synthetic FF 2F 00 to any track missing one.
//
// Usage: node tools/extract-pin.js <file.pin.raw> [out_dir]
//   Single embedded MIDI  -> <out_dir>/<name>.mid
//   Bank (table-shaped)   -> <out_dir>/<name>.NNN.mid, one per cue, NNN == the table's own
//                            entry index (== the game's sound_id), zero-padded to the table's
//                            width -- NOT a sequential count, so gaps from skipped non-MIDI
//                            entries are preserved rather than shifting every later ID down.
// Prints NO-MIDI and exits non-zero if no valid "MThd" chunk is found anywhere -- expected for
// driver-code-only .pin files (beeper.pin, tandy.pin, player.pin, level*.pin, etc.), not an error.

'use strict';

const fs = require('fs');
const path = require('path');

function readChunkHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  const id = buf.toString('ascii', offset, offset + 4);
  const len = buf.readUInt32BE(offset + 4);
  return { id, len, dataStart: offset + 8 };
}

// Walks MThd + consecutive MTrk chunks starting at `start`, returns the total byte length of
// the well-formed MIDI data (stops at the first non-MTrk chunk, truncated chunk, or EOF), or
// null if `start` isn't a valid MThd chunk.
function extractMidiAt(buf, start) {
  const mthd = readChunkHeader(buf, start);
  if (!mthd || mthd.id !== 'MThd') return null;
  if (mthd.len !== 6) return null; // SMF header chunk is always 6 bytes of payload
  if (mthd.dataStart + mthd.len > buf.length) return null;

  let offset = mthd.dataStart + mthd.len;
  const ntrks = buf.readUInt16BE(mthd.dataStart + 2);
  let tracksFound = 0;

  while (tracksFound < ntrks) {
    const chunk = readChunkHeader(buf, offset);
    if (!chunk || chunk.id !== 'MTrk') break;
    if (chunk.dataStart + chunk.len > buf.length) break; // truncated track, stop before it
    offset = chunk.dataStart + chunk.len;
    tracksFound++;
  }

  if (tracksFound === 0) return null;
  return { length: offset - start, ntrksDeclared: ntrks, ntrksFound: tracksFound };
}

function endsWithEndOfTrack(data) {
  return (
    data.length >= 3 &&
    data[data.length - 3] === 0xff &&
    data[data.length - 2] === 0x2f &&
    data[data.length - 1] === 0x00
  );
}

// The AdLib cue bank's individual cues have no End-of-Track meta event: the original driver
// data relies on its own cue-length table to know where a cue stops, so it never bothered
// writing the SMF-mandated FF 2F 00 trailer (Roland's cues and the two standalone songs do
// have one). A strict SMF reader (e.g. VLC's) requires it and will misbehave -- observed as a
// crash -- past the last real event, so we synthesize it per track rather than emit a
// technically-invalid file. Rebuilds the MTrk length fields to match rather than assuming the
// original table entries account for the extra bytes.
function ensureEndOfTrack(midiBuf) {
  const mthd = readChunkHeader(midiBuf, 0);
  const headerBytes = midiBuf.subarray(0, 8 + mthd.len);
  let pos = 8 + mthd.len;
  const trackDatas = [];
  let repairedCount = 0;

  while (pos < midiBuf.length) {
    const chunk = readChunkHeader(midiBuf, pos);
    if (!chunk || chunk.id !== 'MTrk') break;
    let data = midiBuf.subarray(chunk.dataStart, chunk.dataStart + chunk.len);
    if (!endsWithEndOfTrack(data)) {
      data = Buffer.concat([data, Buffer.from([0x00, 0xff, 0x2f, 0x00])]);
      repairedCount++;
    }
    trackDatas.push(data);
    pos = chunk.dataStart + chunk.len;
  }

  const parts = [headerBytes];
  for (const data of trackDatas) {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write('MTrk', 0, 'ascii');
    chunkHeader.writeUInt32BE(data.length, 4);
    parts.push(chunkHeader, data);
  }
  return { buffer: Buffer.concat(parts), repairedCount };
}

// Detects the count-prefixed offset-table shape described at the top of this file: a 2-byte
// entry count, then that many 4-byte little-endian file offsets. Returns the resolved entries
// (each { index, offset, midi: extractMidiAt(...) or null }) only if at least half resolve to a
// real "MThd" chunk -- otherwise returns null so the caller falls back to whole-file scanning.
function tryReadOffsetTable(buf) {
  if (buf.length < 2) return null;
  const count = buf.readUInt16LE(0);
  if (count < 1 || count > 500) return null; // sanity bound, not a real constraint of the format
  const tableEnd = 2 + count * 4;
  if (tableEnd > buf.length) return null;

  const entries = [];
  let mthdHits = 0;
  for (let i = 0; i < count; i++) {
    const offset = buf.readUInt32LE(2 + 4 * i);
    const midi = offset < buf.length ? extractMidiAt(buf, offset) : null;
    if (midi) mthdHits++;
    entries.push({ index: i, offset, midi });
  }
  if (mthdHits < count / 2) return null;
  return entries;
}

function findAllMidi(buf) {
  const found = [];
  let searchFrom = 0;
  while (true) {
    const magicOffset = buf.indexOf('MThd', searchFrom, 'ascii');
    if (magicOffset === -1) break;
    const result = extractMidiAt(buf, magicOffset);
    if (result) {
      found.push({ offset: magicOffset, ...result });
      searchFrom = magicOffset + result.length;
    } else {
      searchFrom = magicOffset + 4; // false positive (e.g. "MThd" inside track data) -- skip past it
    }
  }
  return found;
}

function main() {
  const [inputPath, outDirArg] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: node tools/extract-pin.js <file.pin.raw> [out_dir]');
    process.exit(1);
  }
  const buf = fs.readFileSync(inputPath);
  const outDir = outDirArg || path.dirname(inputPath);
  const baseName = path.basename(inputPath).replace(/(\.raw)?$/, '');

  const table = tryReadOffsetTable(buf);
  if (table) {
    extractFromTable(buf, table, outDir, baseName, inputPath);
    return;
  }

  const found = findAllMidi(buf);
  if (found.length === 0) {
    console.log(`${path.basename(inputPath)}: NO-MIDI (no valid "MThd" chunk found)`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const pad = String(found.length - 1).length;
  let totalRepaired = 0;
  found.forEach((cue, i) => {
    const rawCue = buf.subarray(cue.offset, cue.offset + cue.length);
    const { buffer: midiData, repairedCount } = ensureEndOfTrack(rawCue);
    totalRepaired += repairedCount;
    const outPath =
      found.length === 1
        ? path.join(outDir, `${baseName}.mid`)
        : path.join(outDir, `${baseName}.${String(i).padStart(pad, '0')}.mid`);
    fs.writeFileSync(outPath, midiData);
  });

  const lastCue = found[found.length - 1];
  const trailingBytes = buf.length - (lastCue.offset + lastCue.length);
  console.log(
    `${path.basename(inputPath)}: ${found.length} embedded MIDI cue${found.length === 1 ? '' : 's'} ` +
      `(offsets ${found.map((c) => c.offset).join(', ')}) -> ${outDir}/${baseName}${found.length === 1 ? '.mid' : '.NNN.mid'}` +
      (trailingBytes > 0 ? ` (${trailingBytes} trailing bytes after the last cue unaccounted for)` : '') +
      (totalRepaired > 0 ? ` (added missing End-of-Track meta event to ${totalRepaired} track${totalRepaired === 1 ? '' : 's'})` : '')
  );
}

// Extracts a validated offset-table bank: one file per table entry that resolves to a real MIDI
// cue, named by its table INDEX (== the game's sound_id) rather than a sequential count, so
// non-MIDI entries leave a gap instead of shifting every later ID down by one.
function extractFromTable(buf, entries, outDir, baseName, inputPath) {
  const count = entries.length;
  const midiEntries = entries.filter((e) => e.midi);
  const nonMidiEntries = entries.filter((e) => !e.midi);

  if (count === 1) {
    // Degenerate case (roland2.pin / soundbnk.pin): a single embedded song, no index suffix.
    const entry = entries[0];
    if (!entry.midi) {
      console.log(`${path.basename(inputPath)}: NO-MIDI (table entry did not resolve to "MThd")`);
      process.exit(1);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const rawCue = buf.subarray(entry.offset, entry.offset + entry.midi.length);
    const { buffer: midiData, repairedCount } = ensureEndOfTrack(rawCue);
    fs.writeFileSync(path.join(outDir, `${baseName}.mid`), midiData);
    console.log(
      `${path.basename(inputPath)}: 1 embedded MIDI song (offset ${entry.offset}) -> ${outDir}/${baseName}.mid` +
        (repairedCount > 0 ? ' (added missing End-of-Track meta event)' : '')
    );
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const pad = String(count - 1).length;
  let totalRepaired = 0;
  for (const entry of midiEntries) {
    const rawCue = buf.subarray(entry.offset, entry.offset + entry.midi.length);
    const { buffer: midiData, repairedCount } = ensureEndOfTrack(rawCue);
    totalRepaired += repairedCount;
    const outPath = path.join(outDir, `${baseName}.${String(entry.index).padStart(pad, '0')}.mid`);
    fs.writeFileSync(outPath, midiData);
  }

  console.log(
    `${path.basename(inputPath)}: offset table with ${count} entries, ${midiEntries.length} MIDI cue${midiEntries.length === 1 ? '' : 's'} ` +
      `-> ${outDir}/${baseName}.NNN.mid (NNN == table index / sound_id, not sequential)` +
      (totalRepaired > 0 ? ` (added missing End-of-Track meta event to ${totalRepaired} track${totalRepaired === 1 ? '' : 's'})` : '')
  );
  if (nonMidiEntries.length > 0) {
    console.log(
      `  NON-MIDI entries skipped (sound_id -> file offset, not a standalone SMF -- likely an OPL2 hardware control sequence): ` +
        nonMidiEntries.map((e) => `${e.index}->${e.offset}`).join(', ')
    );
  }
}

main();
