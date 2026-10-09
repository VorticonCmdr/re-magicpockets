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
    const m = /ROW (\d+) (\d+),(\d+) G:([0-9a-f]+) E:([0-9a-f=;]*)/.exec(line);
    if (!m) continue;
    const e = m[5] ? m[5].split(';').map((s) => { const [p, h] = s.split('='); return { ptr: parseInt(p, 16), hex: h }; }) : [];
    rows.push({ done: Number(m[1]), rec: Number(m[2]), rem: Number(m[3]), g: m[4], e });
  }
  return rows;
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
  writeFileSync(outPath, JSON.stringify({ globalsBase: GLOBALS_BASE, rows }));
  console.log(`wrote ${outPath}`);
}
