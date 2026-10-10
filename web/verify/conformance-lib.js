// One-step conformance of the ported iteration against a DOSBox capture (see
// tools/attract-capture/conformance.mjs for the CLI and the sampling rules). Shared by the CLI and
// by `npm run verify`, which asserts a ratchet on the number of exact transitions.

import { rncUnpack } from '../core/rnc.js';
import { decodeDemoTape } from '../core/demo-tape.js';
import { DsMemory, ENTITY_ARRAY, ENTITY_ARRAY_END, ENTITY_SIZE } from '../engine/ds-memory.js';
import { stepIteration, stepIterationAfterRng } from '../engine/iteration.js';
import { rebuildVisibleList } from '../engine/entity-behavior.js';
import { bootAttractDemo, startLevel } from '../engine/boot.js';
import { Rng } from '../engine/rng.js';

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
  if (row.p && row.p.length >= 604) { // live capture: the whole pointer array including holes and the front list
    m.put(ENTITY_ARRAY, hexBytes(row.p));
    row.e.forEach((e) => m.put(e.ptr, hexBytes(e.hex)));
    for (const e of row.x || []) m.put(e.ptr, hexBytes(e.hex));
    return finishLoad(m);
  }
  for (let o = ENTITY_ARRAY; o < ENTITY_ARRAY_END; o += 2) m.w16(o, 0);
  row.e.forEach((e, i) => { m.w16(ENTITY_ARRAY + 2 * i, e.ptr); m.put(e.ptr, hexBytes(e.hex)); });
  // Live records outside the pointer array: the hero-front entities that the spawn groups 1 and 2
  // insert at the end of the array (0x91BA, 0x91B8, ... downwards, in spawn order). The capture does
  // not hold that part of the array, so it is rebuilt from the records by address; class-0x11
  // records are the leaked half-spawns of the marker type (C523) and dead records keep stale bytes;
  // neither is in the array.
  let front = 0x91ba;
  for (const e of row.x || []) {
    m.put(e.ptr, hexBytes(e.hex));
    const cls = hexBytes(e.hex)[2] | (hexBytes(e.hex)[3] << 8);
    if (cls !== 0 && cls !== 0x11) { m.w16(front, e.ptr); front -= 2; }
  }
  return finishLoad(m);
}

function finishLoad(m) {
  // The captured row has no copy of the 0x91BE list; rebuild it from positions without scrolling.
  const dx = m.u16(0x8bb7), dy = m.u16(0x8bb9);
  m.w16(0x8bb7, 0); m.w16(0x8bb9, 0);
  // The rebuild walks the array up to the hero's sprite (class 2); a state without one (the hero is gone,
  // as in the transition to a game over) has no list to rebuild.
  let hasHero = false;
  for (let o = ENTITY_ARRAY; o < ENTITY_ARRAY_END && m.u16(o) !== 0xffff; o += 2) if (m.u16(o) !== 0 && m.u16(m.u16(o) + 2) === 2) hasHero = true;
  if (hasHero) rebuildVisibleList(m);
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

/**
 * Free run: load the first captured row once, then let the engine advance on its own state, row by
 * row (as many iterations per row as the demo tape needs), comparing every entity record and the
 * non-scratch globals with each captured row. Rows listed in `skip` are advanced but not compared
 * (half-finished-consumer samples). Returns how many consecutive rows matched from `from` and the
 * first mismatching row with its differing fields.
 */
export function runFreeRun(env, rows, o = {}) {
  rows = expandRows(rows);
  const from = o.from ?? 0, to = Math.min(o.to ?? rows.length - 1, rows.length - 1);
  let m = o.start ?? loadRow(env, rows[from]);
  const key = (mm) => (mm.u16(0x8ba6) << 8 | mm.u8(0x8ba8)) & 0xffffff;
  for (let k = from; k < to; k++) {
    const b = rows[k + 1];
    const ctx = { unported: new Set(), events: [] };
    const want = (0x8200 + 2 * b.rec) << 8 | b.rem;
    stepIteration(m, ctx, null);
    for (let extra = 0; extra < 400 && key(m) === want; extra++) {
      const next = m.clone();
      stepIteration(next, ctx, null);
      if (key(next) !== want) break;
      m = next;
    }
    if (o.skip?.has(b.done)) continue;
    const diffs = [];
    b.e.forEach((e, i) => {
      const w = hexBytes(e.hex), got = m.get(e.ptr, ENTITY_SIZE);
      for (let off = 0; off < ENTITY_SIZE; off++) if (w[off] !== got[off]) diffs.push(`e${i} +0x${off.toString(16)} want ${w[off]} got ${got[off]}`);
    });
    const gw = o.entitiesOnly ? [] : hexBytes(b.g), gg = m.get(GLOBALS_BASE, gw.length);
    for (let off = 0; off < gw.length; off++) if (gw[off] !== gg[off] && !isScratch(GLOBALS_BASE + off)) diffs.push(`G 0x${(GLOBALS_BASE + off).toString(16)} want ${gw[off]} got ${gg[off]}`);
    if (diffs.length) return { matched: k - from, firstBad: b.done, diffs: diffs.slice(0, 12), unported: [...ctx.unported] };
  }
  return { matched: to - from, firstBad: null, diffs: [], unported: [] };
}

/**
 * A memory image built from the game's files alone: the EXE's data segment, the level script
 * (unpacked `new1.pin` sits at DS:0), the map, and Level_LoadEntities for sub-level 1 of world 0 (the
 * attract demo's level). Globals the new-game initializer would set are not modelled yet.
 */
export function bootFromFiles(env, levelScript, opts = {}) {
  const m = env.base.clone();
  m.put(0, levelScript);
  m.put(0x8200, env.tape);
  m.put(0x4200, env.map);
  const ctx = { unported: new Set(), events: [] };
  bootAttractDemo(m, ctx, opts);
  return { m, unported: [...ctx.unported] };
}

/** Entity records of `row` that differ from `m`'s, as [ptr, offset] pairs, plus whether the pointer order matches. */
export function diffBootEntities(m, row) {
  const diffs = [];
  for (const e of row.e) {
    const want = hexBytes(e.hex), got = m.get(e.ptr, ENTITY_SIZE);
    for (let off = 0; off < ENTITY_SIZE; off++) if (want[off] !== got[off]) diffs.push([e.ptr, off]);
  }
  const ours = [];
  for (let o = ENTITY_ARRAY; o < ENTITY_ARRAY_END; o += 2) if (m.u16(o) !== 0) ours.push(m.u16(o));
  return { diffs, sameOrder: ours.length === row.e.length && row.e.every((e, i) => e.ptr === ours[i]) };
}

// [8B58]/[8B5D] and [8C85]-[8C94] are the keyboard ISR's own state, fed from the next row's input words.
const isLiveScratch = (a, extra) => isScratch(a) || (extra && extra.includes(a)) || a === 0x8b58 || a === 0x8b5d || (a >= 0x8c85 && a <= 0x8c94);

/**
 * One-step conformance for a live-play capture (tools/attract-capture/capture-live.lua, rows sampled
 * right after call #13). The key bytes call #7 copies come from the next row's input words.
 * @returns {{total:number, entExact:number, exact:number, hist:Map, unportedHist:Map, entFails:string[], shown:string[]}}
 */
export function runLiveConformance(env, rows, o = {}) {
  rows = expandRows(rows);
  const from = o.from ?? 1, to = Math.min(o.to ?? rows.length - 1, rows.length - 1);
  const r = { total: 0, entExact: 0, exact: 0, hist: new Map(), unportedHist: new Map(), entFails: [], shown: [], raceRows: 0 };
  // A poll that lands after the next iteration's call #1 shows the scroll state of that call. These
  // globals are the only ones it changes.
  // (also [8C38], which call #3 consumes, and [8B60]; the scroll words [8C13]-[8C18] are recomputed by call #1.)
  const RACE = (a) => a === 0x8b69 || a === 0x8b60 || a === 0x8c38 || (a >= 0x8bb7 && a <= 0x8bba) || (a >= 0x8c13 && a <= 0x8c18);
  // The poll can land between an iteration's call #8 and its call #13 (iterationCounts == 0), or a row can follow its
  // predecessor by more than one iteration. Neither transition is a whole iteration, so they are skipped.
  const counts = iterationCounts(rows);
  const mid = new Set();
  for (let k = Math.max(from, 1); k <= to + 1 && k < rows.length; k++) if (counts[k] === 0) mid.add(k);
  const multi = new Set();
  for (let k = Math.max(from, 1); k < rows.length; k++) if (counts[k] > 1) multi.add(k);
  r.midRows = [...mid];
  for (let k = from; k < to; k++) {
    if (mid.has(k) || mid.has(k + 1) || multi.has(k + 1)) { r.skipped = (r.skipped || 0) + 1; continue; }
    const b = rows[k + 1];
    const m = loadRow(env, rows[k]);
    const g = hexBytes(b.g);
    m.w8(0x8b5d, g[0x8b67 - GLOBALS_BASE]); m.w8(0x8b58, g[0x8b68 - GLOBALS_BASE]);
    m.w8(0x8ded, m.u16(0x8c3c) !== 0 ? 1 : 0); // the screen wipe's first-call flag lives outside the captured globals
    for (const [a, v] of o.force || []) m.w8(a, v); // bytes the capture script itself kept rewriting
    const ctx = { unported: new Set(), events: [] };
    stepIterationAfterRng(m, ctx, null);
    const diffs = [], gdiffs = [];
    for (const e of b.e) {
      const want = hexBytes(e.hex), got = m.get(e.ptr, ENTITY_SIZE);
      for (let off = 0; off < ENTITY_SIZE; off++) if (want[off] !== got[off]) diffs.push(`e${e.ptr.toString(16)} c${want[2]} +0x${off.toString(16)} want ${want[off]} got ${got[off]}`);
    }
    for (let off = 0; off < g.length; off++) if (g[off] !== m.u8(GLOBALS_BASE + off) && !isLiveScratch(GLOBALS_BASE + off, o.ignore)) gdiffs.push(GLOBALS_BASE + off);
    r.total++;
    if (!diffs.length) r.entExact++; else r.entFails.push(`${rows[k].done}->${b.done}: ${diffs.slice(0, 3).join('; ')} [${[...ctx.unported].join(',')}]`);
    if (!diffs.length && gdiffs.length && gdiffs.every(RACE)) { r.raceRows++; r.exact++; continue; }
    if (!diffs.length && !gdiffs.length) { r.exact++; continue; }
    for (const d of diffs) { const key = d.replace(/ want.*/, '').replace(/^e[0-9a-f]+ /, ''); r.hist.set(key, (r.hist.get(key) || 0) + 1); }
    for (const a of gdiffs) { const key = `G 0x${a.toString(16)}`; r.hist.set(key, (r.hist.get(key) || 0) + 1); }
    for (const u of ctx.unported) r.unportedHist.set(u, (r.unportedHist.get(u) || 0) + 1);
    if (r.shown.length < (o.show ?? 6)) r.shown.push(`${rows[k].done}->${b.done}: ${[...diffs, ...gdiffs.map((a) => `G 0x${a.toString(16)} want ${g[a - GLOBALS_BASE]} got ${m.u8(a)}`)].slice(0, 6).join('; ')} unported ${[...ctx.unported].join(',')}`);
  }
  return r;
}

/**
 * Does the RNG step from `a` to `b` fit one whole iteration? An iteration's RNG calls are some carry-0 calls (AI rolls,
 * effects) and, last, call #13 with carry 1; a few other call sites use other carries, so runs of up to 6 calls with any
 * carries are accepted too. Longer mixed runs would explain too many random pairs, so they are not. A step that fits
 * none is a row sampled between call #8 and call #13.
 * @returns {number} 1, or 0
 */
function iterationsBetween(a, b) {
  const run = (s, a0) => { for (let i = 0; i < a0; i++) s = new Rng(s).next(0); return new Rng(s).next(1); };
  for (let a0 = 0; a0 <= 14; a0++) if (run(a, a0) === b) return 1;
  for (let len = 1; len <= 6; len++) for (let mask = 0; mask < (1 << (len - 1)); mask++) {
    let s2 = a;
    for (let i = 0; i < len - 1; i++) s2 = new Rng(s2).next((mask >> i) & 1);
    if (new Rng(s2).next(1) === b) return 1;
  }
  return 0;
}

/**
 * For every row, the iterations since the previous one (see iterationsBetween). Rows with 0 were sampled between
 * call #8 and call #13; the two transitions around such a row are half iterations.
 */
export function iterationCounts(rows) {
  const rng = rows.map((row) => { const g = hexBytes(row.g); return g[0x8b71 - GLOBALS_BASE] | (g[0x8b72 - GLOBALS_BASE] << 8); });
  return rows.map((row, k) => (k === 0 || rng[k] === 0x3141 ? 1 : iterationsBetween(rng[k - 1], rng[k])));
}

/** Row indices sampled between an iteration's call #8 and call #13. */
export function midIterationRows(rows) {
  const counts = iterationCounts(rows);
  const mid = new Set();
  counts.forEach((c, k) => { if (c === 0) mid.add(k); });
  return mid;
}

/**
 * A free run of live play: `start` is the engine state at row `from` (for example a boot from the files);
 * every later full row (not a mid-iteration sample) is reached by one engine iteration fed with that row's
 * input words, and compared (entities always, globals unless `entitiesOnly`).
 * @returns {{matched:number, firstBad:number|null, diffs:string[], unported:string[]}}
 */
export function runLiveFree(env, rows, o = {}) {
  rows = expandRows(rows);
  const from = o.from ?? 0, to = Math.min(o.to ?? rows.length - 1, rows.length - 1);
  const counts = iterationCounts(rows);
  const mid = new Set(); counts.forEach((c, k) => { if (c === 0) mid.add(k); });
  const RACE = (a) => a === 0x8b69 || a === 0x8b60 || a === 0x8c38 || (a >= 0x8bb7 && a <= 0x8bba) || (a >= 0x8c13 && a <= 0x8c18);
  let m = o.start ?? loadRow(env, rows[from]);
  let matched = 0;
  for (let k = from + 1; k <= to; k++) {
    if (mid.has(k)) continue;
    const b = rows[k];
    const g = hexBytes(b.g);
    m.w8(0x8b5d, g[0x8b67 - GLOBALS_BASE]); m.w8(0x8b58, g[0x8b68 - GLOBALS_BASE]);
    for (const [a, v] of o.force || []) m.w8(a, v); // bytes the capture script itself kept rewriting
    const ctx = { unported: new Set(), events: [] };
    for (let rep = 0; rep < Math.max(counts[k], 1) && !ctx.levelStart && !ctx.gameRestart; rep++) stepIterationAfterRng(m, ctx, null);
    if (ctx.gameRestart === 'demo' && o.demoScript) { // CONTINUE? timed out: the game starts over with the attract demo
      m = bootFromFiles(env, o.demoScript).m;
      ctx.gameRestart = null;
      if (b.ptrs.length === 0) continue; // the captured row is the demo's loading state
      stepIterationAfterRng(m, ctx, null);
    }
    if (ctx.levelStart) { // a script changed level: the game reloads it (and the map) and runs its first iteration
      m.put(0x4200, env.map);
      const next = ctx.levelStart; ctx.levelStart = null;
      startLevel(m, ctx, next);
      stepIterationAfterRng(m, ctx, null);
    }
    if (b.ptrs && b.ptrs.length === 0) continue; // a loading state: no entities to compare
    const diffs = [];
    for (const e of b.e) {
      const want = hexBytes(e.hex), got = m.get(e.ptr, ENTITY_SIZE);
      for (let off = 0; off < ENTITY_SIZE; off++) if (want[off] !== got[off]) diffs.push(`e${e.ptr.toString(16)} c${want[2]} +0x${off.toString(16)} want ${want[off]} got ${got[off]}`);
    }
    const gd = [];
    if (!o.entitiesOnly) for (let off = 0; off < g.length; off++) if (g[off] !== m.u8(GLOBALS_BASE + off) && !isLiveScratch(GLOBALS_BASE + off, o.ignore) && !RACE(GLOBALS_BASE + off)) gd.push(`G 0x${(GLOBALS_BASE + off).toString(16)} want ${g[off]} got ${m.u8(GLOBALS_BASE + off)}`);
    if (diffs.length || gd.length) return { matched, firstBad: b.done, diffs: [...diffs, ...gd].slice(0, 12), unported: [...ctx.unported], state: m };
    matched++;
  }
  return { matched, firstBad: null, diffs: [], unported: [], state: m };
}
