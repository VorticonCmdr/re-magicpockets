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
import { GROUND_TABLE } from '../core/tile-collision.js';
import { RAW_BANKS } from '../core/palette.js';

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

/** The ground-collision table the port transcribed must appear byte-for-byte in GAMEU.EXE. */
export async function checkCollisionTable(ctx) {
  const { results, check, note } = makeChecker();
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  check('GAMEU.EXE is 450130 bytes (the unpacked game)', exe.length === 450130, `got ${exe.length}`);
  check('port ground table is 256 entries', GROUND_TABLE.length === 256);
  const at = indexOfBytes(exe, GROUND_TABLE);
  check('port ground table appears in GAMEU.EXE exactly once', at !== -1 && countOfBytes(exe, GROUND_TABLE) === 1, `file offset ${at}`);
  check('ground table sits at GAMEU.EXE file offset 447225', at === 447225, `got ${at}`);
  let badValues = 0;
  for (let v = 1; v <= 120; v++) if (![0, 1, 16].includes(exe[447225 + v])) badValues++;
  check('EXE table entries 1..120 are only 0 (passable), 1 (solid) or 16 (special)', badValues === 0, `${badValues} other values`);
  note('UNKNOWN_alt_ground_table_extent',
    'docs say a second table sits at 6de3:f27b, but 0xf27b is only 0xf2 bytes past the default table at 0xf189, '
    + 'so a 256-byte read overlaps it; the "near-identical, 16 replaced by 0" claim does not hold at that offset');
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

/** autoplay.pin: leading evidence only — the format is NOT decoded yet. */
export async function checkDemoTape(ctx) {
  const { results, check, note } = makeChecker();
  const { r } = await unpackData(ctx, 'autoplay.pin');
  check('autoplay.pin unpacks to exactly 2000 bytes', r.data.length === 2000, `got ${r.data.length}`);
  const exe = await ctx.fetchRaw('game/GAMEU.EXE');
  const name = new TextEncoder().encode('autoplay.pin');
  check('GAMEU.EXE references the filename "autoplay.pin"', indexOfBytes(exe, name) !== -1);
  let pairs = 0, sum = 0;
  for (let i = 0; i + 1 < r.data.length; i += 2) {
    if (r.data[i] === 0 && r.data[i + 1] === 0) break;
    sum += r.data[i]; pairs++;
  }
  note('UNKNOWN_autoplay_format',
    `${pairs} (count,state) pairs before the first 00 00, counts sum to ${sum}; role as the attract-demo tape is a hypothesis`);
  return results;
}

export async function runAllChecks(ctx) {
  const groups = [checkRncCorpus, checkPap, checkCollisionTable, checkPalettes, checkSoundBanks, checkLevelScripts, checkDemoTape];
  const results = [];
  for (const g of groups) results.push(...await g(ctx));
  return { results };
}
