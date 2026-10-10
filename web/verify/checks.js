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
import { RAW_BANKS } from '../core/palette.js';
import { decodeDemoTape, DemoPlayback, INPUT_BITS, DEMO_RNG_SEED } from '../core/demo-tape.js';
import { FRAME_ORDER, DEFAULT_TICK_HZ } from '../engine/frame.js';
import { stepIterationAfterRng } from '../engine/iteration.js';
import { Rng } from '../engine/rng.js';
import { prepare, runConformance, runFreeRun, runLiveConformance, runLiveFree, bootFromFiles, diffBootEntities, expandRows, midConsumeParticles, loadRow } from './conformance-lib.js';
import { mapFixups } from '../engine/boot.js';

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
    for (const [file, segs, world = 4, pinHurt = false, noGod = false] of [
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
      ['live20-w1c', [[5, 52, 726, 600], [3, 740, 1414, 650], [4, 1427, 2011, 570]], 1, false], // sub-level 5 from a clean warp: the side handler's DI carries over to the ceiling handler
    ]) {
      let cap = null;
      try { cap = await loadGzJson(ctx, `tools/attract-capture/${file}.capture.json.gz`); } catch { /* absent */ }
      if (!cap) continue;
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
        return runLiveFree(e, cap.rows, { start, from, to, entitiesOnly: true, checkRng: true, force: noGod ? [] : [[0x8b96, 50]], pinHurtTimer: pinHurt, levelFiles: () => ({ script, map: e.map }) });
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

export async function runAllChecks(ctx) {
  const groups = [checkRncCorpus, checkPap, checkCollisionTable, checkPalettes, checkSoundBanks, checkLevelScripts, checkDemoTape, checkFrameOrder, checkCaptureRng, checkConformance];
  const results = [];
  for (const g of groups) results.push(...await g(ctx));
  return { results };
}
