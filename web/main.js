// Phase 4 checkpoint: the movement-AI bytecode VM. Every spawned level-script entity whose type
// matches a CONFIRMED EXACT entry in docs/enemies.md's world-1 Entity_DispatchUpdateByKind table
// (0x12 gate, 0x13/0x14/0x20/0x23/0x2c patrol/charging-hazard) now moves under real AI logic --
// tile-lookahead patrol, turn-around, and chase-the-player -- instead of sitting idle. See
// docs/port-plan.md Phase 4 and web/engine/{movement-ai-vm,entity-ai}.js for what's a faithful
// structural port (the opcode table + dispatch shape) vs. a labeled placeholder (exact per-type
// animation-set/range/speed tuning, which isn't dumped anywhere upstream).
//
// The general 78-opcode Entity_RunScript VM (docs/entity-script-vm.md) is NOT wired to real game
// content this phase -- its default-script tables (0xcd88/0xd996) and the actual per-entity script
// bytecode they point at live in the data segment and haven't been dumped, so there's no real
// script content to run yet. web/engine/entity-script-vm.js implements the VM loop structure
// (opcode dispatch, CALL/RETURN, yield/wait semantics) against a small synthetic test script
// instead, proving the interpreter mechanics work -- see its own header for detail.

'use strict';

import { sourceFromFileList, sourceFromFetch } from './loader/asset-source.js';
import { AssetCache } from './loader/asset-cache.js';
import { WORLD_PALETTES } from './core/palette.js';
import { buildLevelScene, drawCollisionOverlay, loadSpritePaks, drawEntitiesLive } from './render/canvas.js';
import { Camera, TILE_WIDTH, TILE_HEIGHT } from './engine/camera.js';
import { Input } from './engine/input.js';
import { MainLoop } from './engine/loop.js';
import { EntityPool } from './engine/entity-pool.js';
import { Player } from './engine/player.js';
import { buildPlaceholderCollisionGrid } from './engine/placeholder-terrain.js';
import { attachAiIfKnown, tickAllAi, GATE_TYPES } from './engine/entity-ai.js';

// Per docs/formats/pin-level-script.md, world 1's level-script file is oddly named new1.pin.
const LEVEL = { pap: 'level1a.pap', pak: 'blocks1.pak', pin: 'new1.pin', palette: 'world1', world: 1 };
const SHAPES_URL = '/symbols/entity-shapes.json';
const VIEWPORT_W = 320;
const VIEWPORT_H = 192;
const EXTRA_SPRITE_FILES = ['bitkid.pak', 'kidx1.pak', 'special1.pak', 'extras.pak', 'extrax1.pak', 'nasty1.pak'];

const statusEl = document.getElementById('status');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const picker = document.getElementById('picker');
const devServerBtn = document.getElementById('dev-server');

canvas.width = VIEWPORT_W;
canvas.height = VIEWPORT_H;
ctx.imageSmoothingEnabled = false;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

function loadEntityShapes() {
  return fetch(SHAPES_URL).then((res) => {
    if (!res.ok) throw new Error(`fetch ${SHAPES_URL} failed: ${res.status}`);
    return res.json();
  });
}

let activeLoop = null;
let activeInput = null;

async function run(cache) {
  const required = [LEVEL.pak, LEVEL.pap, LEVEL.pin];
  for (const f of required) {
    if (!cache.has(f)) {
      setStatus(`missing required file: ${f} (looked for it, case-insensitive, among the picked files)`, true);
      return;
    }
  }

  if (activeLoop) activeLoop.stop();
  if (activeInput) activeInput.dispose();

  try {
    setStatus(`depacking + decoding ${LEVEL.pak}, ${LEVEL.pap}, ${LEVEL.pin}...`);
    const level = { ...LEVEL, paletteColors: WORLD_PALETTES[LEVEL.palette] };
    const entityShapes = await loadEntityShapes();
    const scene = await buildLevelScene(cache, level);
    const spritePaks = await loadSpritePaks(cache, entityShapes, LEVEL.world, level.paletteColors);

    // Spawn every on-map level-script entity into the pool (capped at MAX_ENTITIES); attach real
    // AI to the ones whose type matches a confirmed world-1 dispatch entry (see module header).
    const pool = new EntityPool();
    let spawned = 0;
    let skippedFull = 0;
    let gateCount = 0;
    let aiCount = 0;
    for (const e of scene.levelScript.entities) {
      if (e.x === undefined || e.y === undefined) continue;
      if (e.x < 0 || e.x > scene.widthPx || e.y < 0 || e.y > scene.heightPx) continue;
      const slot = pool.spawnFromLevelScriptRecord(e);
      if (slot === -1) {
        skippedFull++;
        continue;
      }
      spawned++;
      const entity = pool.slots[slot];
      if (attachAiIfKnown(entity)) {
        if (GATE_TYPES.has(entity.type)) gateCount++;
        else aiCount++;
      }
    }

    // Ground collision (and, here, the movement-AI's tile-lookahead) uses a small hand-authored
    // placeholder surface, NOT the real .pap tile grid -- see placeholder-terrain.js for why.
    const collisionGrid = buildPlaceholderCollisionGrid();
    const player = new Player(0, 0);
    player.x = collisionGrid.spawnCol * TILE_WIDTH;
    player.y = collisionGrid.spawnRow * TILE_HEIGHT - player.h;

    const camera = new Camera({
      levelWidthPx: scene.widthPx,
      levelHeightPx: scene.heightPx,
      viewportWidthPx: VIEWPORT_W,
      viewportHeightPx: VIEWPORT_H,
    });
    camera.centerOn(player.x, player.y);
    const input = new Input(window);
    activeInput = input;

    const loop = new MainLoop({
      entityUpdateAll: () => {
        player.update(input, collisionGrid);
        tickAllAi(pool.live, player, collisionGrid, loop.rng);
      },
      cameraUpdateScroll: () => camera.centerOn(player.x + player.w / 2, player.y + player.h / 2),
      videoFlipAndScroll: () => {
        ctx.clearRect(0, 0, VIEWPORT_W, VIEWPORT_H);
        ctx.drawImage(
          scene.canvas,
          camera.x, camera.y, VIEWPORT_W, VIEWPORT_H,
          0, 0, VIEWPORT_W, VIEWPORT_H
        );
        drawCollisionOverlay(ctx, collisionGrid, camera, VIEWPORT_W, VIEWPORT_H);
        drawEntitiesLive(ctx, pool.live, entityShapes, spritePaks, LEVEL.world, camera, VIEWPORT_W, VIEWPORT_H);
        // player placeholder box -- real sprite/animation lands in Phase 5.
        ctx.fillStyle = player.onGround ? '#ffd23f' : '#ff9f1c';
        ctx.fillRect(player.x - camera.x, player.y - camera.y, player.w, player.h);
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeRect(player.x - camera.x, player.y - camera.y, player.w, player.h);
        ctx.beginPath(); // facing indicator
        const eyeX = player.x - camera.x + (player.facing > 0 ? player.w - 4 : 4);
        ctx.arc(eyeX, player.y - camera.y + 6, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
      },
      hudUpdateScoreDisplay: () => {
        const chasing = pool.live.filter((e) => e.ai && (e.ai.state === 'chase' || e.ai.state === 'strike')).length;
        setStatus(
          `${LEVEL.pap} live: frame ${loop.frameCount}, player (${player.x.toFixed(1)}, ` +
            `${player.y.toFixed(1)})px, onGround=${player.onGround}, blocksBroken=${player.brokenCount} ` +
            `-- arrows/WASD move+jump, space/ctrl breaks the block ahead -- ${spawned} level-script ` +
            `entities in the pool (${gateCount} gates, ${aiCount} patrol/hazard AI, ${chasing} ` +
            `currently chasing the player, ${skippedFull} skipped when full).`
        );
      },
    });
    activeLoop = loop;
    loop.start();
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
    throw err;
  }
}

picker.addEventListener('change', () => {
  const source = sourceFromFileList(picker.files);
  run(new AssetCache(source));
});

// Convenience for local dev: assumes `node tools/serve.js` is running and data/ is reachable at
// /data/ (serve.js serves the whole repo root, and data/ exists on disk even though it's
// gitignored -- this path only works for someone who already has the original files locally).
devServerBtn.addEventListener('click', () => {
  const allFiles = [LEVEL.pak, LEVEL.pap, LEVEL.pin, ...EXTRA_SPRITE_FILES];
  const source = sourceFromFetch('/data', allFiles);
  run(new AssetCache(source));
});
