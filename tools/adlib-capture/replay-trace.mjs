// node tools/adlib-capture/replay-trace.mjs <capture.trace> : replays a DOSBox capture of the AdLib driver (format and method:
// web/audio/trace-replay.js, docs/formats/pin-sound.md "DOSBox capture") and prints the first mismatch of the OPL2 write stream.
import { readFileSync } from 'node:fs';
import { parseTrace, replay } from '../../web/audio/trace-replay.js';
import { rncUnpack } from '../../web/core/rnc.js';

const root = new URL('../../', import.meta.url).pathname;
const un = (n) => rncUnpack(new Uint8Array(readFileSync(root + 'data/' + n))).data;
const r = replay(parseTrace(readFileSync(process.argv[2], 'utf8')), un('player.pin'), un('adlib.pin'));
console.log('stream length dosbox', r.dos.length, 'oracle', r.ora.length, 'first mismatch', r.first);
if (r.first >= 0) console.log('dosbox', r.dos.slice(Math.max(0, r.first - 5), r.first + 8).join(' '), '\noracle', r.ora.slice(Math.max(0, r.first - 5), r.first + 8).join(' '));
