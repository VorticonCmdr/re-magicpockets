// Phase 5 checkpoint: player-specific systems, HUD, bonus economy -- "first fully playable level"
// (docs/port-plan.md). Adds health/damage/respawn (touching a chasing/striking AI entity costs a
// heart; 0 hearts respawns at the start), pickups (collect for score), a level-exit zone, and a
// bonus-item spawn triggered by breaking blocks, using Entity_ChooseAndSpawnBonusItem's REAL
// world-1 decision tree (docs/engine.md) fed approximated inputs -- see
// web/engine/bonus-economy.js for exactly which globals are real vs. proxied. The score/health HUD
// itself is a plain canvas-text placeholder, NOT the original's custom glyph-tile rendering
// (docs/engine.md flags that encoding as needing the actual font/glyph bitmap source, which isn't
// resolved) -- everything it displays (score, hearts, "LEVEL COMPLETE") is real game state, just
// drawn with a system font instead of the real HUD sprite sheet.
//
// Ground collision, the player's landing-response state machine (Entity_ApplyComplexGroundResponse
// depends on several unported subsystems -- boss triggers, checkpoint states -- so isn't ported),
// and which real level-script entities are "pickups" (needs a runtime pairing field this port
// doesn't have, see placeholder-terrain.js) are all still Phase-3/4-era placeholders. This phase's
// job is proving the player-economy LOOP works end to end: break/collect -> score -> bonus spawn,
// take damage -> respawn, reach the exit -> win -- not claiming byte-exact fidelity on any of it.

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
import { chooseWorld1BonusType, spawnBonusItem } from './engine/bonus-economy.js';

// Per docs/formats/pin-level-script.md, world 1's level-script file is oddly named new1.pin.
const LEVEL = { pap: 'level1a.pap', pak: 'blocks1.pak', pin: 'new1.pin', palette: 'world1', world: 1 };
const SHAPES_URL = '/symbols/entity-shapes.json';
const VIEWPORT_W = 320;
const VIEWPORT_H = 192;
const EXTRA_SPRITE_FILES = ['bitkid.pak', 'kidx1.pak', 'special1.pak', 'extras.pak', 'extrax1.pak', 'nasty1.pak'];
const PICKUP_RADIUS = 10;
const ENEMY_HIT_HALF_SIZE = 8;

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

function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
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

    // Spawn every on-map level-script entity into the pool, reserving some headroom (matching how
    // the real 146-slot pool also has to share capacity between static level entities and
    // dynamically-spawned ones, e.g. this phase's bonus items) below MAX_ENTITIES. Attach real AI
    // to the ones whose type matches a confirmed world-1 dispatch entry.
    const pool = new EntityPool();
    const RESERVED_FOR_DYNAMIC_SPAWNS = 16;
    const initialSpawnCap = pool.maxEntities - RESERVED_FOR_DYNAMIC_SPAWNS;
    let spawned = 0;
    let gateCount = 0;
    let aiCount = 0;
    for (const e of scene.levelScript.entities) {
      if (spawned >= initialSpawnCap) break;
      if (e.x === undefined || e.y === undefined) continue;
      if (e.x < 0 || e.x > scene.widthPx || e.y < 0 || e.y > scene.heightPx) continue;
      const slot = pool.spawnFromLevelScriptRecord(e);
      if (slot === -1) continue;
      spawned++;
      const entity = pool.slots[slot];
      if (attachAiIfKnown(entity)) {
        if (GATE_TYPES.has(entity.type)) gateCount++;
        else aiCount++;
      }
    }

    // Ground collision (and the movement-AI's tile-lookahead) uses a small hand-authored
    // placeholder surface, NOT the real .pap tile grid -- see placeholder-terrain.js for why.
    const collisionGrid = buildPlaceholderCollisionGrid();
    const player = new Player(0, 0);
    player.x = player.spawnX = collisionGrid.spawnCol * TILE_WIDTH;
    player.y = player.spawnY = collisionGrid.spawnRow * TILE_HEIGHT - player.h;

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
        if (player.reachedExit) return; // freeze the run once the exit is reached
        player.update(input, collisionGrid);
        tickAllAi(pool.live, player, collisionGrid, loop.rng);

        // Bonus-item spawn, triggered by breaking a block -- see bonus-economy.js for the real
        // decision tree vs. the approximated inputs it's fed.
        if (player.lastBreak) {
          const type = chooseWorld1BonusType({
            blocksBroken: player.brokenCount,
            pickupsCollected: player.pickupsCollected,
            score: player.score,
          });
          spawnBonusItem(pool, type, player.lastBreak.col * TILE_WIDTH, player.lastBreak.row * TILE_HEIGHT - 16);
        }

        // Pickups (placeholder -- see placeholder-terrain.js).
        for (const p of collisionGrid.pickups) {
          if (p.collected) continue;
          if (aabbOverlap(player.x, player.y, player.w, player.h, p.x - PICKUP_RADIUS, p.y - PICKUP_RADIUS, PICKUP_RADIUS * 2, PICKUP_RADIUS * 2)) {
            p.collected = true;
            player.collectPickup(50);
          }
        }

        // Damage: touching a currently-chasing/striking AI entity.
        for (const e of pool.live) {
          if (!e.ai || (e.ai.state !== 'chase' && e.ai.state !== 'strike')) continue;
          if (aabbOverlap(
            player.x, player.y, player.w, player.h,
            e.x - ENEMY_HIT_HALF_SIZE, e.y - ENEMY_HIT_HALF_SIZE, ENEMY_HIT_HALF_SIZE * 2, ENEMY_HIT_HALF_SIZE * 2
          )) {
            player.takeDamage(e.x);
            break; // one hit per frame
          }
        }

        // Exit zone (placeholder -- see placeholder-terrain.js).
        const z = collisionGrid.exitZone;
        if (aabbOverlap(player.x, player.y, player.w, player.h, z.x, z.y, z.w, z.h)) {
          player.reachedExit = true;
        }
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

        // Exit zone marker.
        const z = collisionGrid.exitZone;
        ctx.fillStyle = 'rgba(80, 220, 120, 0.35)';
        ctx.fillRect(z.x - camera.x, z.y - camera.y, z.w, z.h);

        // Pickups.
        for (const p of collisionGrid.pickups) {
          if (p.collected) continue;
          ctx.beginPath();
          ctx.arc(p.x - camera.x, p.y - camera.y, PICKUP_RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = '#ffe066';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.stroke();
        }

        drawEntitiesLive(ctx, pool.live, entityShapes, spritePaks, LEVEL.world, camera, VIEWPORT_W, VIEWPORT_H);

        // player placeholder box -- real sprite/animation is still unbuilt; blinks while invulnerable.
        const blinkHidden = player.invulnFrames > 0 && Math.floor(loop.frameCount / 4) % 2 === 0;
        if (!blinkHidden) {
          ctx.fillStyle = player.onGround ? '#ffd23f' : '#ff9f1c';
          ctx.fillRect(player.x - camera.x, player.y - camera.y, player.w, player.h);
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.strokeRect(player.x - camera.x, player.y - camera.y, player.w, player.h);
          ctx.beginPath(); // facing indicator
          const eyeX = player.x - camera.x + (player.facing > 0 ? player.w - 4 : 4);
          ctx.arc(eyeX, player.y - camera.y + 6, 2, 0, Math.PI * 2);
          ctx.fillStyle = '#000';
          ctx.fill();
        }

        // --- HUD (placeholder canvas text -- see module header) ---
        ctx.save();
        ctx.font = '10px monospace';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        const scoreText = `SCORE ${player.score}`;
        ctx.strokeText(scoreText, 4, 4);
        ctx.fillText(scoreText, 4, 4);
        for (let i = 0; i < player.maxHealth; i++) {
          const hx = VIEWPORT_W - 4 - (i + 1) * 14;
          ctx.fillStyle = i < player.health ? '#ff3b3b' : 'rgba(255,255,255,0.25)';
          ctx.beginPath();
          ctx.arc(hx, 10, 5, 0, Math.PI * 2);
          ctx.fill();
        }
        if (player.reachedExit) {
          ctx.font = 'bold 20px monospace';
          const msg = 'LEVEL COMPLETE';
          const w = ctx.measureText(msg).width;
          ctx.strokeText(msg, (VIEWPORT_W - w) / 2, VIEWPORT_H / 2 - 10);
          ctx.fillStyle = '#7CFC9A';
          ctx.fillText(msg, (VIEWPORT_W - w) / 2, VIEWPORT_H / 2 - 10);
        }
        ctx.restore();
      },
      hudUpdateScoreDisplay: () => {
        const chasing = pool.live.filter((e) => e.ai && (e.ai.state === 'chase' || e.ai.state === 'strike')).length;
        setStatus(
          `${LEVEL.pap} live: frame ${loop.frameCount}, score=${player.score}, health=${player.health}/` +
          `${player.maxHealth}, deaths=${player.deaths}, pickups=${player.pickupsCollected}/${collisionGrid.pickups.length}, ` +
          `blocksBroken=${player.brokenCount}${player.reachedExit ? ' -- LEVEL COMPLETE' : ''} -- arrows/WASD ` +
          `move+jump, space/ctrl breaks a block -- ${spawned} entities (${gateCount} gates, ${aiCount} AI, ` +
          `${chasing} chasing).`
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
