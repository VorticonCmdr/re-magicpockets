// Level-script (.pin) entity-placement decoder -- port of tools/extract-level-script.js, minus
// the CLI/JSON-file plumbing. Despite the shared .pin extension with the sound files (pin.js is
// a separate format, see docs/formats/pin.md), these are level-scripting bytecode: header of
// BE16 sub-level entry offsets, then per-sub-level record streams of entity-spawn records plus
// four control markers. See docs/formats/pin-level-script.md.

'use strict';

function be16(b, o) {
  return (b[o] << 8) | b[o + 1];
}

function signed16(v) {
  return v >= 0x8000 ? v - 0x10000 : v;
}

// generic-layout payload word count, indexed by BX (the layout-selector word).
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

/** Decode a depacked level-script .pin buffer (Uint8Array) into its sub-levels + deduplicated entities. */
export function decodeLevelScript(buf) {
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
