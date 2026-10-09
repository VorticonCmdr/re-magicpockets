// One-step conformance of the ported iteration against a DOSBox capture (see
// tools/attract-capture/conformance.mjs for the CLI and the sampling rules). Shared by the CLI and
// by `npm run verify`, which asserts a ratchet on the number of exact transitions.

import { rncUnpack } from '../core/rnc.js';
import { decodeDemoTape } from '../core/demo-tape.js';
import { DsMemory, ENTITY_ARRAY, ENTITY_ARRAY_END, ENTITY_SIZE } from '../engine/ds-memory.js';
import { stepIteration } from '../engine/iteration.js';
import { rebuildVisibleList } from '../engine/entity-behavior.js';

export const GLOBALS_BASE = 0x8b50;
// Probe results, scratch words, the list cursor and the sound timer: byproducts, not game state.
export const SCRATCH = [[0x8bc5, 0x8bec], [0x8c1b, 0x8c2a], [0x8b87, 0x8b88], [0x8bad, 0x8bad], [0x8bd5, 0x8be4]];
const isScratch = (a) => SCRATCH.some(([lo, hi]) => a >= lo && a <= hi);
const hexBytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

export function prepare(exeBytes, tapeFile, papFile) {
  const base = new DsMemory(exeBytes);
  const tape = rncUnpack(tapeFile).data;
  const grid = rncUnpack(papFile).data;
  const map = new Uint8Array(128 * 128);
  for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) map[c * 128 + r] = grid[r * 128 + c]; // column-major
  const states = [];
  for (const rec of decodeDemoTape(tape).records) for (let i = 0; i < rec.count; i++) states.push(rec.state);
  return { base, tape, map, states };
}

/** Build a memory image from a captured row. */
export function loadRow(env, row) {
  const m = env.base.clone();
  m.put(0x8200, env.tape);
  m.put(0x4200, env.map);
  m.w16(0xef23, 0xefa5); // world 1's tile table (set by the new-game initializer)
  m.put(GLOBALS_BASE, hexBytes(row.g));
  for (let o = ENTITY_ARRAY; o < ENTITY_ARRAY_END; o += 2) m.w16(o, 0);
  row.e.forEach((e, i) => { m.w16(ENTITY_ARRAY + 2 * i, e.ptr); m.put(e.ptr, hexBytes(e.hex)); });
  // The captured row has no copy of the 0x91BE list; rebuild it from positions without scrolling.
  const dx = m.u16(0x8bb7), dy = m.u16(0x8bb9);
  m.w16(0x8bb7, 0); m.w16(0x8bb9, 0);
  rebuildVisibleList(m);
  m.w16(0x8bb7, dx); m.w16(0x8bb9, dy);
  return m;
}

/**
 * @param {object} env from prepare()
 * @param {Array} rows captured rows
 * @param {{from?:number,to?:number,ents?:number,only?:number,ignoreScratch?:boolean,show?:number}} o
 */
export function runConformance(env, rows, o = {}) {
  const from = o.from ?? 0, to = Math.min(o.to ?? rows.length - 1, rows.length - 1), cmpN = o.ents ?? 99;
  const entHist = new Map(), globHist = new Map(), unportedHist = new Map(), shown = [];
  let exact = 0, entExact = 0, total = 0;
  const firstBad = [];
  for (let k = from; k < to; k++) {
    const a = rows[k], b = rows[k + 1];
    const m = loadRow(env, a);
    const ctx = { unported: new Set(), events: [] };
    stepIteration(m, ctx, o.only ? new Set(a.e.slice(0, o.only).map((e) => e.ptr)) : null);
    for (const u of ctx.unported) unportedHist.set(u, (unportedHist.get(u) || 0) + 1);
    let entBad = 0, globBad = 0;
    const lines = [];
    b.e.slice(0, cmpN).forEach((e, i) => {
      const want = hexBytes(e.hex), got = m.get(e.ptr, ENTITY_SIZE);
      for (let off = 0; off < ENTITY_SIZE; off++) if (want[off] !== got[off]) {
        entBad++; const key = `e${i} +0x${off.toString(16)}`; entHist.set(key, (entHist.get(key) || 0) + 1);
        lines.push(`${key} want ${want[off]} got ${got[off]}`);
      }
    });
    const gwant = hexBytes(b.g), ggot = m.get(GLOBALS_BASE, gwant.length), gbefore = hexBytes(a.g);
    for (let off = 0; off < gwant.length; off++) if (gwant[off] !== ggot[off] && !(o.ignoreScratch && isScratch(GLOBALS_BASE + off))) {
      globBad++; const key = `0x${(GLOBALS_BASE + off).toString(16)}`; globHist.set(key, (globHist.get(key) || 0) + 1);
      lines.push(`G ${key} want ${gwant[off]} got ${ggot[off]} (before ${gbefore[off]})`);
    }
    if (b.done === o.show) shown.push(`transition into ${b.done}: ${lines.join('; ') || 'exact'}  unported: ${[...ctx.unported].join(', ')}`);
    total++;
    if (!entBad) entExact++;
    if (!entBad && !globBad) exact++; else if (firstBad.length < 3) firstBad.push(`${b.done} (entity bytes ${entBad}, global bytes ${globBad})`);
  }
  return { total, entExact, exact, firstBad, entHist, globHist, unportedHist, shown };
}
