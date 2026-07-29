#!/usr/bin/env node
// Extracts embedded Standard MIDI File (SMF) resources from a depacked .pin sound-driver/data
// file, as playable .mid files.
//
// Empirical finding (byte-scan based -- not yet cross-verified against Ghidra disassembly of
// the driver-invocation code; see docs/formats/pin.md): several .pin files contain one or more
// byte-for-byte valid SMFs (an "MThd" header chunk followed by its "MTrk" chunks). Two shapes
// seen:
//   - roland2.pin / soundbnk.pin: a single embedded song. A small fixed-shape header's 2nd word
//     is the exact byte offset to "MThd".
//   - adlib.pin / roland.pin: a SOUND-EFFECT BANK -- 78-81 tiny individual MIDI cues
//     concatenated back-to-back (one per sound effect), preceded by driver code and a
//     resource-offset table whose entries point at each cue.
// This tool doesn't trust either header shape; it just scans the whole file for every "MThd"
// occurrence and walks real MIDI chunk lengths from each one, so it extracts correctly
// regardless of which shape produced the file, and finds every cue in a bank uniformly.
//
// Usage: node tools/extract-pin.js <file.pin.raw> [out_dir]
//   Single embedded MIDI  -> <out_dir>/<name>.mid
//   Multiple (a bank)     -> <out_dir>/<name>.NNN.mid (one per cue, zero-padded index)
//   out_dir defaults to the input file's directory.
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
  const found = findAllMidi(buf);

  if (found.length === 0) {
    console.log(`${path.basename(inputPath)}: NO-MIDI (no valid "MThd" chunk found)`);
    process.exit(1);
  }

  const outDir = outDirArg || path.dirname(inputPath);
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = path.basename(inputPath).replace(/(\.raw)?$/, '');

  const pad = String(found.length - 1).length;
  found.forEach((cue, i) => {
    const midiData = buf.subarray(cue.offset, cue.offset + cue.length);
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
      (trailingBytes > 0 ? ` (${trailingBytes} trailing bytes after the last cue unaccounted for)` : '')
  );
}

main();
