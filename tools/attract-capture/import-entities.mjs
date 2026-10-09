/* import-entities.mjs — parse a capture-full.lua debug log.
 *
 *   node tools/attract-capture/import-entities.mjs <lua-debug.log> [out.json]
 *
 * Output: { globalsBase: 0x8B50, rows: [{ done, rec, rem, g: <hex>, e: [{ ptr, hex }] }] }.
 * Hex strings are kept as-is (2 chars per byte); helpers in this file decode them on demand.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const GLOBALS_BASE = 0x8b50;
export const ENTITY_BYTES = 66;

export function parseEntityLog(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /ROW (\d+) (\d+),(\d+) G:([0-9a-f]+)(?: P:([0-9a-f]+) L:([0-9a-f]+) Q:([0-9a-f]+))?(?: E:([0-9a-f=;]*)| B:([0-9a-f]+))/.exec(line);
    if (!m) continue;
    let e = m[8] ? m[8].split(';').map((s) => { const [p, h] = s.split('='); return { ptr: parseInt(p, 16), hex: h }; }) : [];
    let x = [];
    if (m[9]) { // B: first 40 records of the entity block; follow the pointer array P in order
      e = [];
      for (let i = 0; i + 4 <= m[5].length; i += 4) {
        const ptr = parseInt(m[5].substr(i + 2, 2) + m[5].substr(i, 2), 16);
        if (ptr === 0 || ptr === 0xffff) break;
        const off = ptr - 0x9398;
        if (off < 0 || off % ENTITY_BYTES !== 0 || (off / ENTITY_BYTES + 1) * ENTITY_BYTES * 2 > m[9].length) throw new Error(`entity ${ptr.toString(16)} is outside the captured block`);
        e.push({ ptr, hex: m[9].substr(off * 2, ENTITY_BYTES * 2) });
      }
      // Records outside the pointer array that are not all zero (the allocator skips those with class != 0).
      const used = new Set(e.map((x) => x.ptr));
      x = [];
      for (let off = 0; (off + ENTITY_BYTES) * 2 <= m[9].length; off += ENTITY_BYTES) {
        const ptr = 0x9398 + off, hex = m[9].substr(off * 2, ENTITY_BYTES * 2);
        if (!used.has(ptr) && /[1-9a-f]/.test(hex)) x.push({ ptr, hex });
      }
    }
    const row = { done: Number(m[1]), rec: Number(m[2]), rem: Number(m[3]), g: m[4], e };
    if (m[5]) { row.p = m[5]; row.l = m[6]; row.q = m[7]; if (x.length) row.x = x; }
    rows.push(row);
  }
  return rows;
}

/**
 * Rows from a B:-style capture list every referenced entity record (up to ~110, most of them inert
 * scenery). Store each record only in the row where it first appears or changes (`d: [[ptr, hex]]`)
 * plus the pointer order (`p`); web/verify/conformance-lib.js expandRows() rebuilds `e`.
 */
export function compressRows(rows) {
  const last = new Map();
  return rows.map((r) => {
    if (r.p === undefined) return r;
    const d = [];
    for (const e of r.e) if (last.get(e.ptr) !== e.hex) { d.push([e.ptr, e.hex]); last.set(e.ptr, e.hex); }
    const dx = [];
    for (const e of r.x || []) if (last.get(e.ptr) !== e.hex) { dx.push([e.ptr, e.hex]); last.set(e.ptr, e.hex); }
    const { e, x, ...rest } = r;
    return { ...rest, ptrs: r.e.map((v) => v.ptr), d, xptrs: (x || []).map((v) => v.ptr), dx };
  });
}

const bytesOf = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
export const entityBytes = (e) => bytesOf(e.hex);
export const globalsBytes = (row) => bytesOf(row.g);
export const word = (b, o) => b[o] | (b[o + 1] << 8);
export const sword = (b, o) => { const v = word(b, o); return v >= 0x8000 ? v - 0x10000 : v; };
export const gbyte = (row, ds) => parseInt(row.g.substr((ds - GLOBALS_BASE) * 2, 2), 16);
export const gword = (row, ds) => gbyte(row, ds) | (gbyte(row, ds + 1) << 8);

if (process.argv[1] && process.argv[1].endsWith('import-entities.mjs')) {
  const [, , inPath, outPath = 'build/attract/entities.capture.json'] = process.argv;
  if (!inPath) { console.error('usage: import-entities.mjs <log> [out.json]'); process.exit(2); }
  const rows = parseEntityLog(readFileSync(inPath, 'utf8'));
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].done !== rows[i - 1].done + 1) gaps++;
  console.log(`rows ${rows.length}, done ${rows[0]?.done}..${rows.at(-1)?.done}, gaps ${gaps}, max entities ${Math.max(...rows.map((r) => r.e.length))}`);
  if (gaps) { console.error('refusing: gaps in the capture'); process.exit(1); }
  writeFileSync(outPath, JSON.stringify({ globalsBase: GLOBALS_BASE, rows: compressRows(rows) }));
  console.log(`wrote ${outPath}`);
}
