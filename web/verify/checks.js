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
import { levelFilesFor } from '../engine/level-registry.js';
import { decodePap } from '../core/pap.js';
import { decodePinSoundBank } from '../core/pin-sound.js';
import { decodeLevelScript } from '../core/pin-level-script.js';
import { WORLD_GROUND_TABLES, WORLD_GROUND_TABLE_ADDR, TABLE_BYTES } from '../core/tile-collision.js';
import { RAW_BANKS, WORLD_PALETTES } from '../core/palette.js';
import { rasterize, buildBanks } from '../render/sprite-raster.js';
import { decodeDemoTape, DemoPlayback, INPUT_BITS, DEMO_RNG_SEED } from '../core/demo-tape.js';
import { FRAME_ORDER, DEFAULT_TICK_HZ } from '../engine/frame.js';
import { stepIteration, stepIterationAfterRng } from '../engine/iteration.js';
import { Rng } from '../engine/rng.js';
import { codeEntry } from '../engine/script-runner.js';
import { prepare, runConformance, runFreeRun, runLiveConformance, runLiveFree, bootFromFiles, diffBootEntities, expandRows, midConsumeParticles, loadRow } from './conformance-lib.js';
import { mapFixups } from '../engine/boot.js';
import * as FE from '../engine/frontend.js';
import * as KL from '../engine/klogo.js';
import * as IN from '../engine/intro.js';
import { lzhufDecode } from '../core/lzhuf.js';
import { fnv64 } from '../core/hash.js';
import { DsMemory } from '../engine/ds-memory.js';
import { collectDraws, mirrorTile32, BANKS } from '../render/sprites.js';
import { parseTrace, replay } from '../audio/trace-replay.js';
import { PinDriver, TICK_HZ } from '../audio/pin-driver.js';
import { CODE_FILE_OFFSET } from '../core/exe-data.js';

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
  // The pacing: PIT divisor, ISR decrement and the per-iteration reload, read out of the file.
  const at = (off, bytes) => bytes.every((b, i) => exe[hdr + off + i] === b);
  check('1000:2047 programs PIT channel 0 with the bytes B0 36 E6 43 B0 EC E6 40 B0 5C E6 40 (divisor 0x5CEC)', at(0x2047, [0xb0, 0x36, 0xe6, 0x43, 0xb0, 0xec, 0xe6, 0x40, 0xb0, 0x5c, 0xe6, 0x40]));
  const divisor = exe[hdr + 0x204c] | (exe[hdr + 0x2050] << 8);
  check('1000:010B reloads cs:[2085] with 3 every iteration', at(0x10b, [0x2e, 0xc7, 0x06, 0x85, 0x20, 0x03, 0x00]));
  check('the timer ISR at 1000:20B6 decrements cs:[2085] ("cmp word cs:[2085],0 / jz / dec word cs:[2085]")', at(0x20b6, [0x2e, 0x83, 0x3e, 0x85, 0x20, 0x00, 0x74, 0x05, 0x2e, 0xff, 0x0e, 0x85, 0x20]));
  check('1000:1605 waits for cs:[2085] to reach zero ("cmp word cs:[2085],0 / jnz back")', at(0x1605, [0x2e, 0x83, 0x3e, 0x85, 0x20, 0x00, 0x75, 0xf8]));
  check('the port\'s default tick rate is the PIT rate over the divisor read from the file over 3 ticks, 16.72 Hz', Math.abs(DEFAULT_TICK_HZ - 1193182 / divisor / 3) < 1e-9 && Math.abs(DEFAULT_TICK_HZ - 16.72) < 0.01, `divisor 0x${divisor.toString(16)}, ${DEFAULT_TICK_HZ.toFixed(4)} Hz`);
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
  check('entity capture holds the whole demo: 2342 consecutive iterations', cap.rows.length === 2342 && cap.rows.every((r, i) => r.done === i));
  const rows = expandRows(cap.rows);
  check('the capture lists up to 112 entities per row, each record 66 bytes', Math.max(...rows.map((r) => r.e.length)) === 112 && rows.every((r) => r.e.every((e) => e.hex.length === 132)));
  const hero = runConformance(env, rows, { ents: 3, only: 3, ignoreScratch: true });
  const first700 = rows.slice(0, 700);
  check('at least 696 of 699 transitions reproduce entities 0-2 byte for byte', hero.entExact >= 696, `${hero.entExact}/${hero.total}`);
  check('at least 639 of 699 transitions also reproduce every non-scratch global', hero.exact >= 639, `${hero.exact}/${hero.total}`);
  // Rows 197 and 198 were polled while call 6 (the event consumer) was running: three of the four
  // queued particle events have already spawned entities but [8BB5] still points at all four. A
  // whole-iteration model cannot reproduce a mid-call snapshot, so these two rows are exempt.
  const MID_CALL_SAMPLES = new Set([197, 198]);
  check('the exempt rows carry the half-finished-consumer signature (queued events whose particles already exist)', [...MID_CALL_SAMPLES].every((k) => midConsumeParticles(rows[k]) > 0 || midConsumeParticles(rows[k - 1]) > 0));
  const head = runConformance(env, first700, { ignoreScratch: true, skip: MID_CALL_SAMPLES });
  const all = runConformance(env, rows, { ignoreScratch: true, skip: MID_CALL_SAMPLES });
  check('every one of the first 700 iterations\' 697 usable transitions reproduces every captured entity byte for byte', head.entExact === head.total && head.total === 697, `${head.entExact}/${head.total}`);
  check('every one of the whole demo\'s 2339 usable transitions reproduces every captured entity byte for byte', all.entExact === all.total && all.total === 2339, `${all.entExact}/${all.total}`);
  check('every one of the first 700 iterations\' usable transitions also reproduces every non-scratch global', head.exact === head.total, `${head.exact}/${head.total}`);
  check('at least 2337 of the whole demo\'s usable transitions also reproduce every non-scratch global', all.exact >= 2337, `${all.exact}/${all.total}`);
  // The strongest claim: start from row 0 only and let the engine run on its own state.
  const free = runFreeRun(env, rows, { skip: MID_CALL_SAMPLES });
  check('a free run from the first captured state matches the capture for at least 2340 consecutive iterations', free.matched >= 2340, `${free.matched} rows, first mismatch ${free.firstBad ?? 'none'}`);
  // Files-only boot: Level_LoadEntities on the unpacked level0.pin reproduces the first captured row's records.
  const boot = bootFromFiles(env, rncUnpack(await ctx.fetchRaw('data/level0.pin')).data);
  const bd = diffBootEntities(boot.m, rows[0]);
  check('a boot from the files alone creates the captured entity records at the captured addresses and pointer order', bd.sameOrder && boot.unported.length === 0, `order ${bd.sameOrder}, unported ${boot.unported.length}`);
  check('that boot reproduces every byte of the first captured row\'s entity records', bd.diffs.length === 0, `${bd.diffs.length} bytes`);
  const bootRun = runFreeRun(env, rows, { start: boot.m, entitiesOnly: true, skip: MID_CALL_SAMPLES });
  check('a free run from that files-only boot reproduces every captured entity record for the whole demo', bootRun.matched === 2341, `${bootRun.matched} rows, first mismatch ${bootRun.firstBad ?? 'none'}`);
  // Real play (not the demo): 1800 iterations of world 1 captured with capture-live.lua, keyboard input
  // replayed from each row's input words.
  const world1 = rncUnpack(await ctx.fetchRaw('data/new1.pin')).data;
  let live = null;
  try { live = await loadGzJson(ctx, 'tools/attract-capture/live1.capture.json.gz'); } catch { /* absent */ }
  if (live) {
    check('the live-play capture holds 1800 consecutive iterations of world 1, sub-level 1', live.rows.length === 1800 && live.rows.every((r, i) => r.done === i));
    const lr = runLiveConformance(env, live.rows, {});
    check('at least 1781 of 1782 usable live-play transitions reproduce every captured entity record byte for byte', lr.entExact >= 1781 && lr.total === 1782, `${lr.entExact}/${lr.total}`);
    check('at least 1780 of 1782 usable live-play transitions also reproduce every non-scratch global', lr.exact >= 1780, `${lr.exact}/${lr.total} (${lr.raceRows} differ only in sample-race scroll globals; ${lr.skipped} transitions beside ${lr.midRows.length} mid-iteration samples skipped)`);
    // A second capture of the same level, recorded with a different (seeded random) player after the engine had
    // been developed against the first: a hold-out test.
    let live2 = null;
    try { live2 = await loadGzJson(ctx, 'tools/attract-capture/live2.capture.json.gz'); } catch { /* absent */ }
    if (live2) {
      const l2 = runLiveConformance(env, live2.rows, {});
      check('the hold-out live-play capture (a different, seeded random player): every usable transition reproduces every captured entity record', l2.entExact === l2.total && l2.total === 1195, `${l2.entExact}/${l2.total}`);
      const fb2 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const f2 = runLiveFree(env, live2.rows, { start: fb2.m, from: 0, entitiesOnly: true });
      check('a free run from a files-only boot reproduces every captured entity record of the whole hold-out capture', f2.firstBad === null && f2.matched === 1203, `${f2.matched} rows, first mismatch ${f2.firstBad ?? 'none'}`);
      check('the hold-out capture also reproduces every non-scratch global on every usable transition', l2.exact === l2.total, `${l2.exact}/${l2.total} (${l2.raceRows} differ only in sample-race globals; ${l2.skipped} transitions beside ${l2.midRows.length} mid-iteration samples skipped)`);
    }
    // Real play from the files alone: world 1, sub-level 1 (new1.pin, pcmap.pap) booted as the game's own start does,
    // then each row's keyboard words fed to the engine. The first capture ends its real play at a restart (CONTINUE?
    // timed out), which is not ported.
    const demoScript = rncUnpack(await ctx.fetchRaw('data/level0.pin')).data;
    const fb1 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
    const f1 = runLiveFree(env, live.rows, { start: fb1.m, from: 0, entitiesOnly: true, demoScript });
    check('a free run of real play from a files-only boot reproduces every captured entity record of the whole first capture, including the CONTINUE? timeout that restarts the game as the attract demo', f1.firstBad === null && f1.matched === 1790, `${f1.matched} rows, first mismatch ${f1.firstBad ?? 'none'}`);
    // A third capture, made with the hero invulnerable ([8B96] rewritten to 0x32 every frame, see capture-live-drive.lua) so a
    // seeded random player gets all the way through level 1, including the end-of-level bonus sequence.
    let live3 = null;
    try { live3 = await loadGzJson(ctx, 'tools/attract-capture/live3.capture.json.gz'); } catch { /* absent */ }
    if (live3) {
      const l3 = runLiveConformance(env, live3.rows, { force: [[0x8b96, 0x32]], ignore: [0x8b96] });
      check('the invulnerable full-level capture: at least 3016 of 3018 usable transitions reproduce every captured entity record', l3.entExact >= 3016 && l3.total === 3018, `${l3.entExact}/${l3.total} (the two misses read a map tile the hero had already broken: one-step loads the original map)`);
      const fb3 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const f3 = runLiveFree(env, live3.rows, { start: fb3.m, from: 0, entitiesOnly: true, force: [[0x8b96, 0x32]] });
      check('a free run from a files-only boot reproduces every captured entity record of the whole level-1 capture, end-of-level sequence included', f3.firstBad === null && f3.matched === 3109, `${f3.matched} rows, first mismatch ${f3.firstBad ?? 'none'}`);
    }
    // A fourth capture without invulnerability and with the keys never gated: the hero dies, CONTINUE? is accepted with fire and
    // the level restarts (twice).
    let live4 = null;
    try { live4 = await loadGzJson(ctx, 'tools/attract-capture/live4.capture.json.gz'); } catch { /* absent */ }
    if (live4) {
      const fb4 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const f4 = runLiveFree(env, live4.rows, { start: fb4.m, from: 0, entitiesOnly: true, demoScript });
      check('a free run reproduces every captured entity record of the capture with two deaths, CONTINUE? accepted and the level restarted twice', f4.firstBad === null && f4.matched === 2579, `${f4.matched} rows, first mismatch ${f4.firstBad ?? 'none'}`);
    }
    // Natural starts played without god mode (generator checked): the continues counter [8C0B] is poked at row 20.
    // live25: it wraps to 255, so the player keeps accepting CONTINUE? and once lets it time out (the attract demo starts);
    // live26: it is 1, so the second death ends the game (GAME OVER, opcode 52 -> 2D4F) and a new game starts with the generator running on.
    for (const [file, poke, label] of [['live25-continue-timeout', 0, 'three deaths, CONTINUE? accepted and once timed out'], ['live26-gameover', 1, 'a GAME OVER and the new game after it']]) {
      let capN = null;
      try { capN = await loadGzJson(ctx, `tools/attract-capture/${file}.capture.json.gz`); } catch { /* absent */ }
      if (!capN) continue;
      const fbN = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const fN = runLiveFree(env, capN.rows, { start: fbN.m, from: 0, entitiesOnly: true, checkRng: true, force: [], pokes: [{ row: 20, addr: 0x8c0b, bytes: [poke] }], demoScript, world1Script: world1 });
      check(`a free run with the generator checked reproduces a natural start played without god mode: ${label}`, fN.firstBad === null && fN.matched >= 1950, `${fN.matched} rows, first mismatch ${fN.firstBad ?? 'none'}`);
    }
    // A fifth capture: the invulnerable run again with Enter taps added, so it also holds the end-of-level code letters
    // (opcode 68 -> 25A5/25C8). Rows after 3225 are the code screen's own loop (one RNG call with carry 0 per tick, no call #13), not main-loop iterations.
    let live5 = null;
    try { live5 = await loadGzJson(ctx, 'tools/attract-capture/live5.capture.json.gz'); } catch { /* absent */ }
    if (live5) {
      const fb5 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const f5 = runLiveFree(env, live5.rows, { start: fb5.m, from: 0, entitiesOnly: true, force: [[0x8b96, 0x32]], demoScript });
      // Rows from 3202 on are real iterations with call #13's carry at 0 ([8C33] is set; see call13Carry); an earlier version of the carry rule
      // wrongly called them half iterations and skipped them. The first one that needs more is the level-end screen fade (Fx_UpdateTransition state 0x32 [STATIC: graphics only, no DS writes], after which the real game leaves the main loop for the end-of-level screens, ledger item 24).
      check('a free run reproduces every captured entity record up to the level-end screen fade (row 3203), and nothing before it differs', f5.firstBad === 3203 && f5.matched === 3112, `${f5.matched} rows, first mismatch ${f5.firstBad ?? 'none'}, unported ${f5.unported.join(', ')}`);
    }
    // World 1, sub-level 2 (level1a.pap): reached by poking the level words while CONTINUE? is up (capture-live-drive.lua style, see
    // docs/dosbox-debugging.md); the capture script's own writes are replayed (hearts at row 60, level words at the switch row, the
    // hurt timer pinned 40 rows later).
    let live6 = null;
    try { live6 = await loadGzJson(ctx, 'tools/attract-capture/live6-sub2.capture.json.gz'); } catch { /* absent */ }
    if (live6) {
      const ex6 = expandRows(live6.rows);
      const word = (r, o) => { const b = Uint8Array.from(r.g.match(/../g), (h) => parseInt(h, 16)); return b[o - 0x8b50] | (b[o - 0x8b50 + 1] << 8); };
      const sw = ex6.findIndex((r) => word(r, 0x8b8b) === 2);
      const grid = rncUnpack(await ctx.fetchRaw('data/level1a.pap')).data;
      const map2 = new Uint8Array(128 * 128);
      for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) map2[c * 128 + r] = grid[r * 128 + c];
      const fb6 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const f6 = runLiveFree(env, live6.rows, { start: fb6.m, from: 0, entitiesOnly: true, force: [[0x8b96, 50, sw + 40]], pokes: [{ row: 60, addr: 0x94aa, bytes: [0x7b, 0] }, { row: sw, addr: 0x8b89, bytes: [1, 0, 2, 0] }], levelFiles: () => ({ script: world1, map: map2 }) });
      check('a free run reproduces every captured entity record of world 1 sub-level 2 (a different map, reached by the level words), from the files alone', sw > 0 && f6.firstBad === null && f6.matched >= 2150, `${f6.matched} rows, first mismatch ${f6.firstBad ?? 'none'}, level words written at row ${sw}`);
    }
    // World 1, sub-level 3 (level1b.pap): same method as sub-level 2, different seed.
    let live7 = null;
    try { live7 = await loadGzJson(ctx, 'tools/attract-capture/live7-sub3.capture.json.gz'); } catch { /* absent */ }
    if (live7) {
      const ex7 = expandRows(live7.rows);
      const word7 = (r, o) => { const b = Uint8Array.from(r.g.match(/../g), (h) => parseInt(h, 16)); return b[o - 0x8b50] | (b[o - 0x8b50 + 1] << 8); };
      const sw7 = ex7.findIndex((r) => word7(r, 0x8b8b) === 3);
      const grid7 = rncUnpack(await ctx.fetchRaw('data/level1b.pap')).data;
      const map7 = new Uint8Array(128 * 128);
      for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) map7[c * 128 + r] = grid7[r * 128 + c];
      const fb7 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const f7 = runLiveFree(env, live7.rows, { start: fb7.m, from: 0, entitiesOnly: true, force: [[0x8b96, 50, sw7 + 40]], pokes: [{ row: 60, addr: 0x94aa, bytes: [0x7b, 0] }, { row: sw7, addr: 0x8b89, bytes: [1, 0, 3, 0] }], levelFiles: () => ({ script: world1, map: map7 }) });
      check('a free run reproduces every captured entity record of world 1 sub-level 3 (level1b.pap) from the files alone', sw7 > 0 && f7.firstBad === null && f7.matched >= 2340, `${f7.matched} rows, first mismatch ${f7.firstBad ?? 'none'}, level words written at row ${sw7}`);
    }
    // World 1, sub-level 4: shares level1b.pap with sub-level 3 but has its own entity list.
    let live8 = null;
    try { live8 = await loadGzJson(ctx, 'tools/attract-capture/live8-sub4.capture.json.gz'); } catch { /* absent */ }
    if (live8) {
      const ex8 = expandRows(live8.rows);
      const word8 = (r, o) => { const b = Uint8Array.from(r.g.match(/../g), (h) => parseInt(h, 16)); return b[o - 0x8b50] | (b[o - 0x8b50 + 1] << 8); };
      const sw8 = ex8.findIndex((r) => word8(r, 0x8b8b) === 4);
      const grid8 = rncUnpack(await ctx.fetchRaw('data/level1b.pap')).data;
      const map8 = new Uint8Array(128 * 128);
      for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) map8[c * 128 + r] = grid8[r * 128 + c];
      const fb8 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const f8 = runLiveFree(env, live8.rows, { start: fb8.m, from: 0, entitiesOnly: true, force: [[0x8b96, 50, sw8 + 40]], pokes: [{ row: 60, addr: 0x94aa, bytes: [0x7b, 0] }, { row: sw8, addr: 0x8b89, bytes: [1, 0, 4, 0] }], levelFiles: () => ({ script: world1, map: map8 }) });
      check('a free run reproduces every captured entity record of world 1 sub-level 4 (level1b.pap, its own entity list) from the files alone', sw8 > 0 && f8.firstBad === null && f8.matched >= 2170, `${f8.matched} rows, first mismatch ${f8.firstBad ?? 'none'}, level words written at row ${sw8}`);
    }
    // World 1, sub-level 5 (level1b.pap again): reproduced up to row 1437 of 1694 (a ratchet: raise it as the remaining difference is closed).
    let live9 = null;
    try { live9 = await loadGzJson(ctx, 'tools/attract-capture/live9-sub5.capture.json.gz'); } catch { /* absent */ }
    if (live9) {
      const ex9 = expandRows(live9.rows);
      const word9 = (r, o) => { const b = Uint8Array.from(r.g.match(/../g), (h) => parseInt(h, 16)); return b[o - 0x8b50] | (b[o - 0x8b50 + 1] << 8); };
      const sw9 = ex9.findIndex((r) => word9(r, 0x8b8b) === 5);
      const grid9 = rncUnpack(await ctx.fetchRaw('data/level1b.pap')).data;
      const map9 = new Uint8Array(128 * 128);
      for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) map9[c * 128 + r] = grid9[r * 128 + c];
      const fb9 = bootFromFiles(env, world1, { world: 1, sub: 1, demo: false });
      const f9 = runLiveFree(env, live9.rows, { start: fb9.m, from: 0, entitiesOnly: true, force: [[0x8b96, 50, sw9 + 40]], pokes: [{ row: 60, addr: 0x94aa, bytes: [0x7b, 0] }, { row: sw9, addr: 0x8b89, bytes: [1, 0, 5, 0] }], levelFiles: () => ({ script: world1, map: map9 }) });
      check('a free run reproduces the captured entity records of world 1 sub-level 5 up to row 1525 (the older hybrid-start capture; the clean one is live20)', sw9 > 0 && (f9.firstBad === null || f9.firstBad >= 1525) && f9.matched >= 1300, `${f9.matched} rows, first mismatch ${f9.firstBad ?? 'none'}, level words written at row ${sw9}`);
    }
    // World 2 sub-level 1, a CLEAN start: the game's own level-code warp (F2, then 6245; ledger item 24) loads level2.pin and
    // level2b.pap itself, so this run boots those two files with no earlier level and compares every captured entity record.
    let live10 = null;
    try { live10 = await loadGzJson(ctx, 'tools/attract-capture/live10-w2s1.capture.json.gz'); } catch { /* absent */ }
    if (live10) {
      const ex10 = expandRows(live10.rows);
      const word10 = (r, o) => { const b = Uint8Array.from(r.g.match(/../g), (h) => parseInt(h, 16)); return b[o - 0x8b50] | (b[o - 0x8b50 + 1] << 8); };
      const sw10 = ex10.findIndex((r) => word10(r, 0x8b89) === 2);
      const script2 = rncUnpack(await ctx.fetchRaw('data/level2.pin')).data;
      const grid10 = rncUnpack(await ctx.fetchRaw('data/level2b.pap')).data;
      const map10 = new Uint8Array(128 * 128);
      for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) map10[c * 128 + r] = grid10[r * 128 + c];
      const env10 = { ...env, map: map10 };
      const fb10 = bootFromFiles(env10, script2, { world: 2, sub: 1, demo: false });
      stepIterationAfterRng(fb10.m, { unported: new Set(), events: [] }, null); // the capture's first row is after the first iteration
      const f10 = runLiveFree(env10, live10.rows, { start: fb10.m, from: sw10, entitiesOnly: true, force: [[0x8b96, 50]], levelFiles: () => ({ script: script2, map: map10 }) });
      check('a free run reproduces every captured entity record of world 2 sub-level 1 (level2.pin + level2b.pap) from a clean start', sw10 > 0 && f10.firstBad === null && f10.matched >= 1500, `${f10.matched} rows from row ${sw10}, first mismatch ${f10.firstBad ?? 'none'}`);
    }
    // One session, two clean level-code warps (5284 -> world 2 sub-level 2 on level2b.pap, 2818 -> sub-level 4 on level2a.pap): each segment
    // is booted from level2.pin plus its map, with the generator seeded from the capture (a warp does not reseed it) and checked every row.
    let live11 = null;
    try { live11 = await loadGzJson(ctx, 'tools/attract-capture/live11-w2s2s4.capture.json.gz'); } catch { /* absent */ }
    if (live11) {
      const ex11 = expandRows(live11.rows);
      const w11 = (r, o) => { const b = Uint8Array.from(r.g.match(/../g), (h) => parseInt(h, 16)); return b[o - 0x8b50] | (b[o - 0x8b50 + 1] << 8); };
      const script11 = rncUnpack(await ctx.fetchRaw('data/level2.pin')).data;
      const mapOf11 = async (name) => { const g = rncUnpack(await ctx.fetchRaw('data/' + name)).data; const mp = new Uint8Array(128 * 128); for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) mp[c * 128 + r] = g[r * 128 + c]; return mp; };
      const seg = async (sub, pap, from, to) => {
        const e = { ...env, map: await mapOf11(pap) };
        const b = bootFromFiles(e, script11, { world: 2, sub, demo: false });
        stepIterationAfterRng(b.m, { unported: new Set(), events: [] }, null);
        b.m.w16(0x8b71, w11(ex11[from], 0x8b71)); b.m.w16(0x8b6b, w11(ex11[from], 0x8b6b));
        return runLiveFree(e, live11.rows, { start: b.m, from, to, entitiesOnly: true, checkRng: true, force: [[0x8b96, 50]], levelFiles: () => ({ script: script11, map: e.map }) });
      };
      const s2 = ex11.findIndex((r) => w11(r, 0x8b89) === 2 && w11(r, 0x8b8b) === 2 && r.e.length > 0);
      const s4 = ex11.findIndex((r) => w11(r, 0x8b89) === 2 && w11(r, 0x8b8b) === 4 && r.e.length > 0);
      const f2 = await seg(2, 'level2b.pap', s2, s4 > 0 ? Math.min(750, s4 - 1) : 750);
      check('a free run with the generator checked reproduces world 2 sub-level 2 (level2b.pap) until the capture script itself types the next code', s2 > 0 && f2.firstBad === null && f2.matched >= 640, `${f2.matched} rows from row ${s2}, first mismatch ${f2.firstBad ?? 'none'}`);
      const f4 = await seg(4, 'level2a.pap', s4, ex11.length - 1);
      check('a free run with the generator checked reproduces every row of world 2 sub-level 4 (level2a.pap)', s4 > 0 && f4.firstBad === null && f4.matched >= 690, `${f4.matched} rows from row ${s4}, first mismatch ${f4.firstBad ?? 'none'}`);
    }
    // The level table: every (world, sub-level) the game can warp to, as dumped from DOSBox, against the files the registry names.
    let levelEvidence = null;
    try { levelEvidence = JSON.parse(new TextDecoder().decode(await ctx.fetchRaw('tools/attract-capture/level-files.json'))); } catch { /* absent */ }
    if (levelEvidence) {
      const bad = [];
      for (const lv of levelEvidence.levels) {
        const files = levelFilesFor(lv.world, lv.sub);
        if (!files) { bad.push(`${lv.world}.${lv.sub} has no registry entry`); continue; }
        const pin = rncUnpack(await ctx.fetchRaw('data/' + files.pin)).data;
        if (crc16arc(pin.subarray(0, lv.pinLen)) !== lv.pinCrc || pin.length !== lv.pinLen) bad.push(`${lv.world}.${lv.sub} script ${files.pin}`);
        if (lv.papCellsDiffering === 0) {
          const g = rncUnpack(await ctx.fetchRaw('data/' + files.pap)).data;
          const mp = new Uint8Array(128 * 128);
          for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) mp[c * 128 + r] = g[r * 128 + c];
          if (crc16arc(mp) !== lv.papCrc) bad.push(`${lv.world}.${lv.sub} map ${files.pap}`);
        }
      }
      check('the level registry names the same script and map files the game had in memory after each level-code warp (all four worlds, 24 levels)', levelEvidence.levels.length >= 24 && bad.length === 0, bad.length ? bad.join('; ') : `${levelEvidence.levels.length} levels`);
      note('levels whose real map differs from the file by a few cells (runtime tile changes)', levelEvidence.levels.filter((l) => l.papCellsDiffering > 0).map((l) => `${l.world}.${l.sub}: ${l.papCellsDiffering}`).join(', '));
    }
    // World 3 (one session, three clean warps: 3505 -> sub 1 on level3a, 9877 -> sub 4 on level3b, 3123 -> sub 8 on sea.pap + level3c.pin).
    // Sub 1 reproduces in full; the sea level up to the float controls (3CE8 target 0x41), a ratchet to raise when those are ported.
    let live12 = null;
    try { live12 = await loadGzJson(ctx, 'tools/attract-capture/live12-w3.capture.json.gz'); } catch { /* absent */ }
    if (live12) {
      const ex12 = expandRows(live12.rows);
      const w12 = (r, o) => { const b = Uint8Array.from(r.g.match(/../g), (h) => parseInt(h, 16)); return b[o - 0x8b50] | (b[o - 0x8b50 + 1] << 8); };
      const seg3 = async (sub, from, to) => {
        const files = levelFilesFor(3, sub);
        const script = rncUnpack(await ctx.fetchRaw('data/' + files.pin)).data;
        const g = rncUnpack(await ctx.fetchRaw('data/' + files.pap)).data;
        const mp = new Uint8Array(128 * 128);
        for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) mp[c * 128 + r] = g[r * 128 + c];
        const e = { ...env, map: mp };
        const b = bootFromFiles(e, script, { world: 3, sub, demo: false });
        stepIterationAfterRng(b.m, { unported: new Set(), events: [] }, null);
        b.m.w16(0x8b71, w12(ex12[from], 0x8b71)); b.m.w16(0x8b6b, w12(ex12[from], 0x8b6b));
        return runLiveFree(e, live12.rows, { start: b.m, from, to, entitiesOnly: true, checkRng: true, force: [[0x8b96, 50]], levelFiles: () => ({ script, map: e.map }) });
      };
      const a1 = ex12.findIndex((r) => w12(r, 0x8b89) === 3 && w12(r, 0x8b8b) === 1 && r.e.length > 0);
      const f3a = await seg3(1, a1, 726);
      check('a free run with the generator checked reproduces world 3 sub-level 1 (level3a, animated water included) from a clean start until the capture script types the next code', a1 > 0 && f3a.firstBad === null && f3a.matched >= 640, `${f3a.matched} rows from row ${a1}, first mismatch ${f3a.firstBad ?? 'none'}`);
      const a8 = ex12.findIndex((r) => w12(r, 0x8b89) === 3 && w12(r, 0x8b8b) === 8 && r.e.length > 0);
      const f3c = await seg3(8, a8, a8 + 70);
      check('a free run with the generator checked reproduces the first 70 rows of the world 3 sea level (call #13 has carry 0 there)', a8 > 0 && f3c.firstBad === null && f3c.matched >= 65, `${f3c.matched} rows from row ${a8}, first mismatch ${f3c.firstBad ?? 'none'}`);
    }
    // World 4 (one session, warps 8498 -> sub 1, then sub 2 and sub 5 by the level codes): three full segments, the generator checked every row.
    // Rows polled between a roll and call #13 (call #13 has carry 0 in world 4) are recognised by the generator alone (see runLiveFree).
    for (const [file, segs, world = 4, pinHurt = false, noGod = false, pokes = []] of [
      ['live13-w4', [[1, 52, 726, 660], [2, 739, 1413, 660], [5, 1426, 2100, 640]]],
      ['live14-w4b', [[3, 52, 726, 630], [4, 739, 1413, 640]]],
      ['live15-w4c', [[6, 52, 726, 660], [7, 739, 1413, 650], [8, 1426, 2278, 780]]],
      // world 3: the capture script kept [8B96] at 0x32 several times per iteration, replayed with pinHurtTimer
      ['live16-w3b', [[2, 52, 726, 630], [3, 739, 1413, 630], [5, 1426, 2142, 610]], 3, true],
      // sub-levels 7 and 8 start from the first real row: the warp kept the hero floating (target 0x41), which a files-only boot does not know
      ['live17-w3c', [[6, 52, 726, 550], [7, 739, 1413, 570, true], [8, 1426, 2131, 700, true]], 3, true],
      ['live18-w2b', [[3, 52, 726, 620], [5, 740, 1414, 630], [6, 1427, 2166, 700]], 2, true],
      ['live19-w2c', [[7, 52, 726, 660]], 2, true],
      ['live19-w2c', [[6, 739, 1969, 1100, true]], 1, true], // the boss level (world 1 sub-level 6), the hero on skates for part of it
      ['live21-w2d', [[2, 52, 726, 640], [4, 739, 1413, 650], [5, 1426, 2036, 570]], 2, false, true], // played without god mode: the hero is hurt, loses hearts and bounces
      ['live22-w3d', [[1, 52, 726, 620], [2, 738, 1412, 640]], 3, false, true], // played without god mode
      ['live23-w4d', [[1, 52, 726, 650], [2, 739, 1413, 650], [5, 1426, 1950, 490]], 4, false, true],
      ['live24-w1d', [[2, 52, 726, 640], [5, 739, 1413, 610], [6, 1425, 2099, 550, true]], 1, false, true], // played without god mode, ending on skates in the boss level
      ['live27-w2s6-w4s7', [[6, 52, 596, 510], [7, 609, 1153, 530]], 2, false, true], // non-god, fresh seed: world 2's last two levels
      ['live27-w2s6-w4s7', [[7, 1167, 2099, 900]], 4, false, true], // non-god: world 4 sub-level 7 (the same capture, typed 5139)
      ['live28-w3', [[1, 0, 1241, 1200, true], [1, 1338, 1492, 150, true]], 1, false, true], // non-god from the first row of a level (loadStart): a failed warp left the hero on world 1 sub-level 1, then the demo and a new game
      ['live29-w3', [[5, 52, 544, 440, true], [6, 561, 1065, 410, true], [7, 1078, 1939, 740, true]], 3, false, true], // non-god, fresh seed: world 3 sub-levels 5-7
      ['live30-w4w1', [[6, 54, 558, 500, true], [8, 571, 1075, 455, true]], 4, false, true], // non-god, fresh seed: world 4 sub-levels 6 and 8
      ['live30-w4w1', [[6, 1087, 1939, 730, true]], 1, false, true], // non-god: the world 1 boss level
      ['live31-w1w2', [[2, 52, 556, 500, true]], 1, false, true], // non-god, fresh seed: world 1 sub-level 2
      ['live33-w3w4', [[2, 52, 546, 470, true], [3, 559, 1053, 470, true]], 3, false, true], // non-god, fresh seed, aggressive fire: world 3 sub-levels 2 and 3
      ['live33-w3w4', [[2, 1066, 1899, 820, true]], 4, false, true], // non-god: world 4 sub-level 2
      // Targeted state setups (the capture script wrote these bytes after logging the row before `row`): [8C04] = 0x27 with a weapon timer, 0x1B with a
      // count, 0x40; the hero mode [8B98] = 0x1A, then 0x43 (the burden: its landing F675, 3E15/4233), back to 0. Every one of 899 rows reproduces.
      ['live34-pokes', [[2, 0, 899, 890, true]], 4, false, true, [
        { row: 101, addr: 0x8c04, bytes: [0x27] }, { row: 101, addr: 0x8bef, bytes: [0xe8, 0x03] },
        { row: 261, addr: 0x8c04, bytes: [0x1b] }, { row: 261, addr: 0x8c0a, bytes: [5] },
        { row: 421, addr: 0x8c04, bytes: [0x40] },
        { row: 561, addr: 0x8b98, bytes: [0x1a] },
        { row: 641, addr: 0x8b98, bytes: [0] }, { row: 641, addr: 0x8c04, bytes: [0] },
        { row: 701, addr: 0x8b98, bytes: [0x43] },
        { row: 801, addr: 0x8b98, bytes: [0] }, { row: 801, addr: 0x8c04, bytes: [0] },
      ]],
      // More targeted setups on world 1 level 1 (rows are `row` = the logged row + 1): [8C04] = 0x45, then 0x2A with a timer; hero mode [8B98] = 1 (the crate), 0x15 (skates), 0x41 (float);
      // [8C04] = 0x1B with a count; the hurt timer [8B96]. Two segments (a game over and the demo sit between them); both reproduce row for row.
      ['live35-pokes2', [[1, 0, 577, 560, true], [1, 664, 949, 280, true]], 1, false, true, [
        { row: 101, addr: 0x8c04, bytes: [0x45] },
        { row: 221, addr: 0x8c04, bytes: [0x2a] }, { row: 221, addr: 0x8bef, bytes: [0xf4, 0x01] },
        { row: 341, addr: 0x8c04, bytes: [0] }, { row: 341, addr: 0x8b98, bytes: [1] },
        { row: 461, addr: 0x8b98, bytes: [0x15] }, { row: 461, addr: 0x8b97, bytes: [0] },
        { row: 581, addr: 0x8b98, bytes: [0x41] },
        { row: 701, addr: 0x8b98, bytes: [0] }, { row: 701, addr: 0x8c04, bytes: [0x1b] }, { row: 701, addr: 0x8c0a, bytes: [2] },
        { row: 821, addr: 0x8b96, bytes: [0x30] },
      ]],
      // 37 live retypes: every 40 rows the capture script rewrote the class word of one on-screen enemy to another entity type (0x10..0x5F), so the class
      // dispatch of the AI/touch/shot code ran on classes the level never spawns there (god mode, the hurt timer pinned). 1498 of 1500 rows reproduce.
      ['live36-retype', [[1, 0, 1499, 1490, true]], 1, false, false, 'live36-retype.pokes.json'],
      // The same retype campaign in worlds 3 and 2 (god mode, hurt timer pinned); the capture script made 24 class rewrites in all.
      ['live37-retype-w3w2', [[1, 52, 596, 520, true]], 3, false, false, 'live37-retype-w3w2.pokes.json'],
      ['live37-retype-w3w2', [[1, 610, 1579, 955, true]], 2, false, false, 'live37-retype-w3w2.pokes.json'],
      // The retype campaign in world 4 (sub-levels 1 and 4; a different order of entity types, 24 rewrites): worlds 1-4 have now all run it.
      ['live38-retype-w4', [[1, 52, 596, 540, true]], 4, false, false, 'live38-retype-w4.pokes.json'],
      ['live38-retype-w4', [[4, 609, 1579, 935, true]], 4, false, false, 'live38-retype-w4.pokes.json'],
      // 23 live power-up setups: the capture script rewrote an enemy into a type-0x1B item (kind 5/7, frames 0x15..0x67, state 0x3E = 1) on the hero's own position.
      // The captured rows show frame 0x1F (the [8C04] = 0x1B pickup, nine times) and frame 0x66 (an extra continue, twice) taking effect; all of it reproduces.
      ['live39-powerups', [[4, 0, 1299, 1285, true]], 4, false, false, 'live39-powerups.pokes.json'],
      // 24 more power-up setups from a fresh world 1 level (frames 0x1E, 0x67, 0x17, 0x20 in turn): the rows show [8C5F]/[8C61] = 0x90/0x50 (frame 0x1E), [8BA4] = 1
      // (frame 0x67) taking effect, and a counter [8BFF] += 1; all of it reproduces.
      ['live40-powerups2', [[1, 0, 899, 890, true]], 1, false, false, 'live40-powerups2.pokes.json'],
      ['live20-w1c', [[5, 52, 726, 600], [3, 740, 1414, 650], [4, 1427, 2011, 570]], 1, false], // sub-level 5 from a clean warp: the side handler's DI carries over to the ceiling handler
    ]) {
      let cap = null;
      try { cap = await loadGzJson(ctx, `tools/attract-capture/${file}.capture.json.gz`); } catch { /* absent */ }
      if (!cap) continue;
      let pokeList = pokes;
      if (typeof pokes === 'string') { try { pokeList = JSON.parse(new TextDecoder().decode(await ctx.fetchRaw(`tools/attract-capture/${pokes}`))); } catch { continue; } }
      const exc = expandRows(cap.rows);
      const wc = (r, o) => { const b = Uint8Array.from(r.g.match(/../g), (h) => parseInt(h, 16)); return b[o - 0x8b50] | (b[o - 0x8b50 + 1] << 8); };
      const seg4 = async (sub, from, to, loadStart) => {
        const files = levelFilesFor(world, sub);
        const script = rncUnpack(await ctx.fetchRaw('data/' + files.pin)).data;
        const g = rncUnpack(await ctx.fetchRaw('data/' + files.pap)).data;
        const mp = new Uint8Array(128 * 128);
        for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) mp[c * 128 + r] = g[r * 128 + c];
        const e = { ...env, map: mp };
        let start;
        if (loadStart) {
          start = loadRow(e, exc[from]); start.put(0, script); start.w16(0xef23, start.u16(0xef25 + (world - 1) * 2)); mapFixups(start, world);
        } else {
          const b = bootFromFiles(e, script, { world, sub, demo: false });
          stepIterationAfterRng(b.m, { unported: new Set(), events: [] }, null);
          b.m.w16(0x8b71, wc(exc[from], 0x8b71)); b.m.w16(0x8b6b, wc(exc[from], 0x8b6b));
          start = b.m;
        }
        return runLiveFree(e, cap.rows, { start, from, to, entitiesOnly: true, checkRng: true, force: noGod ? [] : [[0x8b96, 50]], pinHurtTimer: pinHurt, pokes: pokeList, levelFiles: () => ({ script, map: e.map }) });
      };
      for (const [sub, from, to, min, loadStart] of segs) {
        const ok = exc[from] && wc(exc[from], 0x8b89) === world && wc(exc[from], 0x8b8b) === sub;
        const f = ok ? await seg4(sub, from, to, loadStart) : { matched: 0, firstBad: 'start row is not this level' };
        check(`a free run with the generator checked reproduces world ${world} sub-level ${sub} from a clean start until the capture script types the next code`, ok && f.firstBad === null && f.matched >= min, `${f.matched} rows from row ${from}, first mismatch ${f.firstBad ?? 'none'}`);
      }
    }
    note('live-play unported branches still hit', [...lr.unportedHist].map(([k, n]) => `${k} x${n}`).join(', ') || 'none');
  }
  const top = [...all.unportedHist].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} x${n}`).join(', ');
  note('unported branches still hit', top || 'none');
  return results;
}


/** Sprite rendering (web/render/sprites.js): frame -> tile-stream -> bank tile, from the shipped bytes.
 *  The 396-byte entity dump below is a live DOSBox read (paused, world 1 level 1, [8B69]=0): the same frame
 *  rendered by the port matched the DOSBox screenshot on 2681 of 2764 sprite pixels (the rest is the score
 *  digits the HUD pass writes, not part of this DS image). [PROVEN] live; these rows pin the decode. */
const LIVE_ENTITIES_B64 = '/wABAAEAQP3A/AEAAsYAAAEABAAIAAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEABAAA/wADAAMAkABQAEAAAsgAAEEASAAIAAoAIAAgAAQABAAYABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEIAAAEABAAAAAACAAAAkABkALAAWsQAALAAsAAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEABPYAAAAHAAAAcACoAAIAAAAAAAIAAgAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEABAAAAAAYAAAAAACoAHwAWsQAAH8AfwAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMABAAAAAAZAAAAIAGoAHoAWsQAAHoAegAAAA0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEABAAA';
/** Sprites in worlds 2, 3 and 4 against a live DOSBox video frame each (tools/sprite-video/, made with tools/sprite-video-compare.mjs):
 *  the entity block dumped from DOSBox is rebuilt through collectDraws and rasterised with the world's banks and palette, and every sprite
 *  pixel inside the 192-line view must equal the video pixel. The literals are the number of sprite pixels in that frame. [PROVEN] live. */
export async function checkSpriteWorlds(ctx) {
  const { results, check } = makeChecker();
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  const hexBytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
  for (const [world, opaqueLiteral, cmdsLiteral] of [[2, 4502, 19], [3, 2198, 41], [4, 4329, 32]]) {
    let ref;
    try { ref = await loadGzJson(ctx, `tools/sprite-video/world${world}.json.gz`); } catch { check(`world ${world} video frame (not available)`, true, 'skipped'); continue; }
    const raw = {};
    for (const b of Object.values(BANKS)) for (const f of b.files) { const n = f.replace('%', world); raw[n] = rncUnpack(await ctx.fetchRaw(`data/${n}`)).data; }
    const m = new DsMemory(exe);
    m.put(0x8b50, hexBytes(ref.g)); m.put(0x91be, hexBytes(ref.l)); m.put(0x9398, hexBytes(ref.b));
    const cmds = collectDraws(m);
    const img = rasterize(cmds, buildBanks(raw, world), WORLD_PALETTES['world' + world]);
    const vid = Uint8Array.from(atob(ref.rgb), (c) => c.charCodeAt(0));
    let opaque = 0, same = 0;
    for (let i = 0; i < img.length; i++) if (img[i] >= 0) { opaque++; if (((vid[i * 3] << 16) | (vid[i * 3 + 1] << 8) | vid[i * 3 + 2]) === img[i]) same++; }
    check(`world ${world}: ${cmdsLiteral} draw commands for the live entity block`, cmds.length === cmdsLiteral, `${cmds.length}`);
    check(`world ${world}: all ${opaqueLiteral} sprite pixels equal the DOSBox frame`, opaque === opaqueLiteral && same === opaqueLiteral, `${same}/${opaque}`);
  }
  return results;
}

const DATA_CENSUS = [
  ['adlib.pin', 6525, 20655],
  ['adlib2.pin', 1293, 10328],
  ['adlib3.pin', 1287, 10328],
  ['ape.pak', 11622, 38400],
  ['autoplay.pin', 430, 2000],
  ['beeper.pin', 3198, 6438],
  ['bitkid.pak', 15836, 38400],
  ['blocks1.pak', 24384, 30720],
  ['blocks2.pak', 25156, 30720],
  ['blocks3.pak', 20345, 30720],
  ['blocks4.pak', 19851, 30720],
  ['endscrn.pip', 13344, 32066],
  ['extra_2.pin', 19956, 38400],
  ['extras.pak', 19612, 38400],
  ['extrax1.pak', 3394, 12800],
  ['extrax2.pak', 2864, 12800],
  ['extrax3.pak', 5979, 12800],
  ['extrax4.pak', 2391, 12800],
  ['intro0.pip', 13330, 32066],
  ['intro1.pip', 8328, 32066],
  ['intro2.pip', 7082, 32066],
  ['intro3.pip', 10690, 32066],
  ['intro4.pip', 12880, 32066],
  ['intro5.pip', 2876, 10274],
  ['kidx1.pak', 4826, 12800],
  ['kidx2.pak', 4026, 12800],
  ['kidx3.pak', 5077, 12800],
  ['kidx4.pak', 4459, 12800],
  ['level0.pin', 1558, 5888],
  ['level1a.pap', 8822, 16384],
  ['level1b.pap', 9172, 16384],
  ['level2.pin', 5311, 13946],
  ['level2a.pap', 7223, 16384],
  ['level2b.pap', 6919, 16384],
  ['level3a.pap', 5630, 16384],
  ['level3a.pin', 2351, 5744],
  ['level3b.pap', 8240, 16384],
  ['level3b.pin', 3022, 7680],
  ['level3c.pin', 1371, 4882],
  ['level4.pin', 5703, 16662],
  ['level4a.pap', 5299, 16384],
  ['level4b.pap', 7229, 16384],
  ['nasty1.pak', 17199, 38400],
  ['nasty2.pak', 18586, 38400],
  ['nasty3.pak', 18432, 38400],
  ['nasty4.pak', 19450, 38400],
  ['new.pip', 17421, 32066],
  ['new1.pin', 6175, 16662],
  ['pcmap.pap', 7254, 16384],
  ['player.pin', 6743, 12064],
  ['roland.pin', 3110, 8028],
  ['roland2.pin', 6220, 17201],
  ['sblaster.pin', 41153, 59699],
  ['sea.pap', 9029, 16384],
  ['soundbnk.pin', 3811, 17320],
  ['special1.pak', 6096, 12800],
  ['special2.pak', 5423, 12800],
  ['special3.pak', 5879, 12800],
  ['special4.pak', 5112, 12800],
  ['tandy.pin', 3202, 6344],
];
const PAP_RANGES = [
  ['level1a.pap', 1, 120],
  ['level1b.pap', 1, 119],
  ['level2a.pap', 1, 120],
  ['level2b.pap', 1, 120],
  ['level3a.pap', 1, 120],
  ['level3b.pap', 1, 120],
  ['level4a.pap', 1, 120],
  ['level4b.pap', 1, 120],
  ['pcmap.pap', 1, 120],
  ['sea.pap', 1, 115],
];

const DESCRIPTORS = [ // [type, columns, rows, bank, cell width, cell height, frameSourceMode]
  [0, 0, 0, 0, 0, 0, 0],
  [1, 128, 128, 5, 32, 16, 0],
  [2, 1, 1, 6, 16, 16, 0],
  [3, 1, 2, 2, 32, 16, 0],
  [4, 1, 1, 6, 16, 16, 1],
  [5, 1, 2, 2, 32, 16, 0],
  [6, 2, 2, 6, 16, 16, 0],
  [7, 6, 1, 6, 16, 16, 0],
  [8, 1, 1, 6, 16, 16, 0],
  [9, 8, 2, 6, 16, 16, 0],
  [10, 1, 1, 6, 16, 16, 1],
  [11, 1, 1, 3, 20, 20, 1],
  [12, 1, 1, 3, 26, 26, 1],
  [13, 1, 1, 3, 32, 32, 1],
  [14, 1, 1, 6, 16, 16, 1],
  [15, 1, 1, 6, 16, 16, 1],
  [16, 1, 1, 3, 32, 32, 1],
  [17, 2, 1, 6, 32, 16, 0],
  [18, 1, 1, 7, 32, 32, 0],
  [19, 1, 1, 7, 32, 32, 0],
  [20, 1, 1, 7, 32, 32, 0],
  [21, 1, 1, 2, 32, 32, 0],
  [22, 1, 1, 6, 16, 16, 1],
  [23, 2, 1, 6, 16, 16, 256],
  [24, 2, 2, 6, 16, 16, 0],
  [25, 1, 1, 2, 32, 32, 0],
  [26, 2, 1, 6, 16, 16, 0],
  [27, 1, 1, 6, 16, 16, 1],
  [28, 2, 2, 6, 16, 16, 256],
  [29, 2, 1, 6, 16, 16, 0],
  [30, 1, 1, 6, 16, 16, 0],
  [31, 1, 1, 6, 16, 16, 1],
  [32, 1, 1, 7, 32, 32, 0],
  [33, 1, 1, 2, 32, 32, 0],
  [34, 2, 1, 6, 16, 16, 0],
  [35, 1, 1, 7, 32, 32, 0],
  [36, 2, 2, 6, 16, 16, 0],
  [37, 4, 1, 6, 16, 16, 0],
  [38, 2, 2, 6, 16, 16, 0],
  [39, 1, 1, 6, 16, 16, 1],
  [40, 1, 1, 6, 16, 16, 1],
  [41, 2, 2, 6, 16, 16, 0],
  [42, 2, 2, 6, 16, 16, 0],
  [43, 1, 1, 2, 32, 32, 1],
  [44, 1, 1, 6, 16, 16, 0],
  [45, 16, 1, 6, 16, 16, 0],
  [46, 2, 2, 6, 16, 16, 256],
  [47, 1, 1, 2, 32, 16, 1],
  [48, 1, 1, 6, 16, 16, 1],
  [49, 1, 1, 3, 20, 20, 1],
  [50, 1, 1, 3, 26, 26, 1],
  [51, 1, 1, 3, 32, 32, 1],
  [52, 1, 1, 3, 32, 32, 1],
  [53, 1, 1, 6, 16, 16, 1],
  [54, 2, 1, 6, 20, 16, 0],
  [55, 1, 1, 3, 26, 26, 1],
  [56, 1, 1, 3, 32, 32, 1],
  [57, 1, 1, 3, 32, 32, 1],
  [58, 1, 1, 6, 16, 16, 1],
  [59, 1, 1, 3, 20, 20, 1],
  [60, 1, 1, 3, 26, 26, 1],
  [61, 1, 1, 3, 32, 32, 1],
  [62, 1, 1, 3, 32, 32, 1],
  [63, 1, 1, 2, 32, 16, 0],
  [64, 1, 1, 6, 16, 16, 256],
  [65, 1, 1, 3, 32, 32, 0],
  [66, 2, 2, 7, 32, 32, 0],
  [67, 1, 1, 2, 32, 32, 0],
  [68, 1, 1, 6, 16, 16, 1],
  [69, 2, 2, 6, 16, 16, 0],
  [70, 5, 1, 6, 16, 16, 0],
  [71, 15, 1, 2, 32, 28, 0],
  [72, 1, 1, 7, 32, 32, 0],
  [73, 1, 1, 7, 32, 32, 0],
  [74, 1, 1, 7, 32, 32, 1],
  [75, 1, 1, 7, 32, 32, 1],
  [76, 1, 1, 7, 32, 32, 1],
  [77, 1, 1, 6, 16, 16, 1],
  [78, 1, 1, 7, 32, 32, 1],
  [79, 1, 1, 7, 32, 32, 1],
  [80, 1, 1, 7, 32, 32, 1],
  [81, 1, 1, 7, 32, 32, 1],
  [82, 2, 2, 6, 16, 16, 256],
  [83, 1, 1, 6, 16, 16, 1],
  [84, 1, 1, 7, 32, 32, 1],
  [85, 1, 1, 6, 16, 16, 1],
  [86, 1, 1, 2, 32, 32, 0],
  [87, 1, 1, 7, 32, 32, 1],
  [88, 1, 1, 7, 32, 32, 1],
  [89, 1, 1, 7, 32, 32, 1],
  [90, 1, 1, 7, 32, 32, 1],
  [91, 1, 1, 7, 32, 32, 1],
  [92, 1, 1, 2, 32, 16, 65535],
  [93, 1, 1, 7, 32, 32, 1],
  [94, 1, 1, 6, 16, 16, 1],
  [95, 1, 1, 6, 16, 16, 1],
];

const LEVEL_CENSUS = [ // [file, per sub-level [entity records, control markers]]
  ['level0.pin', [[112,2],[109,1],[22,1],[13,1],[11,1],[13,1],[8,1],[8,1],[9,1],[8,1],[0,0],[0,0],[0,0],[0,0],[0,0]]],
  ['level2.pin', [[143,2],[140,1],[130,1],[129,1],[140,1],[117,1],[139,1],[22,1]]],
  ['level3a.pin', [[91,2],[88,1],[108,1],[136,1],[6,1]]],
  ['level3b.pin', [[114,2],[111,1],[111,1],[111,1],[111,1],[89,1],[140,1],[109,1]]],
  ['level3c.pin', [[74,2],[71,1],[71,1],[71,1],[71,1],[71,1],[71,1],[71,1],[71,1],[68,1],[52,1],[65,1],[65,1]]],
  ['level4.pin', [[84,2],[81,1],[88,1],[107,1],[106,1],[128,1],[128,1],[104,1],[57,1],[91,1],[0,0],[0,0],[0,0],[0,0],[0,0]]],
  ['new1.pin', [[112,2],[115,1],[10,2],[109,1],[108,1],[101,1],[40,1],[98,1],[91,1],[81,1],[73,1],[46,1],[106,1]]],
];

/** Per level-script file: entity-record and control-marker counts of every sub-level slot, as the decoder reads them. */
export async function checkLevelCensus(ctx) {
  const { results, check } = makeChecker();
  for (const [name, want] of LEVEL_CENSUS) {
    let raw = null;
    try { raw = await ctx.fetchRaw(`data/${name}`); } catch { /* absent */ }
    if (!raw) continue;
    const r = decodeLevelScript(rncUnpack(raw).data);
    const subs = r.sublevels || r.levels || [];
    const got = subs.map((x) => [x.entities.length, x.events.length]);
    check(`${name}: ${want.length} sub-level slots, ${want.reduce((a, x) => a + x[0], 0)} entity records`, JSON.stringify(got) === JSON.stringify(want), `${got.length} slots`);
  }
  return results;
}

/** The 96 sprite descriptors of GAMEU.EXE (near pointers at DS:C39A, words +0xA columns, +0xC rows, +0xE bank, +0x12/+0x14 cell size, +0x16 frameSourceMode), pinned as read. */
export async function checkDescriptors(ctx) {
  const { results, check } = makeChecker();
  const m = new DsMemory(await ctx.fetchRaw('game/GAMEU.EXE'));
  for (const [t, ...want] of DESCRIPTORS) {
    const d = m.u16(0xc39a + 2 * t);
    const got = [0xa, 0xc, 0xe, 0x12, 0x14, 0x16].map((o) => m.u16(d + o));
    check(`sprite descriptor ${t}: ${want.join(',')}`, got.join() === want.join(), got.join());
  }
  return results;
}

/** Every shipped data file by name: packed size on disk and unpacked size, and the value range of each map. The literals are the files
 *  as shipped (a regression pin: a decoder change or a wrong file shows up here); RNC's own CRCs are checked in the group above. */
export async function checkDataCensus(ctx) {
  const { results, check } = makeChecker();
  for (const [name, packed, unpacked] of DATA_CENSUS) {
    let raw = null;
    try { raw = await ctx.fetchRaw(`data/${name}`); } catch { /* absent */ }
    if (!raw) { check(`${name}: not available`, true, 'skipped'); continue; }
    const r = rncUnpack(raw);
    check(`${name}: ${packed} bytes on disk, ${unpacked} unpacked`, raw.length === packed && r.data.length === unpacked, `${raw.length} / ${r.data.length}`);
  }
  for (const [name, lo, hi] of PAP_RANGES) {
    let raw = null;
    try { raw = await ctx.fetchRaw(`data/${name}`); } catch { /* absent */ }
    if (!raw) continue;
    const g = rncUnpack(raw).data;
    let mn = 255, mx = 0;
    for (const v of g) { if (v < mn) mn = v; if (v > mx) mx = v; }
    check(`${name}: map cells run from ${lo} to ${hi}`, mn === lo && mx === hi, `${mn}..${mx}`);
  }
  return results;
}

/** Opcode 38 (level-code entry, 1000:2474) on a bare data segment: the glyph rules the disassembly gives. [STATIC] */
export async function checkCodeEntry(ctx) {
  const { results, check } = makeChecker();
  const m0 = new DsMemory(await ctx.fetchRaw('game/GAMEU.EXE'));
  check('code entry: glyph table row for scancode 0x48 is the "8" key (0x38)', m0.u8(0xedb4 + 0x48) === 0x38);
  check('code entry: glyph table row for scancode 0x50 is the "2" key (0x32)', m0.u8(0xedb4 + 0x50) === 0x32);
  check('code entry: scancodes 0x4B / 0x4D map to the "4" / "6" keys (0x34, 0x36)', m0.u8(0xedb4 + 0x4b) === 0x34 && m0.u8(0xedb4 + 0x4d) === 0x36);
  // 49 transitions of the real level-code screen (DOSBox, 2026-10-10, tools/attract-capture/code-entry.transitions.json): the glyph buffer
  // at DS:E70F, the cursor [8C33] and the typed sum [8BC3] before and after one pass of opcode 38 with the logged key bytes.
  let trans = null;
  try { trans = JSON.parse(new TextDecoder().decode(await ctx.fetchRaw('tools/attract-capture/code-entry.transitions.json'))); } catch { /* absent */ }
  if (trans) {
    const hexb = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
    let bad = 0, first = '';
    trans.forEach((t, i) => {
      const m = m0.clone();
      m.w8(0x8c33, t.c33); m.put(0xe70f, hexb(t.buf)); m.w16(0x8bc1, t.c1); m.w8(0x8b5d, t.in5d); m.w8(0x8b60, t.in60); m.w8(0x8bac, 0);
      m.w16(0x9398 + 0xc, 0x1234); m.w8(0x9398 + 1, 0x77);
      codeEntry(m, 0x9398, 0x9500, { unported: new Set(), events: [], rng() {} });
      const got = Array.from(m.get(0xe70f, 7), (b) => b.toString(16).padStart(2, '0')).join('');
      const final = t.toAc === 1;
      const okBuf = final ? got.slice(10, 12) === t.toBuf.slice(10, 12) : got.slice(0, 10) === t.toBuf.slice(0, 10);
      const okC3 = t.in60 === 0x1c && !final ? m.u16(0x8bc3) === t.toC3 : true;
      if (!(m.u8(0x8c33) === t.to33 && okBuf && okC3 && (!final || m.u8(0x8bac) === 1))) { bad++; if (!first) first = `#${i} got c33 ${m.u8(0x8c33)} buf ${got}, wanted c33 ${t.to33} buf ${t.toBuf}`; }
    });
    check(`code entry: all ${trans.length} live transitions (cursor, glyphs, typed sum, success) are reproduced by one pass of opcode 38`, bad === 0 && trans.length === 49, bad ? first : `${trans.length}/${trans.length}`);
  }
  return results;
}

export async function checkSprites(ctx) {
  const { results, check } = makeChecker();
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  const m = new DsMemory(exe);
  const stream = (frame, n) => Array.from(m.get(m.u16(0xe4fa + 2 * frame), n));
  const desc = (type) => { const d = m.u16(0xc39a + 2 * type); return Array.from({ length: 14 }, (_, i) => m.u16(d + 2 * i)); };
  check('player descriptor (type 3): mode 0xa, 1 column x 2 rows of 32x16, bank 2', desc(3).join() === '0,65,72,0,10,1,2,2,1,32,16,0,3,12');
  check('player frame 64 streams half-tiles 20,21 (tile 10, top then bottom half)', stream(64, 2).join() === '20,21');
  check('score ring frame 2 streams tile 188 in every cell', stream(2, 4).join() === '188,188,188,188');
  check('type 0x19 descriptor: mode 0xd, one 32x32 cell, bank 2', desc(0x19).join() === '2,122,122,0,13,1,1,2,1,32,32,0,0,0');
  check('type 0x19 frame 122 stream starts with tile 59', stream(122, 1)[0] === 59);
  check('bank tile counts: bitkid 60 + kidx 20, special 20, extras 240 + extrax 80, nasty 60', Object.values(BANKS).map((b) => b.tiles).join() === '80,20,320,60');
  const rawTile = (f, i, size) => rncUnpack(f).data.subarray(i * size, (i + 1) * size);
  const nasty = rawTile(await ctx.fetchRaw('data/nasty1.pak'), 9, 640);
  check('nasty1.pak tile 9 mask row 0 is ff e0 1f ff (matches DOSBox bank 7 segment)', nasty.subarray(16, 20).join() === '255,224,31,255');
  const mir = mirrorTile32(nasty, 0);
  check('mirrored copy of that row is ff f8 07 ff (matches DOSBox bank 8 segment, 1000:B449)', mir.subarray(16, 20).join() === '255,248,7,255');
  const bitkid = rawTile(await ctx.fetchRaw('data/bitkid.pak'), 9, 640);
  check('mirrored bitkid tile 9 row at +20 is ff 80 00 0f (matches DOSBox mirrored bank 2)', mirrorTile32(bitkid, 0).subarray(20, 24).join() === '255,128,0,15');
  // the live DS slice
  const b = Uint8Array.from(atob(LIVE_ENTITIES_B64), (c) => c.charCodeAt(0));
  m.put(0x9398, b);
  [0x9398, 0x93da, 0x941c, 0x94e2, 0x94a0, 0x945e, 0xffff].forEach((v, i) => m.w16(0x91be + 2 * i, v));
  m.w16(0x8b69, 0);
  const cmds = collectDraws(m);
  const short = cmds.map((c) => `${c.type}:${c.bank}/${c.tile}${c.half >= 0 ? 'h' + c.half : ''}@${c.dx},${c.dy}${c.vflip ? 'v' : ''}${c.mirror ? 'm' : ''}`);
  check('live frame: 14 draw commands', cmds.length === 14, `${cmds.length}`);
  check('live frame: player = bank 2 tile 10, top half at (144,80), bottom half at (144,96), facing 8 unmirrored', short[0] === '3:2/10h0@144,80' && short[1] === '3:2/10h1@144,96');
  check('live frame: type 0x19 hand = bank 2 tile 59 flipped at (288,168)', short[3] === '25:2/59@288,168v');
  check('live frame: score ring = six 16x16 tiles of bank 6 tile 188 along y=168', short.slice(8).join() === [112, 128, 144, 160, 176, 192].map((x) => `7:6/188@${x},168`).join());
  check('player facing 4 reads the mirrored bank', (() => { m.w16(0x93da + 0x14, 4); return collectDraws(m)[0].mirror === true; })());
  return results;
}


/**
 * The front end (web/engine/frontend.js): the world intro screen against DOSBox video captures of all four worlds (palette indices,
 * three states each, plus the frame numbers of every fade step and box toggle), and the level dispatch against the shipped file names.
 */
export async function checkFrontend(ctx) {
  const { results, check, note } = makeChecker();
  const exeBytes = await ctx.fetchRaw('game/GAMEU.EXE');
  const exe = new Uint8Array(exeBytes);
  const timing = FE.introTiming(exe);
  check('intro timing read from the code bytes: fade banks 0x16..0x1D (8 steps, 2 vsyncs each), 5 blink cycles of 11 + 11 vsyncs', timing.fadeInFirst === 0x16 && timing.fadeInEnd === 0x1e && timing.fadeOutFirst === 0x1d && timing.fadeOutLast === 0x16 && timing.ticksPerStep === 2 && timing.blinkCycles === 5 && timing.onTicks === 11 && timing.offTicks === 11);
  const R = FE.readRects(exe);
  check('intro rectangle table (CS:8EBB..8EE3): number boxes 1-4 are the picture bytes at (288, 0/32/64/96), the arrow is at (0, 160)', R.box.join() === '36,1316,2596,3876' && R.arrowSrc === 6400 && R.boxOffSrc === 6408 && R.islandDst === 2828 && R.boxDst === 2476);
  const pic = FE.decodePictureIndices(rncUnpack(await ctx.fetchRaw('data/new.pip')).data);
  check('new.pip decodes to 320 x 192 indices using all 16 palette entries', pic.length === 61440 && new Set(pic).size === 16);
  let cap = null;
  try { cap = await loadGzJson(ctx, 'tools/front-capture/intro.capture.json.gz'); } catch { /* absent */ }
  if (!cap) { note('front-end capture not found', 'tools/front-capture/intro.capture.json.gz is missing; the intro comparison was skipped'); } else {
    check('the capture holds five intros (world 1 twice, 2, 3, 4)', cap.captures.length === 5 && cap.captures.map((c) => c.world).join() === '1,2,3,4,1');
    const b64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
    for (const c of cap.captures) {
      const blits = FE.introBlits(R, c.world);
      const diff = (img, ph) => { const got = FE.composeIntro(pic, blits, ph, c.panX), want = b64(img); let bad = 0; for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) bad++; return bad; };
      const bad = [diff(c.images.full, { arrow: true, box: 'on' }), diff(c.images.erasedOn, { arrow: false, box: 'on' }), diff(c.images.off, { arrow: false, box: 'off' })];
      check(`world ${c.world} intro (${c.label}, pan ${c.panX}): the composed screen equals the DOSBox frame pixel for pixel in all three states (arrow + box, box, empty box)`, bad.join() === '0,0,0', `mismatching pixels ${bad.join('/')} of 64000`);
      // timing: the model's palette and box changes, relative to the first blink change, against the video frame numbers
      const rel = (a) => a.map((f) => f - c.blink[0]);
      const hold = 0, fadeLen = 16;
      const ticks = [];
      let last = FE.introPhase(timing, 0, hold);
      for (let t = 1; t < 400; t++) { const p = FE.introPhase(timing, t, hold); ticks.push({ t, p, last }); last = p; }
      const B = fadeLen + hold;
      const toggles = [0, ...ticks.filter((x) => x.p.phase === 'blink' && x.p.box !== x.last.box).map((x) => x.t - B)];
      const outChanges = ticks.filter((x) => x.p.phase === 'fadeOut' && x.p.bank !== x.last.bank).map((x) => x.t - B);
      const inChanges = ticks.filter((x) => x.p.phase === 'fadeIn' && x.p.bank !== x.last.bank).map((x) => x.t);
      // every fade step's palette: the model's bank k applied to the composed screen gives the video's (non-black pixels : r+g+b sum) exactly
      const stat = (ph, bank) => { const img = FE.composeIntro(pic, blits, ph, c.panX), pal = FE.bankPalette(exe, bank); let nz = 0, sum = 0; for (const i of img) { const v = pal[i][0] + pal[i][1] + pal[i][2]; if (v) nz++; sum += v; } return `${nz}:${sum}`; };
      const inStats = [0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d].map((b) => stat({ arrow: true, box: 'on' }, b));
      const outStats = [0x1c, 0x1b, 0x1a, 0x19, 0x18, 0x17, 0x16].map((b) => stat({ arrow: false, box: 'off' }, b));
      check(`world ${c.world} intro (${c.label}): every fade step's palette (banks 0x17..0x1D in, 0x1C..0x16 out, read through the pointer table at DS:DE56) reproduces the video frame's lit-pixel count and colour sum`, c.fadeInStats.join() === inStats.join() && c.fadeOutStats.join() === outStats.join(), `${c.fadeInStats[0]} .. ${c.fadeInStats[6]}`);
      check(`world ${c.world} intro (${c.label}): box toggles every 11 frames (10 changes), fade-out changes at +113..+125 every 2, fade-in 7 changes every 2, as in the video`,
        rel(c.blink).join() === toggles.join() && rel(c.fadeOut).join() === outChanges.join() && c.gapsFadeIn.join() === inChanges.slice(1).map((v, i) => v - inChanges[i]).join() && c.fadeIn.length === 7);
    }
    const pans = cap.captures.map((c) => [c.scroll8b69, c.panX]).filter(([s]) => s !== null);
    check('the page flip pans by [8B69] & 7 (+8 when bit 3 is set): [8B69] was 0 for the fresh start and worlds 3/4 and 4 for the world-1 warp, and the frames are shifted by exactly 0 / 4 pixels', pans.map(([s, p]) => `${s}:${p}`).join() === '0:0,0:0,0:0,4:4' && pans.every(([s, p]) => FE.panFromScroll(s) === p));
    note('world 2 intro warped from the GAME OVER screen was shifted by 12 pixels', '[8B69] was not read then (12 = 4 + 8 fits the flip code); [STATIC] for the bit-3 branch');
  }
  check('a fresh GAMEU.EXE data segment has [8B69] = 0, so the very first intro (the fresh start) is not shifted', exe[385392 + 0x8b69] === 0);
  // The state machine: a new game shows the world 1 intro for 16 + 110 + 16 ticks and then asks for world 1 sub-level 1.
  const fs = FE.newGame();
  let n = 0, boot = null;
  while (!boot && n < 1000) { const o = FE.step(fs, timing); boot = o.boot; if (!boot) n++; }
  check('a new game runs the world 1 intro for 142 ticks (16 fade-in, 110 blink, 16 fade-out) and then boots world 1 sub-level 1', n === 142 && boot && boot.world === 1 && boot.sub === 1 && boot.reason === 'newGame', `${n} ticks`);
  // 03FF: the map file each (world, sub-level) loads, as the shipped strings read, against the dumped-from-DOSBox level table.
  const wrong = [];
  let count = 0;
  for (const world of [1, 2, 3, 4]) {
    for (let sub = 1; sub <= 9; sub++) {
      const files = levelFilesFor(world, sub);
      if (!files) continue;
      count++;
      const d = FE.levelDispatch(exe, world, sub);
      if (d.kind !== 'map' || d.map !== files.pap) wrong.push(`${world}.${sub} map ${d.map} != ${files.pap}`);
      if (d.script && d.script !== files.pin) wrong.push(`${world}.${sub} script ${d.script} != ${files.pin}`);
    }
  }
  check('the dispatch at 1000:03FF names the map the DOSBox level table says for every known (world, sub-level), and reloads the script only where that table changes it', count === 29 && wrong.length === 0, wrong.join('; ') || `${count} levels`);
  const after = (w, s) => FE.levelDispatch(exe, w, s);
  check('past the last sub-level of a world the next world starts (7EB): 1 after sub 6, 2 after 7, 3 after 8, 4 after 10; after world 4 it starts over at world 1',
    after(1, 7).world === 2 && after(2, 8).world === 3 && after(3, 9).world === 4 && after(4, 11).world === 1 && after(4, 11).hardMode === true && after(1, 6).kind === 'map' && after(2, 7).kind === 'map' && after(3, 8).kind === 'map');
  check('world 4 sub-level 10 is the ending (endscrn.pip); world 2 sub-level 7 loads ape.pak first; world 3 sub-level 8 loads level3c.pin and sea.pap', after(4, 10).kind === 'ending' && after(4, 10).picture === 'endscrn.pip' && after(2, 7).extraBank === 'ape.pak' && after(3, 8).script === 'level3c.pin' && after(3, 8).map === 'sea.pap');
  return results;
}


/**
 * The screens that run BEFORE GAMEU (docs/launcher.md): KLOGOPOU.EXE's Konami/Renegade screen (web/engine/klogo.js) and INTROU.EXE's caption /
 * close-up / title sequence (web/engine/intro.js) against one DOSBox video of `POCKETS` (tools/front-capture/prelude.capture.json.gz, made and
 * read by import-prelude.mjs). Every video frame is identified by a 64-bit hash of its RGB bytes, so a match is pixel-exact.
 */
export async function checkPrelude(ctx) {
  const { results, check, note } = makeChecker();
  let exeK, exeI, pockets, ini;
  try { [exeK, exeI, pockets, ini] = await Promise.all(['game/KLOGOPOU.EXE', 'game/INTROU.EXE', 'game/pockets.exe', 'game/pockets.ini'].map(async (f) => new Uint8Array(await ctx.fetchRaw(f)))); } catch { /* absent */ }
  if (!exeK || !exeI) { note('KLOGOPOU.EXE / INTROU.EXE not found', 'game/KLOGOPOU.EXE and game/INTROU.EXE are missing; the pre-game screens were not checked'); return results; }
  let cap = null;
  try { cap = await loadGzJson(ctx, 'tools/front-capture/prelude.capture.json.gz'); } catch { /* absent */ }
  const str = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
  // ---- the launcher: pockets.exe runs klogopok.exe /m<mode> /t5, then intro.exe, then game.exe; pockets.ini line 2 "Colour VGA" is mode 1
  const find = (hay, text) => { const n = [...text].map((c) => c.charCodeAt(0)); return indexOfBytes(hay, n); };
  check('pockets.exe names klogopok.exe (tail " /m1 /t5 0"), intro.exe and game.exe, the programs of the start-up chain', find(pockets, ' /m1 /t5 0') >= 0 && find(pockets, 'klogopok.exe\0') >= 0 && find(pockets, 'intro.exe\0') >= 0 && find(pockets, 'game.exe\0') >= 0, '');
  check('pockets.exe maps the video driver letter C (pockets.ini "Colour VGA") to the mode digit 1: `mov byte [1C],0x31 / cmp al,0x43` (and E -> 2, T -> 4, M -> 0 around it)', find(pockets, '\xc6\x06\x1c\x00\x31\x3c\x43') >= 0 && str(ini, 0, 0) === '' && ini[ini.indexOf(10) + 1] === 0x43);
  // ---- KLOGOPOU.EXE: the EJWLIB archive after the MZ image, LZHUF streams, the EGA picture
  const imageEnd = ((exeK[4] | (exeK[5] << 8)) - 1) * 512 + (exeK[2] | (exeK[3] << 8));
  check('KLOGOPOU.EXE: an EJWLIB archive of 3 entries follows the MZ image (offset 15228) and runs to the end of the file', imageEnd === 15228 && str(exeK, imageEnd + 4, 6) === 'EJWLIB' && exeK[imageEnd] === 3, `${exeK.length - imageEnd} bytes`);
  const entries = KL.archiveEntries(exeK);
  check('the archive entries (their 22-byte records are XORed with a running key) are LOGO1.HUF 6455 bytes at 76, LOGO2_4.HUF 4155 at 6531, LOGO3.HUF 3092 at 10686, tiling the archive exactly', entries.map((e) => `${e.name} ${e.size}@${e.offset}`).join() === 'LOGO1.HUF 6455@76,LOGO2_4.HUF 4155@6531,LOGO3.HUF 3092@10686' && entries[2].offset + entries[2].size === exeK.length - imageEnd);
  const dec = lzhufDecode(exeK, imageEnd + entries[0].offset);
  check('LZHUF decodes LOGO1.HUF to 32000 bytes (200 rows x 160) consuming exactly its 6455 stored bytes', dec.data.length === 32000 && dec.end - (imageEnd + entries[0].offset) === entries[0].size, `${dec.end - (imageEnd + entries[0].offset)} bytes read`);
  const logo = KL.loadLogo(exeK);
  check('the logo uses all 16 colours; its target DAC triples are the 48 bytes at DS:04A6 (6-bit values, max 63)', new Set(logo.pixels).size === 16 && logo.target.every((c) => c.every((v) => v <= 63)));
  if (!cap) { note('prelude capture not found', 'tools/front-capture/prelude.capture.json.gz is missing; the DOSBox comparison was skipped'); return results; }
  const states = KL.distinctStates(logo, 5);
  check('the fade is 32 steps in and 32 out of distinct palettes (64 + the black start), the hold repeats the last: 50 x 5 ticks', states.length === 65 && KL.createLogo(logo, { seconds: 5 }).hold === 250 && cap.klogo.steps === 64);
  // every video frame, reconstructed from the palette states and the per-colour tear rows, hashes to the video frame's hash
  let bad = 0, firstBad = -1;
  const fr = cap.klogo.frames;
  fr.forEach(([a, t, h], f) => {
    const split = Array.isArray(t) ? t : new Array(16).fill(t);
    const got = fnv64(KL.frameRgb(logo.pixels, states[a], states[a + 1], split));
    if (got !== h) { bad++; if (firstBad < 0) firstBad = f; }
  });
  check(`KLOGO: all ${fr.length} video frames (fade in, the 5 s hold, fade out) are reproduced pixel for pixel from the decoded picture, the DS:04A6 colours and the +2 / -2 fade states`, bad === 0 && fr.length === 440, bad ? `${bad} differ, first at frame ${firstBad}` : `${fr.length} frames`);
  const torn = fr.filter(([, t]) => Array.isArray(t)).length;
  note('KLOGO frames torn by the 50 Hz palette write', `${torn} of ${fr.length} frames show some colours already one step ahead (the beam position at the interrupt)`);
  const inFrames = fr.filter(([a]) => a < 31).length, holdFrames = fr.filter(([a]) => a === 31).length, outFrames = fr.length - inFrames - holdFrames;
  const ratio = 70.0865 / (1193182 / 0x5d2e); // video frames per timer tick
  const near = (got, ticks) => Math.abs(got - ticks * ratio) <= 3;
  check('KLOGO timing: 32 fade steps = 43 video frames, the 250-tick hold = 352, 32 steps out = 45; the timer runs at 1193182 / 0x5D2E = 50.02 Hz, so a tick is 1.401 video frames (within 3 frames)', near(inFrames, 31) && near(holdFrames, 251) && near(outFrames, 32), `${inFrames} / ${holdFrames} / ${outFrames}`);
  // ---- INTROU.EXE
  const w = (o) => exeI[IN.INTRO_DS + o] | (exeI[IN.INTRO_DS + o + 1] << 8);
  const tbl = []; for (let i = 0; i < 41; i++) tbl.push(w(IN.TIMING_CURSOR.B + 2 * i));
  check('INTROU.EXE script table of the Beeper driver (DS:BAF3): 448, 240, 165, 208, 148, 176, 40, 80, then 5, 5, 5, 5 ... ending 64, 80 after 41 words; wait AX arguments in the code are dead (CS:0F5C reads the cursor)', tbl.slice(0, 12).join() === '448,240,165,208,148,176,40,80,5,5,5,5' && tbl.slice(35).join() === '16,40,172,199,64,80' && w(IN.EXIT_CURSOR) === 80);
  check('INTROU.EXE: `f57` (CS:0F57) loads its wait from [BAEF] (`mov di,[BAEF]; mov ax,[di]`), so `mov ax,imm` before it is dead', exeI[0x90 + 0xf57] === 0x57 && exeI[0x90 + 0xf58] === 0x8b && exeI[0x90 + 0xf59] === 0x3e && exeI[0x90 + 0xf5a] === 0xef && exeI[0x90 + 0xf5b] === 0xba && exeI[0x90 + 0xf5c] === 0x8b && exeI[0x90 + 0xf5d] === 0x05);
  const pics = [];
  for (let n = 0; n < 6; n++) pics.push(IN.decodePip200(rncUnpack(await ctx.fetchRaw(`data/intro${n}.pip`)).data));
  const rowsUsed = Math.max(...Object.values(IN.BLITS).flat().filter((b) => b.slot === 5).map((b) => Math.floor(b.si / 40) + b.rows));
  const intro5 = rncUnpack(await ctx.fetchRaw('data/intro5.pip')).data;
  check('intro5.pip holds only 64 picture rows (10274 bytes): every blit that reads slot 5 stays inside them (the lowest row used is 48)', intro5.length === 10274 && Math.floor((intro5.length - 0x22) / 160) === 64 && rowsUsed === 48, `${rowsUsed} rows`);
  const sim = IN.createIntro({ exe: exeI, pics }, { driver: 'B' });
  const runs = [];
  let lastKey = null, lastHash = null, ticks = 0;
  for (;;) {
    const o = IN.step(sim, null);
    if (o.done) break;
    const key = `${o.draw.rev}:${o.draw.bank}:${JSON.stringify(sim.patches)}`;
    if (key !== lastKey) { lastKey = key; const h = fnv64(IN.frameRgbBytes(sim)); if (h !== lastHash) { runs.push([h, 1]); lastHash = h; } else runs[runs.length - 1][1]++; } else runs[runs.length - 1][1]++;
    ticks++;
  }
  const ref = cap.intro.runs.slice(0, -1); // the last run is GAME's black loading screen
  const refFromFirst = ref.slice(0, ref.length); // [black? no: the first run is the first lit screen]
  const simFromFirst = runs.slice(1); // drop the 448-tick black wait
  const hashesEqual = simFromFirst.length === refFromFirst.length && simFromFirst.every((r, i) => r[0] === refFromFirst[i][0]);
  const firstDiff = simFromFirst.findIndex((r, i) => !refFromFirst[i] || r[0] !== refFromFirst[i][0]);
  check(`INTROU: the ${refFromFirst.length} successive screens (captions, the four close-ups with their palette fades, the title and its twinkling stars, LOADING) are identical to the DOSBox video, hash for hash`, hashesEqual, hashesEqual ? `${simFromFirst.length} screens` : `first difference at screen ${firstDiff}`);
  const maxDev = Math.max(...simFromFirst.map((r, i) => Math.abs(r[1] - refFromFirst[i][1])));
  const simTotal = simFromFirst.reduce((n, r) => n + r[1], 0), refTotal = refFromFirst.reduce((n, r) => n + r[1], 0);
  check('INTROU timing: every screen is held for the same number of vsyncs as video frames to within 3 (the capture runs about 0.3% longer than 70.09 Hz vsyncs), and the whole sequence from the first screen lasts 3954 ticks (the video: 3968 frames)', maxDev <= 3 && Math.abs(simTotal - refTotal) <= Math.ceil(refTotal * 0.005) + 1 && simTotal === 3954, `max ${maxDev}, ${simTotal} ticks vs ${refTotal} frames`);
  check('INTROU consumes all 41 script words of the Beeper table in order and leaves with exit code 2 (pockets.exe then starts game.exe)', sim.consumed === 41 && sim.exitCode === 2);
  note('INTROU load time before the first screen', `${cap.intro.blackBeforeFirstScreen} black video frames after the KLOGO fade-out = 448 ticks of the first script wait + about ${cap.intro.blackBeforeFirstScreen - 448} for loading the six pictures and depacking (disk time; a stand-in in the page)`);
  // the abort path (a bound key pressed during a wait, CS:0F83): [STATIC], not captured
  const sk = IN.createIntro({ exe: exeI, pics }, { driver: 'B' });
  let n = 0; while (n < 700) { IN.step(sk, { key: n > 600 }); n++; if (sk.done) break; }
  let m2 = 0; while (!sk.done && m2 < 2000) { IN.step(sk, { key: false }); m2++; }
  note('INTROU abort (any bound key during a wait)', `[STATIC] CS:0F83 clears, draws LOADING, fades it in and waits the first script word (80 ticks), then exits with code 3; the model leaves after ${m2} more ticks with code ${sk.exitCode}`);
  return results;
}

/** Decode cue `id` of an adlib.pin-style bank (data/player.pin `1348`/`130F`): 'c' (0x63) / 'C' (0x43) cues are a 256-word digram dictionary plus one index byte per output pair. */
function decodeCue(bank, id) {
  const dv = new DataView(bank.buffer, bank.byteOffset, bank.byteLength);
  const o = dv.getUint32(2 + 4 * id, true), flag = bank[o];
  if (flag !== 0x63 && flag !== 0x43) return { flag, smf: bank.subarray(o) };
  const out = new Uint8Array(Math.min(bank.length - o - 0x201, 4000) * 2);
  for (let i = 0; i < out.length; i++) { const w = dv.getUint16(o + 1 + 2 * bank[o + 0x201 + (i >> 1)], true); out[i] = (i & 1) ? w >> 8 : w & 255; }
  return { flag, smf: out.subarray(flag === 0x63 ? 1 : 0) };
}

/**
 * The AdLib sound driver (data/player.pin + data/adlib.pin; docs/formats/pin-sound.md). The strong claim: the original
 * driver code, run in web/audio/x86-lite.js and driven by the commands and tick count of a
 * DOSBox-X capture (tools/adlib-capture/chain.trace.gz: INIT, every one of the 82 cues, plus the commands the game issues
 * itself during the attract demo), writes the same OPL2 registers in the same order as the real driver did.
 */
export async function checkAdlibDriver(ctx) {
  const { results, check, note } = makeChecker();
  const player = (await unpackData(ctx, 'player.pin')).r.data;
  const bank = (await unpackData(ctx, 'adlib.pin')).r.data;
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  const dv = new DataView(bank.buffer, bank.byteOffset, bank.byteLength);
  // ---- the bank
  const count = dv.getUint16(0, true);
  const kinds = { smf: [], packed: [] };
  for (let i = 0; i < count; i++) {
    const o = dv.getUint32(2 + 4 * i, true);
    if (String.fromCharCode(...bank.subarray(o, o + 4)) === 'MThd') kinds.smf.push(i); else if (bank[o] === 0x63 || bank[o] === 0x43) kinds.packed.push(i);
  }
  check('adlib.pin is an 82-entry cue table', count === 82);
  check('78 cues are plain SMFs and exactly ids 11, 52, 59, 69 start with the compression flag 0x63/0x43', kinds.smf.length === 78 && kinds.packed.join() === '11,52,59,69', `${kinds.smf.length} SMF, packed ${kinds.packed}`);
  const packed = kinds.packed.map((i) => decodeCue(bank, i));
  const mthd = (a) => String.fromCharCode(...a.smf.subarray(0, 4));
  check('digram decoding turns each of the four packed cues into an SMF (MThd at byte 1 for the 0x63 flag, byte 0 for 0x43)', packed.every((c) => mthd(c) === 'MThd') && packed.map((c) => c.flag).join() === '99,99,99,67', packed.map((c) => c.flag).join());
  // ---- the timing constants
  const c16 = (o) => exe[CODE_FILE_OFFSET + o] | (exe[CODE_FILE_OFFSET + o + 1] << 8);
  check('GAMEU reloads PIT channel 0 with 0x5CEC at 1000:204B-2051 (mov al,0xEC / mov al,0x5C after out 0x43,0x36)', exe[CODE_FILE_OFFSET + 0x2047] === 0xb0 && exe[CODE_FILE_OFFSET + 0x2048] === 0x36 && exe[CODE_FILE_OFFSET + 0x204c] === 0xec && exe[CODE_FILE_OFFSET + 0x2050] === 0x5c);
  check('the timer ISR (1000:2132) adds 0x5CEC to its 16-bit accumulator and chains the BIOS tick on carry, so the driver tick rate is 1193181.8 / 0x5CEC = 50.159 Hz', c16(0x2137) === 0x5cec && Math.abs(TICK_HZ - 50.159) < 0.001, TICK_HZ.toFixed(4));
  check('the driver counts delays in units of 0x5D38 PIT counts (= 20 ms, i.e. it assumes 50.000 Hz) at player.pin:0D22', player[0xd22] === 0xb9 && (player[0xd23] | (player[0xd24] << 8)) === 0x5d38);
  // ---- the DOSBox capture
  let text = null;
  try {
    const raw = await ctx.fetchRaw('tools/adlib-capture/chain.trace.gz');
    text = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } catch { /* absent */ }
  if (!text) { note('AdLib capture not found', 'tools/adlib-capture/chain.trace.gz is missing; the register-stream comparison was skipped'); return results; }
  const tokens = parseTrace(text);
  const r = replay(tokens, player, bank);
  check('replaying the DOSBox capture through the original driver code reproduces every one of its 21678 stream tokens (INIT, 82 cues, the demo\'s own commands, 5080 ticks)', r.first === -1 && r.n === 21678, `${r.n} tokens, first mismatch ${r.first}`);
  const ticks = r.dos.filter((t) => t === 'T').length;
  const writes = r.dos.filter((t) => /^[0-9a-f]{4}$/.test(t)).length;
  check('the capture holds 5080 driver ticks and 16431 register writes', ticks === 5080 && writes === 16431, `${ticks} ticks, ${writes} writes`);
  const played = new Set(r.plays);
  check('the capture plays all 82 cues (0-81)', played.size === 82 && [...played].every((id) => id >= 0 && id <= 81));
  // ---- driver state really is carried between commands (the reason the capture starts at a fresh INIT)
  const regs = (pre) => { const w = []; const d = new PinDriver(player, bank, (a, b) => w.push(a, b)); d.init(); if (pre) { d.play(16); for (let i = 0; i < 40; i++) d.tick(); } w.length = 0; d.play(12); for (let i = 0; i < 3; i++) d.tick(); return w.join(); };
  check('the registers written for a cue depend on what played before it (driver state persists between cues)', regs(false) !== regs(true));
  // ---- the engine's sound requests against the commands the real game issued during the attract demo
  const game = []; // game-originated commands in the capture: everything that is not the capture script's own cue sequence
  { let next = 0, tick = 0;
    for (let j = 0; j < tokens.length; j++) {
      const hi = tokens[j].w >> 8, lo = tokens[j].w & 255;
      if (hi === 0xfe) { const slot = tokens[j + 1].w & 255; if (lo === next && slot === next % 8) { next++; continue; } tick = tokens[j].tick; if (tick >= 3700) game.push(`P${lo}`); }
      else if (hi === 0xfd && tokens[j].tick >= 3700) game.push(`S${lo}`);
      else if (hi === 0xfc && tokens[j].tick >= 3700) game.push('SA');
    } }
  let eng = [];
  try {
    const cap = await loadGzJson(ctx, 'tools/attract-capture/entities-full.capture.json.gz');
    const rows = expandRows(cap.rows);
    const env = prepare(exe, await ctx.fetchRaw('data/autoplay.pin'), await ctx.fetchRaw('data/pcmap.pap'));
    let m = loadRow(env, rows[0]);
    const key = (mm) => (mm.u16(0x8ba6) << 8 | mm.u8(0x8ba8)) & 0xffffff;
    const lim = 600; // iterations are enough to cover the capture window
    let iter = 0;
    for (let k = 0; k < rows.length - 1 && iter < lim; k++) {
      const want = (0x8200 + 2 * rows[k + 1].rec) << 8 | rows[k + 1].rem;
      let buf = [];
      const c = { unported: new Set(), events: [], sound: (id, kind) => buf.push(kind === 'stop' ? `S${id}` : kind === 'stopAll' ? 'SA' : `P${id}`) };
      stepIteration(m, c, null); iter++; eng.push(...buf);
      for (let extra = 0; extra < 400 && key(m) === want; extra++) { const next = m.clone(); buf = []; stepIteration(next, c, null); if (key(next) !== want) break; iter++; eng.push(...buf); m = next; }
    }
  } catch (e) { eng = []; note('attract-demo sound comparison error', String(e && e.stack || e)); }
  if (eng.length) {
    const n = game.length;
    check('the ported engine\'s sound requests (ctx.sound) during the attract demo equal, command for command, the 68 the real driver received in the captured demo window', n === 68 && eng.slice(0, n).join(' ') === game.join(' '), `${n} captured, first engine/capture mismatch at ${eng.findIndex((e, i) => i < n && e !== game[i])}`);
  } else note('attract-demo capture not found', 'the engine-vs-capture sound-request comparison was skipped');
  return results;
}

export async function runAllChecks(ctx) {
  const groups = [checkRncCorpus, checkPap, checkCollisionTable, checkPalettes, checkSoundBanks, checkLevelScripts, checkDemoTape, checkFrameOrder, checkCaptureRng, checkSprites, checkSpriteWorlds, checkDataCensus, checkDescriptors, checkLevelCensus, checkCodeEntry, checkFrontend, checkPrelude, checkConformance, checkAdlibDriver];
  const results = [];
  for (const g of groups) results.push(...await g(ctx));
  return { results };
}
