/* import-log.mjs — turn a capture.lua debug log into autoplay.capture.json.
 *
 *   node tools/attract-capture/import-log.mjs <lua-debug.log> [out.json]
 *
 * Each `dosbox.log("ROW <done> <fields>")` line is one main-loop iteration: `done` is how many
 * Demo_PlaybackInput calls had happened when the row was sampled (the state AFTER iteration
 * `done`). Words come out of DOSBox unsigned; positions are reinterpreted as signed 16-bit.
 * The importer refuses a capture with a gap or a repeat in `done`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath = 'build/attract/autoplay.capture.json'] = process.argv;
if (!inPath) { console.error('usage: import-log.mjs <log> [out.json]'); process.exit(2); }

const s16 = (v) => (v >= 0x8000 ? v - 0x10000 : v);
const FIELDS = ['rec', 'rem', 'e0x', 'e0y', 'e1x', 'e1y', 'e1state', 'e1flags', 'e1kind', 'rng', 'score', 'camx', 'camy'];
const SIGNED = new Set(['e0x', 'e0y', 'e1x', 'e1y', 'camx', 'camy']);

const rows = [];
for (const line of readFileSync(inPath, 'utf8').split('\n')) {
  const m = /ROW (\d+) ([\d,]+)/.exec(line);
  if (!m) continue;
  const v = m[2].split(',').map(Number);
  if (v.length !== FIELDS.length) throw new Error(`bad row: ${line}`);
  const row = { done: Number(m[1]) };
  FIELDS.forEach((f, i) => { row[f] = SIGNED.has(f) ? s16(v[i]) : v[i]; });
  rows.push(row);
}

// The final sample is taken while the game tears down after the tape's 0xFFFF terminator, so its
// memory reads are junk (slot 1's kind is no longer 3). Trim trailing rows that fail that check.
let trimmed = 0;
while (rows.length && rows.at(-1).e1kind !== 3) { rows.pop(); trimmed++; }
if (trimmed) console.log(`trimmed ${trimmed} trailing row(s) with a junk slot-1 kind`);

let gaps = 0, repeats = 0;
for (let i = 1; i < rows.length; i++) {
  if (rows[i].done === rows[i - 1].done) repeats++;
  else if (rows[i].done !== rows[i - 1].done + 1) gaps++;
}
const scrollTracksCamera = rows.every((r) => r.camx === r.e0x && r.camy === r.e0y);

console.log(`rows ${rows.length}, first done ${rows[0]?.done}, last done ${rows.at(-1)?.done}, gaps ${gaps}, repeats ${repeats}`);
console.log(`camera globals equal slot 0 on every row: ${scrollTracksCamera}`);
if (gaps || repeats) { console.error('refusing to write a capture with gaps or repeats'); process.exit(1); }
writeFileSync(outPath, JSON.stringify({ source: inPath.split('/').pop(), fields: FIELDS, rows }));
console.log(`wrote ${outPath}`);
