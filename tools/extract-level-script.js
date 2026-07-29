#!/usr/bin/env node
// Extracts entity/object PLACEMENT data (enemies, items, triggers) from the per-world level-
// script files: new1.pin (world 1; level0.pin is an alternate/demo variant conditionally loaded
// instead of new1.pin when [0x8b89]==0), level2.pin (world 2), level3a/b/c.pin (world 3),
// level4.pin (world 4). Despite the shared .pin extension, these are NOT sound files (no embedded MIDI) --
// they are a level-scripting bytecode consumed by Level_RunScriptedEventStream (1000:c1e6) and
// Entity_SpawnFromQueuedEvent (1000:c2f3). See docs/formats/pin-level-script.md for the full
// reverse-engineering trail.
//
// On-disk format (confirmed from Level_RunScriptedEventStream's raw disassembly):
//
//   header: a sequence of BE16 "sub-level" entry-point byte offsets into this same file,
//           terminated by a sentinel value >= the file's own length (usually the file length
//           itself, repeated).
//
//   Each sub-level is an independent record stream starting at its header offset:
//     word0 = marker (BE16): 0xAAAA/0xBBBB/0xCCCC/0xDDDD are control opcodes (see below);
//             any other value marks a generic entity-spawn record (the marker's own value
//             isn't meaningful data, just a "not a control opcode" discriminant -- 0xEEEE in
//             practice, but nothing checks for that literal value).
//     word1 = BX: a word-count "layout selector" (NOT a literal payload word count -- see
//             WORDS_BY_BX) that both picks how many payload words follow *and* is passed to
//             Entity_SpawnFromQueuedEvent as its layout-selector argument ([0x8c1b]).
//     word2 = AX: entity type (-> runtime entity struct field +2). Values 0x11/0x1d/0x1f/0x25/
//             0x2b/0x2f/0x44/0x53/0x5e get bespoke field layouts in Entity_SpawnFromQueuedEvent;
//             every other type takes the generic layout used here.
//     payload: WORDS_BY_BX[BX] further BE16 words. Generic layout: payload[0]=X (-> entity+6),
//              payload[1]=Y (-> entity+8), payload[2..]=further state/script-lookup fields not
//              decoded here (only position + type are extracted).
//
//   Control opcodes (word0): 0xAAAA (terminal -- ends this sub-level's stream; also special-
//   cases a world1/sublevel6 cutscene trigger), 0xBBBB (4 bytes total -- looks up a named
//   sub-level's target position, doesn't affect subsequent entity coordinates), 0xCCCC (4 bytes
//   total -- a timed wait, busy-polls a frame counter), 0xDDDD (terminal -- starts the attract-
//   mode demo).
//
// Multiple sub-level entry points often re-enter (a shared/overlapping) tail of the same
// physical byte stream (e.g. an alternate "start slightly further in" entry point for a
// checkpoint) -- entities are deduplicated by their file offset across all sub-level walks.
//
// Coordinate system: X/Y appear to be level-space pixel coordinates (matching blocksN.pak's
// 32x16 tile grid), confirmed by many same-type entities forming coherent horizontal rows at a
// consistent Y (a repeated platform decoration/pickup line) when overlaid on the rendered level.
// A meaningful fraction of records have negative or otherwise out-of-frame X/Y -- not yet
// explained (likely legitimate off-map spawn triggers, or a per-sub-level coordinate base this
// extractor doesn't apply -- see the "open questions" note in the format doc). Reported as-is.
//
// Usage: node tools/extract-level-script.js <file.pin.raw> [out.json]

'use strict';

const fs = require('fs');
const path = require('path');

function be16(b, o) { return (b[o] << 8) | b[o + 1]; }
function signed16(v) { return v >= 0x8000 ? v - 0x10000 : v; }

// generic-layout payload word count, indexed by BX (the layout-selector word) -- see
// Entity_SpawnFromQueuedEvent's decompile for the derivation of each case.
const WORDS_BY_BX = { 2: 2, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 6 };
const GUARD_LIMIT = 5000;

function parseSublevel(buf, startOffset, sublevelIndex) {
  let p = startOffset;
  const entities = [];
  const events = [];
  let guard = 0;
  while (p < buf.length - 1 && guard++ < GUARD_LIMIT) {
    const marker = be16(buf, p);
    if (marker === 0xaaaa) {
      events.push({ offset: p, kind: 'AAAA_TRIGGER' });
      return { entities, events, endOffset: p + 2, terminal: 'AAAA' };
    }
    if (marker === 0xbbbb) {
      events.push({ offset: p, kind: 'BBBB_SUBLEVEL_POS', arg: be16(buf, p + 2) });
      p += 4;
      continue;
    }
    if (marker === 0xcccc) {
      events.push({ offset: p, kind: 'CCCC_WAIT', waitTarget: be16(buf, p + 2) });
      p += 4;
      continue;
    }
    if (marker === 0xdddd) {
      events.push({ offset: p, kind: 'DDDD_ATTRACT_DEMO' });
      return { entities, events, endOffset: p + 2, terminal: 'DDDD' };
    }

    const bx = be16(buf, p + 2);
    const type = be16(buf, p + 4);
    const wc = WORDS_BY_BX[bx];
    if (wc === undefined || p + 6 + wc * 2 > buf.length) {
      return { entities, events, endOffset: p, terminal: 'BAIL', bailMarker: marker, bailBx: bx, bailType: type };
    }
    const payload = [];
    for (let i = 0; i < wc; i++) payload.push(be16(buf, p + 6 + i * 2));
    const rec = { offset: p, bx, type, payload, sublevel: sublevelIndex };
    if (payload.length >= 2) {
      rec.x = signed16(payload[0]);
      rec.y = signed16(payload[1]);
    }
    entities.push(rec);
    p += 6 + wc * 2;
  }
  return { entities, events, endOffset: p, terminal: guard >= GUARD_LIMIT ? 'GUARD_LIMIT' : 'EOF' };
}

function parseLevelScript(buf) {
  const offsets = [];
  let i = 0;
  while (i < buf.length - 1) {
    const v = be16(buf, i);
    i += 2;
    if (v >= buf.length) break; // terminator sentinel(s)
    offsets.push(v);
    if (offsets.length > 64) break; // sanity
  }
  const sublevels = offsets.map((off, idx) => ({ sublevelIndex: idx, startOffset: off, ...parseSublevel(buf, off, idx) }));

  // De-duplicate entities by file offset -- overlapping sub-level entry points often re-walk
  // the same physical tail of the stream.
  const byOffset = new Map();
  for (const sl of sublevels) {
    for (const e of sl.entities) {
      if (!byOffset.has(e.offset)) byOffset.set(e.offset, e);
    }
  }
  const entities = [...byOffset.values()].sort((a, b) => a.offset - b.offset);

  return { fileSize: buf.length, headerBytes: i, offsets, sublevels, entities };
}

function main() {
  const [inputPath, outputArg] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: node tools/extract-level-script.js <file.pin.raw> [out.json]');
    process.exit(1);
  }
  const buf = fs.readFileSync(inputPath);
  const parsed = parseLevelScript(buf);
  const outputPath = outputArg || inputPath.replace(/(\.raw)?$/, '') + '.json';

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        fileSize: parsed.fileSize,
        sublevelCount: parsed.offsets.length,
        entities: parsed.entities,
        sublevels: parsed.sublevels.map((s) => ({
          sublevelIndex: s.sublevelIndex,
          startOffset: s.startOffset,
          endOffset: s.endOffset,
          terminal: s.terminal,
          entityCount: s.entities.length,
          events: s.events,
        })),
      },
      null,
      1
    )
  );

  const terminals = {};
  for (const s of parsed.sublevels) terminals[s.terminal] = (terminals[s.terminal] || 0) + 1;
  console.log(
    `${path.basename(inputPath)}: ${parsed.offsets.length} sub-levels, ${parsed.entities.length} unique entity records ` +
      `-> ${outputPath} (terminals: ${JSON.stringify(terminals)})`
  );
}

main();
