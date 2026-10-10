/* conformance-live.mjs — one-step conformance of the ported iteration against a live-play capture.
 *
 *   node tools/attract-capture/conformance-live.mjs [capture.json[.gz]] [--from N] [--to N] [--show K] [--top K] [--ent-fails]
 *
 * Rows come from capture-live.lua (sampled right after call #13). For each transition the NEXT row's
 * key bytes feed call #7, then every captured entity record and non-scratch global of that row is
 * compared (runLiveConformance in web/verify/conformance-lib.js). */
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { prepare, runLiveConformance } from '../../web/verify/conformance-lib.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const capPath = args.find((a) => !a.startsWith('--') && Number.isNaN(Number(a))) || 'tools/attract-capture/live1.capture.json.gz';
const root = new URL('../../', import.meta.url).pathname;
if (!existsSync(root + capPath)) { console.error(`missing ${capPath}`); process.exit(2); }
const env = prepare(new Uint8Array(readFileSync(root + 'game/GAMEU.EXE')), new Uint8Array(readFileSync(root + 'data/autoplay.pin')), new Uint8Array(readFileSync(root + 'data/pcmap.pap')));
const raw = readFileSync(root + capPath);
const rows = JSON.parse((capPath.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')).rows;
const r = runLiveConformance(env, rows, { from: flag('--from', 1), to: flag('--to', rows.length - 1), show: flag('--show', 6) });
console.log(`transitions ${r.total}: entity records exact ${r.entExact}, entities+globals exact ${r.exact} (${r.raceRows} of them differ only in the camera sample-race globals)`);
for (const s of r.shown) console.log(s);
if (args.includes('--ent-fails')) for (const f of r.entFails) console.log(f);
const top = flag('--top', 14);
console.log('top differing fields:', [...r.hist].sort((x, y) => y[1] - x[1]).slice(0, top).map(([k, n]) => `${k} x${n}`).join('  ') || 'none');
console.log('unported branches hit:', [...r.unportedHist].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} x${n}`).join(', ') || 'none');
