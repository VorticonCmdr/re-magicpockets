/* checks.js — the invariant suite. Every row re-derives a documented claim from the shipped bytes.
 *
 * Shape follows gods-web's src/verify/checks.js: `makeChecker()` returns {results, check}, and
 * each group takes a `ctx` = { fetchRaw(url) -> Uint8Array, listData() -> string[] } so the same
 * groups run headless (tools/verify-node.mjs, disk-backed) and in a browser panel.
 *
 * RULE (enforced by tools/lint-checks.mjs): inside a check(), at least one side of an `===` must
 * be a literal or a value read from the shipped bytes. Never compare a module constant against
 * itself. A row with `note: true` reports a measurement; it is not an assertion.
 */

import { rncUnpack, crc16arc, RNC_HEADER_SIZE } from '../core/rnc.js';
import { decodePap } from '../core/pap.js';
import { decodePinSoundBank } from '../core/pin-sound.js';
import { decodeLevelScript } from '../core/pin-level-script.js';
import { WORLD_GROUND_TABLES, WORLD_GROUND_TABLE_ADDR, TABLE_BYTES } from '../core/tile-collision.js';
import { RAW_BANKS } from '../core/palette.js';
import { decodeDemoTape, DemoPlayback, INPUT_BITS, DEMO_RNG_SEED } from '../core/demo-tape.js';
import { FRAME_ORDER } from '../engine/frame.js';
import { Rng } from '../engine/rng.js';
import { prepare, runConformance, expandRows } from './conformance-lib.js';

export function makeChecker() {
  const results = [];
  const check = (name, pass, detail = '') => { results.push({ name, pass: !!pass, detail }); };
  const note = (name, detail = '') => { results.push({ name, pass: true, note: true, detail }); };
  return { results, check, note };
}

function indexOfBytes(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function countOfBytes(hay, needle) {
  let n = 0, at = -1;
  while ((at = indexOfBytes(hay, needle, at + 1)) !== -1) n++;
  return n;
}

async function unpackData(ctx, name) {
  const raw = await ctx.fetchRaw(`data/${name}`);
  return { raw, r: rncUnpack(raw) };
}

/** Every shipped data file is RNC-packed except install.txt; each embedded CRC16 must verify. */
export async function checkRncCorpus(ctx) {
  const { results, check, note } = makeChecker();
  const names = (await ctx.listData()).filter((n) => !n.startsWith('.'));
  let rnc = 0, crcOk = 0, lenOk = 0;
  const notRnc = [];
  for (const name of names) {
    const { raw, r } = await unpackData(ctx, name);
    if (!r) { notRnc.push(name); continue; }
    rnc++;
    const packed = raw.subarray(RNC_HEADER_SIZE, RNC_HEADER_SIZE + r.packedLen);
    if (crc16arc(packed) === r.packedCrc && crc16arc(r.data) === r.unpackedCrc) crcOk++;
    if (r.data.length === r.unpackedLen) lenOk++;
  }
  check('60 data files are RNC method-1 packed', rnc === 60, `got ${rnc}`);
  check('every RNC file passes both embedded CRC16s (packed and unpacked)', crcOk === rnc, `${crcOk}/${rnc}`);
  check('every RNC file unpacks to exactly its header length', lenOk === rnc, `${lenOk}/${rnc}`);
  check('the only non-RNC data file is install.txt', notRnc.length === 1 && notRnc[0] === 'install.txt', notRnc.join(','));
  note('data/ file count', `${names.length} files`);
  return results;
}

/** .pap maps: 128x128, row-major, cells 1..120 and never 0 (docs/formats/pap.md). */
export async function checkPap(ctx) {
  const { results, check } = makeChecker();
  const paps = (await ctx.listData()).filter((n) => n.endsWith('.pap'));
  check('10 .pap maps are shipped', paps.length === 10, `got ${paps.length}`);
  let sizeOk = 0, zeroCells = 0, maxCell = 0;
  for (const name of paps) {
    const { r } = await unpackData(ctx, name);
    if (r && r.data.length === 128 * 128) sizeOk++;
    const { grid } = decodePap(r.data);
    for (const v of grid) { if (v === 0) zeroCells++; if (v > maxCell) maxCell = v; }
  }
  check('every .pap unpacks to exactly 16384 bytes (128x128)', sizeOk === paps.length, `${sizeOk}/${paps.length}`);
  check('no .pap cell is ever 0', zeroCells === 0, `${zeroCells} zero cells`);
  check('every .pap cell is <= 120 (blocksN.pak tile count)', maxCell <= 120, `max ${maxCell}`);
  return results;
}

/** The per-world ground tables the port transcribed must appear byte-for-byte in GAMEU.EXE. */
export async function checkCollisionTable(ctx) {
  const { results, check, note } = makeChecker();
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  check('GAMEU.EXE is 450130 bytes (the unpacked game)', exe.length === 450130, `got ${exe.length}`);
  check('port holds the tables for worlds 1-3', WORLD_GROUND_TABLES.length === 3);
  check('each ground table is 242 bytes', TABLE_BYTES === 242 && WORLD_GROUND_TABLES.every((t) => t.length === 242));
  // DS:0 sits at file offset 385392 (= 0x5E230): the world-3 table at DS:0xF189 is at file offset 447225.
  const dsBase = 447225 - 0xf189;
  WORLD_GROUND_TABLES.forEach((t, i) => {
    const addr = WORLD_GROUND_TABLE_ADDR[i];
    const here = exe.subarray(dsBase + addr, dsBase + addr + 242);
    check(`world ${i + 1} ground table equals GAMEU.EXE at DS:0x${addr.toString(16)}`, here.every((b, j) => b === t[j]));
  });
  check('each table occurs in the EXE exactly once', WORLD_GROUND_TABLES.every((t) => countOfBytes(exe, t) === 1));
  const w = (o) => exe[dsBase + o] | (exe[dsBase + o + 1] << 8);
  const list = [0, 1, 2, 3].map((i) => w(0xef25 + 2 * i));
  check('the per-world pointer list at DS:0xEF25 is EFA5, F097, F189, F2F5', list.join(',') === [0xefa5, 0xf097, 0xf189, 0xf2f5].join(','), list.map((x) => x.toString(16)).join(','));
  check('the table pointers are spaced 0xF2 (242) bytes apart for worlds 1-3', list[1] - list[0] === 0xf2 && list[2] - list[1] === 0xf2);
  let badValues = 0;
  for (const t of WORLD_GROUND_TABLES) for (let v = 1; v <= 120; v++) if (![0, 1, 16].includes(t[v])) badValues++;
  check('table entries 1..120 are only 0 (passable), 1 (solid) or 16 (special)', badValues === 0, `${badValues} other values`);
  note('UNKNOWN_world4_ground_table', 'the world-4 pointer 0xF2F5 leads to a block with values 4,5,7,12,20,24,26,28,32,99,255: a different structure, not transcribed (ledger item 8)');
  return results;
}

/** The per-world palette banks the port carries must be present in GAMEU.EXE. */
export async function checkPalettes(ctx) {
  const { results, check } = makeChecker();
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  for (const [name, bytes] of Object.entries(RAW_BANKS)) {
    if (name === 'world0_current') continue;
    const hits = countOfBytes(exe, Uint8Array.from(bytes));
    check(`${name} palette bank (32 bytes) is present in GAMEU.EXE`, hits >= 1, `${hits} occurrence(s)`);
  }
  return results;
}

/** Sound-bank .pin files: resource tables with the documented MIDI cue counts. */
export async function checkSoundBanks(ctx) {
  const { results, check } = makeChecker();
  const expected = { 'adlib.pin': [82, 78], 'roland.pin': [82, 81], 'roland2.pin': [1, 1], 'soundbnk.pin': [1, 1] };
  for (const [name, [count, midi]] of Object.entries(expected)) {
    const { r } = await unpackData(ctx, name);
    const bank = decodePinSoundBank(r.data);
    const got = bank ? [bank.count, bank.entries.filter((e) => e.midiLength != null).length] : null;
    check(`${name}: ${count} entries, ${midi} MIDI cues`, !!got && got[0] === count && got[1] === midi, got ? got.join('/') : 'not a sound bank');
  }
  return results;
}

/** Level-script .pin files: the documented 3811-record census (docs/formats/pin-level-script.md). */
export async function checkLevelScripts(ctx) {
  const { results, check, note } = makeChecker();
  const files = ['new1.pin', 'level2.pin', 'level3a.pin', 'level3b.pin', 'level3c.pin', 'level4.pin'];
  let total = 0, sublevels = 0;
  for (const name of files) {
    const { r } = await unpackData(ctx, name);
    const ls = decodeLevelScript(r.data);
    total += ls.entities.length;
    sublevels += ls.sublevels.length;
  }
  check('six level scripts hold 3811 entity records in total', total === 3811, `got ${total}`);
  check('six level scripts hold 62 sub-level entry points in total', sublevels === 62, `got ${sublevels}`);
  const l0 = decodeLevelScript((await unpackData(ctx, 'level0.pin')).r.data);
  note('level0.pin (not in the 3811 census)', `${l0.entities.length} records, ${l0.sublevels.length} entries`);
  return results;
}

/** autoplay.pin: the attract-demo tape, plus the EXE-side constants the decoder relies on. */
export async function checkDemoTape(ctx) {
  const { results, check, note } = makeChecker();
  const { r } = await unpackData(ctx, 'autoplay.pin');
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  check('autoplay.pin unpacks to exactly 2000 bytes', r.data.length === 2000, `got ${r.data.length}`);
  check('GAMEU.EXE references the filename "autoplay.pin"', indexOfBytes(exe, new TextEncoder().encode('autoplay.pin')) !== -1);

  const tape = decodeDemoTape(r.data);
  check('tape ends with the word 0xFFFF at byte 628', tape.terminated && tape.terminatorOffset === 628, `terminated=${tape.terminated} at ${tape.terminatorOffset}`);
  check('tape holds 314 (count,state) records', tape.records.length === 314, `got ${tape.records.length}`);
  check('tape plays for 2342 loop iterations', tape.frames === 2342, `got ${tape.frames}`);
  check('every byte after the terminator is zero padding', r.data.subarray(630).every((b) => b === 0));
  const usedBits = tape.records.reduce((m, rec) => m | rec.state, 0);
  check('tape states only use bits 0x01 0x02 0x04 0x08 0x80', usedBits === 0x8f, `union 0x${usedBits.toString(16)}`);

  const play = new DemoPlayback(tape);
  let n = 0, last = null;
  for (let s = play.next(); s !== null; s = play.next()) { n++; last = s; }
  check('DemoPlayback yields exactly 2342 states then stops', n === 2342 && play.done, `got ${n}`);
  check('the last recorded state is applied on the final iteration', last === tape.records[313].state, `0x${(last ?? 0).toString(16)}`);

  /* The keyboard scancode -> input-flag table at CS:0x1E27 is NOT in the EXE file: it is filled at
   * startup from pockets.ini's five key lines (Up, Down, Left, Right, Fire, in that order). So
   * assert what the shipped ini really contains; the flag values themselves were read live. */
  const ini = new TextDecoder().decode(await ctx.fetchRaw('game/pockets.ini')).split(/\r?\n/).filter((l) => l.trim());
  const keyLines = ini.slice(5, 10);
  const scancodes = keyLines.map((l) => Number(l.split(' ')[0].replace(',', '')) >> 8);
  check('pockets.ini binds Up, Down, Left, Right, Fire to scancodes 0x48 0x50 0x4B 0x4D 0x39', scancodes.join(',') === '72,80,75,77,57', scancodes.join(','));
  check('keyboard flag table signature (Up/Left/Right/Down run) is absent from the EXE file, so it is built at runtime',
    indexOfBytes(exe, Uint8Array.from([1,0, 0,0, 0,0, 4,0, 0,0, 8,0, 0,0, 0,0, 2,0])) === -1);
  note('INPUT_BITS (Up 0x01, Down 0x02, Left 0x04, Right 0x08, Fire 0x80) [PROVEN] live', `read from DOSBox memory CS:0x1E27+scancode*2 on 2026-10-09; port has ${JSON.stringify(INPUT_BITS)}`);

  /* Game_StartAttractDemoAndRunLoop's constants: mov word [8BA6],8200 / mov word [8B71],imm16 /
   * mov byte [8BAA],1. */
  check('demo start points the tape cursor [8BA6] at DS:0x8200', indexOfBytes(exe, Uint8Array.from([0xc7,0x06,0xa6,0x8b,0x00,0x82])) !== -1);
  check('demo start sets the playback flag [8BAA] to 1', indexOfBytes(exe, Uint8Array.from([0xc6,0x06,0xaa,0x8b,0x01])) !== -1);
  const seedAt = indexOfBytes(exe, Uint8Array.from([0xc7,0x06,0x71,0x8b]));
  const seedWord = seedAt === -1 ? -1 : exe[seedAt + 4] | (exe[seedAt + 5] << 8);
  check('demo start seeds the RNG state [8B71] with the port\'s DEMO_RNG_SEED', seedWord === DEMO_RNG_SEED, `EXE has 0x${seedWord.toString(16)}`);
  note('UNKNOWN_demo_which_level', 'demo start sets world word [8B89]=0 and sublevel [8B8B]=1 (static read); the level it actually plays is not yet confirmed live');
  return results;
}

/** The main loop's 14 consecutive near calls, found in GAMEU.EXE and compared to FRAME_ORDER. */
export async function checkFrameOrder(ctx) {
  const { results, check, note } = makeChecker();
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  const hdr = (exe[8] | (exe[9] << 8)) * 16; // MZ header size; load module starts here
  check('MZ header is 0x340 bytes, so file offset = 0x340 + (1000:xxxx offset)', hdr === 0x340, `got 0x${hdr.toString(16)}`);
  check('Demo_PlaybackInput (1000:0159) begins "mov al,[8B5D]" in the file', exe[hdr + 0x159] === 0xa0 && exe[hdr + 0x15a] === 0x5d && exe[hdr + 0x15b] === 0x8b);

  const runs = [];
  for (let p = hdr; p + 14 * 3 <= exe.length; p++) {
    let ok = true;
    for (let k = 0; k < 14 && ok; k++) ok = exe[p + k * 3] === 0xe8;
    if (!ok) continue;
    const targets = [];
    for (let k = 0; k < 14; k++) {
      const site = p + k * 3 - hdr;
      const rel = exe[p + k * 3 + 1] | (exe[p + k * 3 + 2] << 8);
      targets.push((site + 3 + rel) & 0xffff);
    }
    runs.push({ at: p, targets });
  }
  const wanted = FRAME_ORDER.map((c) => parseInt(c.addr.split(':')[1], 16));
  const matching = runs.filter((r) => r.targets.every((t, i) => t === wanted[i]));
  check('FRAME_ORDER lists 14 calls', FRAME_ORDER.length === 14);
  check('at least one run of 14 consecutive near calls in GAMEU.EXE has exactly FRAME_ORDER\'s targets, in order', matching.length >= 1, `${matching.length} of ${runs.length} candidate runs`);
  check('no 14-call run in GAMEU.EXE disagrees with FRAME_ORDER', matching.length === runs.length, `${runs.length - matching.length} disagree`);
  note('contiguous 14-call runs in the EXE', `${matching.length} (the demo starter's loop); docs/engine.md says boot and warp have their own copies, but this search did not find them as contiguous runs and that was not investigated`);
  return results;
}

/** DOSBox ground truth (tools/attract-capture/autoplay.capture.json) against the port's Rng. */
export async function checkCaptureRng(ctx) {
  const { results, check, note } = makeChecker();
  let cap = null;
  try {
    cap = JSON.parse(new TextDecoder().decode(await ctx.fetchRaw('tools/attract-capture/autoplay.capture.json')));
  } catch { /* no capture committed or served */ }
  if (!cap) {
    note('DOSBox capture not found', 'tools/attract-capture/autoplay.capture.json is missing; RNG-vs-DOS checks skipped');
    return results;
  }
  const rows = cap.rows;
  check('capture rows are consecutive iterations starting at 0', rows.every((r, i) => r.done === i), `${rows.length} rows`);
  check('capture row 0 holds the demo seed 0x3141 (12609)', rows[0].rng === 12609, `got ${rows[0].rng}`);
  const rng = new Rng();
  const byStep = new Array(7).fill(0); // index k = transitions first explained by k steps; 0 = none
  for (let i = 1; i < rows.length; i++) {
    let found = 0;
    for (let k = 1; k <= 5 && !found; k++) {
      for (let mask = 0; mask < (1 << k) && !found; mask++) {
        rng.state = rows[i - 1].rng;
        for (let j = 0; j < k; j++) rng.next((mask >> j) & 1);
        if (rng.state === rows[i].rng) found = k;
      }
    }
    byStep[found]++;
  }
  const total = rows.length - 1;
  check('at least 90% of captured RNG transitions are exactly one Rng.next() (carry-in 1)', byStep[1] / total >= 0.9, `${byStep[1]}/${total}`);
  check('all but at most 5 transitions are reproduced by 5 or fewer Rng.next() calls with some carry-in', byStep[0] <= 5, `${byStep[0]} unexplained`);
  note('RNG calls outside main-loop call 13', `${byStep[2]} two-step, ${byStep[3]} three-step, ${byStep[4]} four-step, ${byStep[5]} five-step, ${byStep[0]} unexplained of ${total}; clustered in iterations ~1000-1400; the extra caller is not identified (ledger item 13)`);
  return results;
}

/** Read a gzipped JSON capture through the platform's DecompressionStream (browser and Node 18+). */
async function loadGzJson(ctx, path) {
  const raw = await ctx.fetchRaw(path);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

/**
 * One-step conformance against the DOSBox capture of the first 700 demo iterations (every entity,
 * the pointer array and the spawn queue): load captured row k, run one ported iteration (or as many
 * as the stalled demo tape needs), compare every entity record and the non-scratch globals with
 * row k+1. The literals are a RATCHET: raise them when more of the engine is ported, never lower.
 */
export async function checkConformance(ctx) {
  const { results, check, note } = makeChecker();
  let cap = null;
  try { cap = await loadGzJson(ctx, 'tools/attract-capture/entities-full.capture.json.gz'); } catch { /* absent */ }
  if (!cap) { note('entity capture not found', 'tools/attract-capture/entities-full.capture.json.gz is missing; conformance skipped'); return results; }
  const env = prepare(await ctx.fetchRaw('game/GAMEU.EXE'), await ctx.fetchRaw('data/autoplay.pin'), await ctx.fetchRaw('data/pcmap.pap'));
  check('entity capture holds 700 consecutive iterations', cap.rows.length === 700 && cap.rows.every((r, i) => r.done === i));
  const rows = expandRows(cap.rows);
  check('the capture lists up to 112 entities per row, each record 66 bytes', Math.max(...rows.map((r) => r.e.length)) === 112 && rows.every((r) => r.e.every((e) => e.hex.length === 132)));
  const hero = runConformance(env, rows, { ents: 3, only: 3, ignoreScratch: true });
  check('at least 696 of 699 transitions reproduce entities 0-2 byte for byte', hero.entExact >= 696, `${hero.entExact}/${hero.total}`);
  check('at least 639 of 699 transitions also reproduce every non-scratch global', hero.exact >= 639, `${hero.exact}/${hero.total}`);
  const all = runConformance(env, rows, { ignoreScratch: true });
  check('at least 694 of 699 transitions reproduce every captured entity byte for byte', all.entExact >= 694, `${all.entExact}/${all.total}`);
  check('at least 688 of 699 transitions reproduce every entity and every non-scratch global', all.exact >= 688, `${all.exact}/${all.total}`);
  const top = [...all.unportedHist].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} x${n}`).join(', ');
  note('unported branches still hit', top || 'none');
  return results;
}

export async function runAllChecks(ctx) {
  const groups = [checkRncCorpus, checkPap, checkCollisionTable, checkPalettes, checkSoundBanks, checkLevelScripts, checkDemoTape, checkFrameOrder, checkCaptureRng, checkConformance];
  const results = [];
  for (const g of groups) results.push(...await g(ctx));
  return { results };
}
