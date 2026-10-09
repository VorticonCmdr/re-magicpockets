/* conformance.mjs — one-step conformance of the ported iteration against a DOSBox capture.
 *
 *   node tools/attract-capture/conformance.mjs [capture.json] [--from N] [--to M] [--top K]
 *        [--ents N] [--ignore-scratch] [--only N] [--show DONE]
 *
 * For every consecutive pair of captured rows (k, k+1): load row k into a DsMemory (the EXE's
 * data image overlaid with the captured globals block and entity records), run one
 * stepIteration() with the tape's input, and compare the entity records and globals with row
 * k+1. Mismatches are histogrammed so the output is the list of what is still unported, ranked.
 *   --ents N          compare only the first N entities of each row
 *   --ignore-scratch  skip probe/scratch globals and the sound timer
 *   --only N          run (not just compare) only the first N entities
 *   --show DONE       print every differing byte of the transition into iteration DONE
 */
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { prepare, runConformance } from '../../web/verify/conformance-lib.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const capPath = args.find((a) => !a.startsWith('--') && Number.isNaN(Number(a))) || 'tools/attract-capture/entities-full.capture.json.gz';
const root = new URL('../../', import.meta.url).pathname;
if (!existsSync(root + capPath)) { console.error(`missing ${capPath}`); process.exit(2); }
const env = prepare(new Uint8Array(readFileSync(root + 'game/GAMEU.EXE')), new Uint8Array(readFileSync(root + 'data/autoplay.pin')), new Uint8Array(readFileSync(root + 'data/pcmap.pap')));
const text = capPath.endsWith('.gz') ? gunzipSync(readFileSync(root + capPath)).toString('utf8') : readFileSync(root + capPath, 'utf8');
const rows = JSON.parse(text).rows;
const top = flag('--top', 14);
const r = runConformance(env, rows, { from: flag('--from', 0), to: flag('--to', rows.length - 1), ents: flag('--ents', 999), only: flag('--only', 0), ignoreScratch: args.includes('--ignore-scratch'), show: flag('--show', -1) });
const fmt = (h) => [...h].sort((x, y) => y[1] - x[1]).slice(0, top).map(([k, n]) => `${k} x${n}`).join('  ') || 'none';
for (const s of r.shown) console.log(s);
console.log(`transitions ${r.total}: entity records exact ${r.entExact}, entities+globals exact ${r.exact}`);
console.log(`first inexact transitions: ${r.firstBad.join('; ') || 'none'}`);
console.log(`worst entity fields : ${fmt(r.entHist)}`);
console.log(`worst global bytes  : ${fmt(r.globHist)}`);
console.log(`unported branches hit (transitions): ${fmt(r.unportedHist)}`);
