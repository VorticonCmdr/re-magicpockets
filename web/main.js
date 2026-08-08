// Post-Phase-7 fix: real per-level ground collision. Every level now collides against its OWN
// real geometry, derived from the real `.pap` tile data and the real `[0xef23]` ground-collision
// table (`6de3:f189`, dumped via Ghidra -- see core/tile-collision.js) -- not Phase 3/5's
// synthetic, hand-authored placeholder arena, which visibly disagreed with the real cave art and
// forced an arbitrary, level-independent spawn point. Player and enemy rendering still use
// placeholder-ish visuals where the real data doesn't resolve cleanly (the player's own sprite
// descriptor is frameSourceMode 0 -- indirect, undecoded addressing -- so it renders a
// REPRESENTATIVE real tile from its real character bank, not a frame-accurate pose; enemies whose
// descriptors are frameSourceMode 0 still fall back to a dot, same as every phase since Phase 1).
// See engine/real-terrain.js and core/tile-collision.js for the full writeup.
//
// Phase 6/7 features (world/level flow, audio) are unchanged -- see their own file headers.

'use strict';

import { sourceFromFileList, sourceFromFetch } from './loader/asset-source.js';
import { AssetCache } from './loader/asset-cache.js';
import { WORLD_PALETTES } from './core/palette.js';
import { buildLevelScene, loadSpritePaks, drawEntitiesLive, tileToCanvas } from './render/canvas.js';
import { paksNeededForWorld, resolveShapeTileByBank } from './core/shapes.js';
import { Camera, TILE_WIDTH, TILE_HEIGHT } from './engine/camera.js';
import { Input } from './engine/input.js';
import { MainLoop } from './engine/loop.js';
import { EntityPool } from './engine/entity-pool.js';
import { Player } from './engine/player.js';
import { buildLevelPlayfield } from './engine/real-terrain.js';
import { attachAiIfKnown, tickAllAi, isGateType } from './engine/entity-ai.js';
import { chooseWorld1BonusType, spawnBonusItem } from './engine/bonus-economy.js';
import { LEVELS, findLevel, nextLevel } from './engine/level-registry.js';
import { Transition } from './engine/transition.js';
import { SoundManager, SFX } from './audio/sound-manager.js';

const PLAYER_TYPE = 3; // class-3/player, confirmed sprite cross-reference (docs/enemies.md)
// Global index into bank 2's combined tile space (bitkid.pak's 60 tiles + kidxN.pak's 20) landing
// on kidxN local index 0 -- a verified-by-eye standing/idle pose (cap + sunglasses). See
// core/shapes.js's resolveShapeTileByBank for why this is hardcoded instead of derived.
const PLAYER_SPRITE_GLOBAL_INDEX = 60;

const SHAPES_URL = '/symbols/entity-shapes.json';
const VIEWPORT_W = 320;
const VIEWPORT_H = 192;
const PICKUP_RADIUS = 10;
const ENEMY_HIT_HALF_SIZE = 8;
const RESERVED_FOR_DYNAMIC_SPAWNS = 16;

const statusEl = document.getElementById('status');
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const picker = document.getElementById('picker');
const devServerBtn = document.getElementById('dev-server');
const levelSelectEl = document.getElementById('level-select');
const audioBtn = document.getElementById('enable-audio');

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
let sharedCache = null;
let sharedEntityShapes = null;
let sharedPlayer = null; // score/health persist across level loads within a session
let currentLevelId = null;
let sharedSound = null;

function buildLevelSelectUi() {
  levelSelectEl.innerHTML = '';
  for (const level of LEVELS) {
    const btn = document.createElement('button');
    btn.textContent = `world ${level.world}${level.id.slice(-1)}`;
    btn.type = 'button';
    btn.addEventListener('click', () => loadLevel(level.id));
    levelSelectEl.appendChild(btn);
  }
}

async function loadLevel(id) {
  const levelEntry = findLevel(id);
  if (!levelEntry) return;
  const cache = sharedCache;
  const required = [levelEntry.pak, levelEntry.pap, levelEntry.pin];
  for (const f of required) {
    if (!cache.has(f)) {
      setStatus(`missing required file: ${f} (looked for it, case-insensitive, among the picked files)`, true);
      return;
    }
  }

  if (activeLoop) activeLoop.stop();
  if (activeInput) activeInput.dispose();
  if (sharedSound) sharedSound.stopMusic();
  currentLevelId = id;

  try {
    setStatus(`depacking + decoding ${levelEntry.pak}, ${levelEntry.pap}, ${levelEntry.pin}...`);
    const level = { ...levelEntry, paletteColors: WORLD_PALETTES[levelEntry.palette] };
    const entityShapes = sharedEntityShapes;
    const scene = await buildLevelScene(cache, level);
    const spritePaks = await loadSpritePaks(cache, entityShapes, levelEntry.world, level.paletteColors);

    // Spawn every on-map level-script entity into the pool, reserving headroom for dynamic spawns
    // (bonus items). Attach real AI to types matching this world's confirmed dispatch entries.
    const pool = new EntityPool();
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
      if (attachAiIfKnown(levelEntry.world, entity)) {
        if (isGateType(levelEntry.world, entity.type)) gateCount++;
        else aiCount++;
      }
    }

    // Real ground collision + a generically-found spawn/pickups/exit, all on the level's own real
    // geometry -- see engine/real-terrain.js for what's real (the collision) vs. placeholder
    // (which exact standable spots get used for what).
    const playfield = buildLevelPlayfield(scene.pap);
    const collisionGrid = playfield;
    const spawnX = playfield.spawnCol * TILE_WIDTH;
    const spawnY = playfield.spawnRow * TILE_HEIGHT;

    const player = sharedPlayer || new Player(0, 0);
    sharedPlayer = player;
    player.x = player.spawnX = spawnX;
    player.y = player.spawnY = spawnY - player.h;
    player.vx = 0;
    player.vy = 0;
    player.reachedExit = false;

    const playerSprite = resolveShapeTileByBank(PLAYER_TYPE, entityShapes, levelEntry.world, PLAYER_SPRITE_GLOBAL_INDEX);

    const camera = new Camera({
      levelWidthPx: scene.widthPx,
      levelHeightPx: scene.heightPx,
      viewportWidthPx: VIEWPORT_W,
      viewportHeightPx: VIEWPORT_H,
    });
    camera.centerOn(player.x, player.y);
    const input = new Input(window);
    activeInput = input;
    const transition = new Transition();

    const loop = new MainLoop({
      entityUpdateAll: () => {
        if (transition.active || player.reachedExit) return;
        player.update(input, collisionGrid);
        tickAllAi(pool.live, player, collisionGrid, loop.rng);

        // Bonus-item spawn, triggered by breaking a block. World-1 decision tree used for every
        // world (docs/engine.md only decoded world 1's branch-by-branch) -- see bonus-economy.js.
        if (player.lastBreak) {
          const type = chooseWorld1BonusType({
            blocksBroken: player.brokenCount,
            pickupsCollected: player.pickupsCollected,
            score: player.score,
          });
          spawnBonusItem(pool, type, player.lastBreak.col * TILE_WIDTH, player.lastBreak.row * TILE_HEIGHT - 16);
          sharedSound?.trigger(SFX.BREAK_BLOCK);
          sharedSound?.trigger(SFX.BONUS_SPAWN);
        }

        for (const p of collisionGrid.pickups) {
          if (p.collected) continue;
          if (aabbOverlap(player.x, player.y, player.w, player.h, p.x - PICKUP_RADIUS, p.y - PICKUP_RADIUS, PICKUP_RADIUS * 2, PICKUP_RADIUS * 2)) {
            p.collected = true;
            player.collectPickup(50);
            sharedSound?.trigger(SFX.PICKUP);
          }
        }

        for (const e of pool.live) {
          if (!e.ai || (e.ai.state !== 'chase' && e.ai.state !== 'strike')) continue;
          if (aabbOverlap(
            player.x, player.y, player.w, player.h,
            e.x - ENEMY_HIT_HALF_SIZE, e.y - ENEMY_HIT_HALF_SIZE, ENEMY_HIT_HALF_SIZE * 2, ENEMY_HIT_HALF_SIZE * 2
          )) {
            const deathsBefore = player.deaths;
            if (player.takeDamage(e.x)) {
              sharedSound?.trigger(player.deaths > deathsBefore ? SFX.DEATH : SFX.DAMAGE);
            }
            break;
          }
        }

        const z = collisionGrid.exitZone;
        if (aabbOverlap(player.x, player.y, player.w, player.h, z.x, z.y, z.w, z.h)) {
          player.reachedExit = true;
          sharedSound?.trigger(SFX.LEVEL_EXIT);
          transition.start(() => loadLevel(nextLevel(currentLevelId).id));
        }
      },
      cameraUpdateScroll: () => {
        if (!transition.active) camera.centerOn(player.x + player.w / 2, player.y + player.h / 2);
      },
      videoFlipAndScroll: () => {
        ctx.clearRect(0, 0, VIEWPORT_W, VIEWPORT_H);
        ctx.drawImage(
          scene.canvas,
          camera.x, camera.y, VIEWPORT_W, VIEWPORT_H,
          0, 0, VIEWPORT_W, VIEWPORT_H
        );
        const z = collisionGrid.exitZone;
        ctx.fillStyle = 'rgba(80, 220, 120, 0.35)';
        ctx.fillRect(z.x - camera.x, z.y - camera.y, z.w, z.h);

        for (const p of collisionGrid.pickups) {
          if (p.collected) continue;
          ctx.beginPath();
          ctx.arc(p.x - camera.x, p.y - camera.y, PICKUP_RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = '#ffe066';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.stroke();
        }

        drawEntitiesLive(ctx, pool.live, entityShapes, spritePaks, levelEntry.world, camera, VIEWPORT_W, VIEWPORT_H);

        const blinkHidden = player.invulnFrames > 0 && Math.floor(loop.frameCount / 4) % 2 === 0;
        if (!blinkHidden) {
          const playerPak = playerSprite && spritePaks[playerSprite.file];
          const px = player.x - camera.x;
          const py = player.y - camera.y;
          if (playerPak && playerSprite.localTileIndex < playerPak.tileCount) {
            const rgba = playerPak.tiles[playerSprite.localTileIndex];
            const c = tileToCanvas(rgba, playerPak.tileWidth, playerPak.tileHeight);
            ctx.save();
            if (player.facing < 0) {
              ctx.translate(px + player.w, py);
              ctx.scale(-1, 1);
              ctx.drawImage(c, (player.w - playerPak.tileWidth) / 2, player.h - playerPak.tileHeight);
            } else {
              ctx.drawImage(c, px + (player.w - playerPak.tileWidth) / 2, py + player.h - playerPak.tileHeight);
            }
            ctx.restore();
          } else {
            // Fallback placeholder box -- only reached if the player's real sprite/atlas failed to resolve.
            ctx.fillStyle = player.onGround ? '#ffd23f' : '#ff9f1c';
            ctx.fillRect(px, py, player.w, player.h);
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.strokeRect(px, py, player.w, player.h);
          }
        }

        // --- HUD (placeholder canvas text) ---
        ctx.save();
        ctx.font = '10px monospace';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        const scoreText = `SCORE ${player.score}  WORLD ${levelEntry.world}${levelEntry.id.slice(-1)}`;
        ctx.strokeText(scoreText, 4, 4);
        ctx.fillText(scoreText, 4, 4);
        for (let i = 0; i < player.maxHealth; i++) {
          const hx = VIEWPORT_W - 4 - (i + 1) * 14;
          ctx.fillStyle = i < player.health ? '#ff3b3b' : 'rgba(255,255,255,0.25)';
          ctx.beginPath();
          ctx.arc(hx, 10, 5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        // Fx_UpdateTransition equivalent -- see transition.js header for why this is a plain
        // alpha overlay and not a port of the real 24-bank palette fade.
        const alpha = transition.tick();
        if (alpha > 0) {
          ctx.fillStyle = `rgba(0,0,0,${alpha})`;
          ctx.fillRect(0, 0, VIEWPORT_W, VIEWPORT_H);
        }
      },
      hudUpdateScoreDisplay: () => {
        const chasing = pool.live.filter((e) => e.ai && (e.ai.state === 'chase' || e.ai.state === 'strike')).length;
        setStatus(
          `world ${levelEntry.world}${levelEntry.id.slice(-1)} (${levelEntry.pap}) live: frame ${loop.frameCount}, ` +
          `player (${player.x.toFixed(1)}, ${player.y.toFixed(1)})px onGround=${player.onGround}, ` +
          `score=${player.score}, health=${player.health}/${player.maxHealth}, deaths=${player.deaths}, ` +
          `pickups=${player.pickupsCollected}/${collisionGrid.pickups.length}, blocksBroken=${player.brokenCount} ` +
          `-- arrows/WASD move+jump, space/ctrl breaks a block, reach the green exit to advance -- ` +
          `${spawned} entities (${gateCount} gates, ${aiCount} AI, ${chasing} chasing).`
        );
      },
    });
    activeLoop = loop;
    loop.start();
    sharedSound?.startMusic();
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
    throw err;
  }
}

async function startSession(cache) {
  sharedCache = cache;
  sharedSound = new SoundManager(cache);
  if (!sharedEntityShapes) sharedEntityShapes = await loadEntityShapes();
  buildLevelSelectUi();
  await loadLevel(LEVELS[0].id);
}

picker.addEventListener('change', () => {
  const source = sourceFromFileList(picker.files);
  startSession(new AssetCache(source));
});

// Convenience for local dev: assumes `node tools/serve.js` is running and data/ is reachable at
// /data/ (serve.js serves the whole repo root, and data/ exists on disk even though it's
// gitignored -- this path only works for someone who already has the original files locally).
// Registers every file any level/world might need, computed from level-registry.js + the real
// per-world sprite-atlas requirements (core/shapes.js), not a hand-maintained list.
devServerBtn.addEventListener('click', async () => {
  setStatus('loading entity-shapes.json + building the full-session file list...');
  if (!sharedEntityShapes) sharedEntityShapes = await loadEntityShapes();
  const files = new Set(['adlib.pin', 'roland2.pin']);
  for (const level of LEVELS) {
    files.add(level.pak);
    files.add(level.pap);
    files.add(level.pin);
  }
  for (const world of [1, 2, 3, 4]) {
    for (const name of paksNeededForWorld(sharedEntityShapes, world)) files.add(`${name}.pak`);
  }
  const source = sourceFromFetch('/data', [...files]);
  startSession(new AssetCache(source));
});

audioBtn.addEventListener('click', async () => {
  if (!sharedSound) {
    setStatus('pick a data source first, then enable audio.', true);
    return;
  }
  audioBtn.textContent = 'enabling audio...';
  await sharedSound.unlock();
  audioBtn.textContent = sharedSound.unlocked ? 'audio on' : 'audio failed to unlock';
  audioBtn.disabled = sharedSound.unlocked;
  if (activeLoop) sharedSound.startMusic();
});
