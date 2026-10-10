// `demo.html?game`: the playable page driven through the game's own flow instead of booting a level directly.
//
//   [?intro: the launcher's chain first: KLOGOPOU.EXE's Konami/Renegade screen (web/engine/klogo.js, 50 Hz timer) -> INTROU.EXE's captions,
//   close-ups and MAGIC POCKETS title (web/engine/intro.js, 70 Hz; any movement key leaves it)]
//   fresh start -> world 1 intro screen (web/engine/frontend.js, 70 Hz) -> world 1 sub-level 1 (16.7 Hz main loop)
//   -> opcode 37 (next sub-level: map and script chosen by the 03FF dispatch) -> past the last sub-level of a world: the next
//   world's intro screen -> ... -> world 4 sub-level 10: the ending picture (the ending sequence itself is not ported).
//   GAME OVER / CONTINUE? are in-loop (opcode 52): accepting with no continues left restarts at world 1 through the intro;
//   letting CONTINUE? time out starts the attract demo (also through the intro, like B51E with world 0), and the demo's end
//   (where the original exits to DOS) starts a new game.
//
// What is a stand-in here (docs/open-questions-history.md "front end"): the disk-load pause between the intro's fade-in and its blink
// (`?hold=N` ticks, default 0), the same for INTROU's loading before its first screen (`?load=N`, default 165 ticks = the 613 black video frames
// minus its 448-tick first wait), the ending screen's palette (world 4's, [STATIC]) and missing ending sequence. The KLOGOPOU.EXE and
// INTROU.EXE screens are `[PROVEN]` against DOSBox video (npm run verify, group checkPrelude); both programs are fetched from /game/ and `?intro`
// falls back to the world intro when they are absent.

'use strict';

import { WORLD_PALETTES } from '../core/palette.js';
import { decodePak } from '../core/pak.js';
import { decodePap } from '../core/pap.js';
import { rncUnpack } from '../core/rnc.js';
import { buildBackgroundCanvas } from '../render/canvas.js';
import { prepare, bootFromFiles } from '../verify/conformance-lib.js';
import { startLevel, startWorld } from '../engine/boot.js';
import { stepIteration } from '../engine/iteration.js';
import { INPUT_BITS } from '../core/demo-tape.js';
import { findByClass } from '../engine/ds-memory.js';
import { VSYNC_HZ, DEFAULT_TICK_HZ } from '../engine/frame.js';
import { buildSpriteAtlas, drawEntities, BANKS } from '../render/sprites.js';
import { levelFilesFor, LEVEL_FILES } from '../engine/level-registry.js';
import * as FE from '../engine/frontend.js';
import * as KL from '../engine/klogo.js';
import * as IN from '../engine/intro.js';

const VIEW_W = 320, VIEW_H = 192;

// Scancodes the keyboard ISR would put in [8B60] (docs/open-questions-history.md item on opcode 38; table at DS:EDB4).
const SCANCODES = { Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11, Enter: 0x1c, Backspace: 0x0e, Delete: 0x53, ArrowUp: 0x48, ArrowDown: 0x50, ArrowLeft: 0x4b, ArrowRight: 0x4d };
const KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'fire', ControlLeft: 'fire', KeyZ: 'fire' };

export async function startGame({ exe, fetchBytes, canvas, setStatus, params: givenParams }) {
  const ctx2d = canvas.getContext('2d');
  const params = givenParams || new URLSearchParams(location.search); // index.html passes its own (intro and sound on by default)
  const hold = +(params.get('hold') || 0);
  const loadTicks = +(params.get('load') || 165);
  const timing = FE.introTiming(exe);
  // ?intro: KLOGOPOU.EXE and INTROU.EXE (the launcher's first two programs) with the six intro pictures
  let prelude = null;
  if (params.has('intro')) {
    try {
      const [exeK, exeI] = await Promise.all([fetchBytes('/game/KLOGOPOU.EXE'), fetchBytes('/game/INTROU.EXE')]);
      const pics = [];
      for (let n = 0; n < 6; n++) pics.push(IN.decodePip200(rncUnpack(await fetchBytes(`/data/intro${n}.pip`)).data));
      prelude = { logo: KL.loadLogo(exeK), intro: { exe: exeI, pics } };
    } catch (err) { setStatus(`?intro: KLOGOPOU.EXE / INTROU.EXE / intro*.pip not available (${err.message}); starting at the world intro`); }
  }

  // ---- assets: everything the flow can reach is fetched up front (the files are small) ----
  const raw = new Map();
  const get = async (name) => { if (!raw.has(name)) raw.set(name, rncUnpack(await fetchBytes(`/data/${name}`)).data); return raw.get(name); };
  const names = new Set(['new.pip', 'endscrn.pip', 'level0.pin', 'pcmap.pap']);
  for (const f of Object.values(LEVEL_FILES)) { names.add(f.pin); names.add(f.pap); }
  for (let w = 1; w <= 4; w++) { names.add(`blocks${w}.pak`); for (const b of Object.values(BANKS)) for (const f of b.files) names.add(f.replace('%', w)); }
  setStatus('loading the game files...');
  await Promise.all([...names].map(get));
  const pic = FE.decodePictureIndices(await get('new.pip'));
  const endPic = FE.decodePictureIndices(await get('endscrn.pip'));
  const colMap = (name) => { // the row-major .pap as the column-major map at DS:0x4200 (conformance-lib prepare)
    const grid = raw.get(name), map = new Uint8Array(128 * 128);
    for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) map[c * 128 + r] = grid[r * 128 + c];
    return map;
  };
  const env0 = prepare(exe, await fetchBytes('/data/autoplay.pin'), await fetchBytes('/data/pcmap.pap'));

  const bgCache = new Map(), atlasCache = new Map();
  const palOf = (w) => WORLD_PALETTES[`world${w}`];
  const backgroundFor = (world, mapName) => {
    const k = `${world}:${mapName}`;
    if (!bgCache.has(k)) bgCache.set(k, buildBackgroundCanvas(decodePak(`blocks${world}.pak`, raw.get(`blocks${world}.pak`), palOf(world)), decodePap(raw.get(mapName))));
    return bgCache.get(k);
  };
  const atlasFor = (world) => {
    if (!atlasCache.has(world)) {
      const spriteRaw = {};
      for (const b of Object.values(BANKS)) for (const f of b.files) { const n = f.replace('%', world); spriteRaw[n] = raw.get(n); }
      atlasCache.set(world, buildSpriteAtlas(spriteRaw, world, palOf(world), (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })));
    }
    return atlasCache.get(world);
  };

  // ---- the flow ----
  const g = {
    mode: prelude ? 'logo' : 'intro', fs: FE.newGame({ hold }), logo: prelude ? KL.createLogo(prelude.logo, { seconds: 5 }) : null, pre: null, loadLeft: 0, dac: null, m: null, sim: { unported: new Set(), events: [] }, world: 1, map: 'pcmap.pap', ticks: 0, iterations: 0,
    note: '', demo: false, drawn: null,
  };
  // ?sound: AdLib sound (web/demo/sound.js). The main loop's sound requests reach g.sim.sound; absent = silent, engine behaviour unchanged.
  if (params.has('sound')) { try { await (await import('./sound.js')).enableSound(g.sim, fetchBytes); setStatus('sound on: press a key or click once to start audio'); } catch (err) { setStatus(`?sound: ${err.message}`); } }
  const held = new Set();
  const down = new Set(); // every key currently down (KLOGOPOU ends its hold on any key)
  let scan = 0;
  addEventListener('keydown', (e) => {
    down.add(e.code);
    if (KEYS[e.code]) { held.add(KEYS[e.code]); e.preventDefault(); }
    if (SCANCODES[e.code]) { scan = SCANCODES[e.code]; if (e.code.startsWith('Arrow') || e.code === 'Enter') e.preventDefault(); }
    if (g.mode === 'ending' && (e.code === 'Enter' || e.code === 'Space')) toIntro({ world: 1, reason: 'newGame' });
  });
  addEventListener('keyup', (e) => { down.delete(e.code); if (KEYS[e.code]) held.delete(KEYS[e.code]); });
  const keyState = () => [...held].reduce((v, k) => v | INPUT_BITS[k], 0);

  /** The page flip's pan comes from the scroll remainder [8B69] of whatever was on screen before (`[PROVEN]` for the stale-value case). */
  const stalePan = () => (g.m ? FE.panFromScroll(g.m.u16(0x8b69)) : 0);
  function toIntro(o) { g.fs = FE.startWorldIntro({ ...o, hold, panX: stalePan() }); g.mode = 'intro'; g.drawn = null; }

  function afterIntro(boot) {
    if (boot.reason === 'newGame' || boot.reason === 'demo') {
      const demo = boot.reason === 'demo';
      const files = demo ? { pin: 'level0.pin', pap: 'pcmap.pap' } : levelFilesFor(1, 1);
      const e = { ...env0, map: colMap(files.pap) };
      g.m = bootFromFiles(e, raw.get(files.pin), demo ? {} : { world: 1, sub: 1, demo: false }).m;
      g.world = 1; g.map = files.pap; g.demo = demo;
    } else { // the next world of a running game
      const files = levelFilesFor(boot.world, 1);
      g.m.put(0x4200, colMap(files.pap)); g.m.put(0, raw.get(files.pin));
      g.sim.levelStart = null;
      startWorld(g.m, g.sim, { world: boot.world, sub: 1, hardMode: boot.hardMode });
      g.world = boot.world; g.map = files.pap;
    }
    g.sim.unported.clear(); g.mode = 'play'; g.iterations = 0;
  }

  function onLevelStart(next) { // opcode 37 (31F5): 03FF's dispatch, or 00CA when the map stays
    if (next.sameMap) { startLevel(g.m, g.sim, next); return; }
    const d = FE.levelDispatch(exe, next.world, next.sub);
    if (d.kind === 'nextWorld') { toIntro({ world: d.world, sub: 1, reason: 'world', hardMode: d.hardMode }); return; }
    if (d.kind === 'ending') { g.mode = 'ending'; g.note = 'ending (the ending sequence is not ported)'; return; }
    if (d.kind === 'map') { g.m.put(0x4200, colMap(d.map)); if (d.script) g.m.put(0, raw.get(d.script)); g.map = d.map; }
    startLevel(g.m, g.sim, next);
  }

  function playTick() {
    const m = g.m;
    if (!g.demo) { m.w8(0x8b5d, keyState()); m.w8(0x8b58, keyState()); if (scan && m.u8(0x8c33) !== 0) { m.w8(0x8b60, scan); } scan = 0; }
    stepIteration(m, g.sim, null); g.iterations++;
    if (g.sim.levelStart) { const next = g.sim.levelStart; g.sim.levelStart = null; onLevelStart(next); return; }
    if (g.sim.gameRestart) { const why = g.sim.gameRestart; g.sim.gameRestart = null; toIntro({ world: 1, reason: why === 'demo' ? 'demo' : 'newGame' }); return; }
    // the attract demo's tape ends: the original leaves through 1000:5267 (to DOS); here a new game starts
    if (g.demo && m.u8(0x8ba8) === 1 && m.u16(m.u16(0x8ba6) + 2) === 0xffff) toIntro({ world: 1, reason: 'newGame' });
  }

  function afterLogo() { g.mode = 'loading'; g.loadLeft = loadTicks; g.pre = IN.createIntro(prelude.intro, { driver: 'B' }); }
  function afterPrelude() { g.mode = 'intro'; g.fs = FE.newGame({ hold }); g.drawn = null; }

  function tick() {
    g.ticks++;
    if (g.mode === 'logo') {
      const out = KL.step(g.logo, { key: down.size > 0 });
      if (out.done) afterLogo(); else g.dac = out.draw.dac;
    } else if (g.mode === 'loading') {
      if (--g.loadLeft <= 0) g.mode = 'prelude';
    } else if (g.mode === 'prelude') {
      const out = IN.step(g.pre, { key: held.size > 0 });
      if (out.done) afterPrelude();
    } else if (g.mode === 'intro') {
      const out = FE.step(g.fs, timing);
      if (out.draw) g.drawn = out.draw;
      if (out.boot) afterIntro(out.boot);
    } else if (g.mode === 'play') playTick();
  }

  // ---- drawing ----
  const img = ctx2d.createImageData(VIEW_W, VIEW_H);
  const introCache = new Map();
  function paint(indices, pal) {
    const d = img.data;
    for (let i = 0; i < VIEW_W * VIEW_H; i++) { const c = pal[indices[i]]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
    ctx2d.putImageData(img, 0, 0);
  }
  function drawIntro() {
    const dr = g.drawn;
    if (!dr) { ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, VIEW_W, VIEW_H); return; }
    const k = `${dr.world}:${dr.arrow}:${dr.box}:${dr.panX}`;
    if (!introCache.has(k)) introCache.set(k, FE.composeIntro(pic, FE.introBlits(FE.readRects(exe), dr.world), dr, dr.panX));
    paint(introCache.get(k), FE.bankPalette(exe, dr.bank));
  }
  function drawPlay() {
    const m = g.m;
    const world = findByClass(m, 1);
    const ox = m.s16(world + 6), oy = m.s16(world + 8);
    ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx2d.drawImage(backgroundFor(g.world, g.map), ox, oy);
    drawEntities(ctx2d, m, atlasFor(g.world));
  }
  const setHeight = (h) => { if (canvas.height !== h) canvas.height = h; };
  let preImg = null;
  function draw() {
    if (g.mode === 'logo' || g.mode === 'loading' || g.mode === 'prelude') {
      setHeight(200);
      if (!preImg || preImg.height !== 200) preImg = ctx2d.createImageData(320, 200);
      let indices = null, pal = null, label = '';
      if (g.mode === 'logo') {
        indices = prelude.logo.pixels; pal = g.dac ? KL.toRgb(g.dac) : null;
        label = `KLOGOPOU.EXE (Konami / Renegade): tick ${g.logo.t} of ${64 + g.logo.hold}, 50.02 Hz timer; any key skips the hold`;
      } else if (g.mode === 'prelude') {
        const f = IN.frameOf(g.pre); indices = f.indices; pal = f.palette;
        label = `INTROU.EXE: tick ${g.pre.t}, script words ${g.pre.consumed}, palette bank 0x${g.pre.bank.toString(16)}; a movement key leaves`;
      } else label = 'loading INTROU.EXE (disk time stand-in, ?load=N)';
      const d = preImg.data;
      for (let i = 0; i < 64000; i++) { const c = pal ? pal[indices[i]] : [0, 0, 0]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
      ctx2d.putImageData(preImg, 0, 0);
      setStatus(label);
      return;
    }
    setHeight(VIEW_H);
    if (g.mode === 'intro') {
      drawIntro();
      const dr = g.drawn;
      setStatus(`world ${g.fs.world} intro: ${dr ? dr.phase : 'start'}, palette bank 0x${dr ? dr.bank.toString(16) : '--'}, tick ${g.fs.t}  (${g.fs.reason}; the original reads no key here)`);
    } else if (g.mode === 'ending') {
      paint(endPic.slice(0, VIEW_W * VIEW_H), WORLD_PALETTES.world4); // 06E3 sets no palette: the screen inherits world 4's (`[STATIC]`, docs/open-questions-history.md 26)
      setStatus(`${g.note}: Enter starts a new game`);
    } else {
      drawPlay();
      const m = g.m;
      setStatus(`${g.demo ? 'attract demo' : 'playing'}: world ${m.u16(0x8b89)} sub-level ${m.u16(0x8b8b)}  iteration ${g.iterations}  score ${m.u16(0x8b75)}  unported: ${[...g.sim.unported].join(', ') || 'none'}`);
    }
  }

  // ---- the loop: the intro runs at the vsync rate, the main loop at its own 16.7 Hz ----
  let last = performance.now(), acc = 0, running = true;
  const frame = (now) => {
    if (!running) return;
    acc += Math.min(now - last, 250); last = now;
    for (;;) {
      const ms = 1000 / (g.mode === 'logo' ? KL.KLOGO_HZ : (g.mode === 'intro' || g.mode === 'prelude' || g.mode === 'loading') ? VSYNC_HZ : DEFAULT_TICK_HZ);
      if (acc < ms) break;
      acc -= ms; tick();
    }
    draw();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__mpGame = { g, tick, draw, FE, stop: () => { running = false; } };
}
