// One-step conformance of the ported iteration against a DOSBox capture (see
// tools/attract-capture/conformance.mjs for the CLI and the sampling rules). Shared by the CLI and
// by `npm run verify`, which asserts a ratchet on the number of exact transitions.

import { rncUnpack } from '../core/rnc.js';
import { decodeDemoTape } from '../core/demo-tape.js';
import { DsMemory, ENTITY_ARRAY, ENTITY_ARRAY_END, ENTITY_SIZE } from '../engine/ds-memory.js';
import { stepIteration } from '../engine/iteration.js';
import { rebuildVisibleList } from '../engine/entity-behavior.js';

export const GLOBALS_BASE = 0x8b50;
// Probe results, scratch words, list cursors, the render row counter and the timer ISR's seconds
// and minutes counters ([8BAD]-[8BAF], advanced by the 50 Hz interrupt, not by the main loop):
// byproducts and asynchronous state, not game state.
export const SCRATCH = [[0x8bc5, 0x8bec], [0x8c1b, 0x8c2a], [0x8b87, 0x8b88], [0x8bad, 0x8baf], [0x8bd5, 0x8be4],
  [0x8b9c, 0x8b9d], [0x8c77, 0x8c7c]];
const isScratch = (a) => SCRATCH.some(([lo, hi]) => a >= lo && a <= hi);
const hexBytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

/** Rebuild each row's full entity list `e` from a compressed capture (see import-entities.mjs compressRows). */
export function expandRows(rows) {
  if (!rows.some((r) => r.ptrs)) return rows;
  const cur = new Map();
  return rows.map((r) => {
    if (!r.ptrs) return r;
    for (const [ptr, hex] of r.d) cur.set(ptr, hex);
    for (const [ptr, hex] of r.dx || []) cur.set(ptr, hex);
    return { ...r, e: r.ptrs.map((ptr) => ({ ptr, hex: cur.get(ptr) })), x: (r.xptrs || []).map((ptr) => ({ ptr, hex: cur.get(ptr) })) };
  });
}

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
  if (row.q) m.put(0x9270, hexBytes(row.q)); // the spawn queue region (0x9270..0x939B), when captured
  for (let o = ENTITY_ARRAY; o < ENTITY_ARRAY_END; o += 2) m.w16(o, 0);
  row.e.forEach((e, i) => { m.w16(ENTITY_ARRAY + 2 * i, e.ptr); m.put(e.ptr, hexBytes(e.hex)); });
  for (const e of row.x || []) m.put(e.ptr, hexBytes(e.hex)); // live records outside the pointer array
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
  rows = expandRows(rows);
  const from = o.from ?? 0, to = Math.min(o.to ?? rows.length - 1, rows.length - 1), cmpN = o.ents ?? 999;
  const entHist = new Map(), globHist = new Map(), unportedHist = new Map(), shown = [];
  let exact = 0, entExact = 0, total = 0;
  const firstBad = [];
  for (let k = from; k < to; k++) {
    const a = rows[k], b = rows[k + 1];
    if (o.skip?.has(b.done)) continue;
    const m = loadRow(env, a);
    const ctx = { unported: new Set(), events: [] };
    const only = o.only ? new Set(a.e.slice(0, o.only).map((e) => e.ptr)) : null;
    const key = (mm) => (mm.u16(0x8ba6) << 8 | mm.u8(0x8ba8)) & 0xffffff;
    const want = (0x8200 + 2 * b.rec) << 8 | b.rem;
    stepIteration(m, ctx, only);
    // The tape stalls while [8BA1] == 0x45 (1000:0159), so a captured row (the last poll before the
    // tape position changes) can span several main-loop iterations: keep stepping while the
    // position stays on this row's, and back out of the step that would leave it.
    let mm = m;
    for (let extra = 0; extra < 400 && key(mm) === want; extra++) {
      const next = mm.clone();
      stepIteration(next, ctx, only);
      if (key(next) !== want) break;
      mm = next;
    }
    const mFinal = mm;
    for (const u of ctx.unported) unportedHist.set(u, (unportedHist.get(u) || 0) + 1);
    let entBad = 0, globBad = 0;
    const lines = [];
    b.e.slice(0, cmpN).forEach((e, i) => {
      const want = hexBytes(e.hex), got = mFinal.get(e.ptr, ENTITY_SIZE);
      for (let off = 0; off < ENTITY_SIZE; off++) if (want[off] !== got[off]) {
        entBad++; const key = `e${i} +0x${off.toString(16)}`; entHist.set(key, (entHist.get(key) || 0) + 1);
        lines.push(`${key} want ${want[off]} got ${got[off]}`);
      }
    });
    const gwant = hexBytes(b.g), ggot = mFinal.get(GLOBALS_BASE, gwant.length), gbefore = hexBytes(a.g);
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

/**
 * A captured row polled while call 6 (the event consumer) was still running shows the signature
 * of a half-finished consumer: events are still queued ([8BB5] below 0x9396) although entities
 * for some of them (class 0xF particles at the event's x/y) already exist. Returns the number of
 * such already-spawned particles (0 for an ordinary row).
 */
export function midConsumeParticles(row) {
  if (!row.q) return 0;
  const g = (a) => parseInt(row.g.substr((a - GLOBALS_BASE) * 2, 2), 16) | (parseInt(row.g.substr((a + 1 - GLOBALS_BASE) * 2, 2), 16) << 8);
  const top = g(0x8bb5);
  if (top === 0x9396) return 0;
  const q = hexBytes(row.q);
  const be = (a) => (q[a - 0x9270] << 8) | q[a - 0x9270 + 1];
  const present = new Set();
  for (const e of row.e) { const b = hexBytes(e.hex); if ((b[2] | (b[3] << 8)) === 0xf) present.add(`${b[6] | (b[7] << 8)},${b[8] | (b[9] << 8)}`); }
  let n = 0;
  for (let si = top + 2; si < 0x9396 && be(si) === 0xeeee;) {
    const tag = be(si + 2), type = be(si + 4);
    if (type === 0xf && present.has(`${be(si + 6)},${be(si + 8)}`)) n++;
    si += 4 + 2 * tag; // marker, tag and type, then tag-1 data words
  }
  return n;
}
