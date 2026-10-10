// The attract demo's start-up (Game_StartAttractDemoAndRunLoop, CS:0x89..0x10B), transliterated, so a
// level can be started from the game's files alone. B51E (loads the level's graphics) and the
// pre-loop screen set-up (B3F2/B3C4/2A3, drawing only) are not state the main loop depends on.

'use strict';

import { findByClass } from './ds-memory.js';
import { levelListPointer, levelLoadEntities } from './spawn.js';
import { rebuildVisibleList } from './entity-behavior.js';
import { levelUpdateAnimatedTiles } from './tiles.js';
import { renderConsumes } from './iteration.js';

const fill = (m, from, to) => { for (let o = from; o < to; o++) m.w8(o, 0); };

/** 1000:0F8E: clear the entity block, the pointer array, the visible list and the spawn queue. */
function clearEntities(m) {
  fill(m, 0x9398, 0xb918);
  fill(m, 0x9090, 0x91bc);
  fill(m, 0x91be, 0x9254);
  fill(m, 0x926a, 0x9396);
}

/**
 * What the world loaders do to the freshly loaded map: world 3's (1000:126E, called after 1000:B8B7) replaces every tile 0x51 by 0xAF, a
 * negative (animating) tile, so the sea starts out animated. `[PROVEN]`: the real map around the player in world 3 sub-level 1 holds 0xAF where
 * the file has 0x51.
 */
export function mapFixups(m, world) {
  if (world !== 3) return;
  for (let a = 0x4200; a < 0x8200; a++) if (m.u8(a) === 0x51) m.w8(a, 0xaf);
}

/** 1000:0D19 (falls through into 0D53 and 0D7B). `from` selects where the original is entered. */
function levelStateInit(m, from) {
  const be = (o) => (m.u8(o) << 8) | m.u8(o + 1);
  const world = m.u16(0x8b89), sub = m.u16(0x8b8b);
  if (from === 'd19') {
    m.w16(0x8b79, m.u16(0x8b75));
    for (const o of [0x8b75, 0x8b83, 0x8b7f, 0x8b81, 0x8b85, 0x8b7b, 0x8b7d]) m.w16(o, 0);
    m.w8(0x8ba4, 0); m.w8(0x8c0b, 4);
  }
  if (from === 'd19' || from === 'd53') {
    const idx = ((world || sub) - 1) * 2;
    m.w16(0xef23, m.u16(0xef25 + idx)); // the world's tile-class table
    m.w16(0x8bf5, 0); m.w8(0x8bb2, 0);
  }
  // 0D7B
  m.w16(0x8b7b, m.u16(0x8b75)); m.w16(0x8b7d, m.u16(0x8b7f));
  m.w16(0x8b77, 1); m.w16(0x8c3c, 0); m.w16(0x8c3e, 0xffff); m.w16(0x8c40, 0xffff); m.w16(0x8c42, 0);
  const ax = 2 * (sub || 0x3e);
  const table = { 1: 0xf603, 2: 0xf725, 3: 0xf7d5, 4: 0xf87f }[world];
  let si = table;
  if (table === undefined) { m.w16(0x91ba, 0xffff); si = 0xf5db; }
  const di = be(ax); // the level list for this sub-level
  m.w16(0x8bb7, 0); m.w16(0x8bb9, 0);
  m.w16(0x8c63, m.u16(si + ax));
  m.w16(0x8bbb, be(di + 6)); m.w16(0x8bbd, be(di + 8));
  let score = m.u16(0x8b83);
  do score += 0x32; while ((score << 16 >> 16) < (m.u16(0x8b75) << 16 >> 16));
  m.w16(0x8b83, score - 0x32);
  m.w8(0x8ba1, 0x66); m.w8(0x8b97, 4); m.w8(0x8c03, 0); m.w16(0x8bf1, 0); m.w16(0x8bff, 0);
  m.w8(0x8b93, 1); m.w8(0x8b90, 6); m.w8(0x8b91, 0); m.w8(0x8b8f, 6); m.w16(0x8bf3, 0x17); m.w16(0x8c53, 0x50);
  m.w8(0x8b5e, 0); m.w8(0x8bb1, 0); m.w8(0x8b98, 0); m.w16(0x8b9a, 0); m.w8(0x8ba2, 0); m.w8(0x8ba0, 0);
  m.w16(0x8c34, 0); m.w8(0x8b5f, 0);
  for (const o of [0x8bef, 0x8bf7, 0x8bf9, 0x8bfb, 0x8bfd, 0x8c6b]) m.w16(o, 0);
  for (const o of [0x8c04, 0x8c05, 0x8c06, 0x8bb4, 0x8c07, 0x8c08, 0x8c09, 0x8c0c, 0x8bee]) m.w8(o, 0);
  for (const o of [0x8c5f, 0x8c61, 0x8c6f]) m.w16(o, 0);
  m.w8(0x8bae, 0x1e); m.w8(0x8baf, 1); m.w8(0x8bb0, 0); m.w8(0x8bb3, 0); m.w8(0x8bea, 0);
  for (const o of [0x8c2d, 0x8c59, 0x8c6d]) m.w16(o, 0);
  m.w8(0x8c0e, 0);
}

/** 1000:0221: scroll bookkeeping derived from the world entity's start position. */
function scrollInit(m) {
  const bx = findByClass(m, 1);
  if (bx === 0) return;
  let x = (-m.s16(bx + 6)) & 0xffff, y = (-m.s16(bx + 8)) & 0xffff;
  m.w16(0x8b69, x & 0x1f);
  m.w16(0x8c15, x % 0x20); m.w16(0x8c17, y % 0x10);
  m.w16(0x8c1f, Math.floor(x / 0x20)); m.w16(0x8c21, Math.floor(y / 0x10));
  m.w16(0x8c1d, m.u16(0x8c1f));
  m.w16(0x8c1d, (m.u16(0x8c1d) * 0x80) & 0xffff);
  m.w16(0x8c13, (0x4200 + m.u16(0x8c1d) + m.u16(0x8c21)) & 0xffff);
  m.w16(0x8c15, (-m.u16(0x8c15)) & 0xffff); m.w16(0x8c17, (-m.u16(0x8c17)) & 0xffff);
  m.w16(0x8bb7, 0); m.w16(0x8bb9, 0);
}

/**
 * Start the attract demo's level on `m`, whose DS holds the EXE data, the level script at DS:0, the map
 * at 0x4200 and the demo tape at 0x8200.
 */
export function bootAttractDemo(m, ctx, { world = 0, sub = 1, demo = true } = {}) {
  m.w16(0x8b89, world); m.w16(0x8b8b, sub);
  mapFixups(m, world);
  clearEntities(m);
  levelStateInit(m, 'd19');
  levelStateInit(m, 'd53');
  m.w16(0x8ba6, 0x8200); m.w16(0x8ba8, m.u16(0x8200));
  m.w16(0x8b71, 0x3141); m.w16(0x8b75, 0); m.w16(0x8b83, 0); m.w8(0x8baa, demo ? 1 : 0xff); m.w16(0x8b8b, sub);
  clearEntities(m);
  levelStateInit(m, 'd7b');
  levelLoadEntities(m, levelListPointer(m, m.u16(0x8b8b)), ctx);
  rebuildVisibleList(m);
  scrollInit(m);
  m.w16(0x8bb5, 0x9396);
  levelUpdateAnimatedTiles(m, ctx); // call 2 of iteration 0, then call 3: the first captured row is sampled here
  renderConsumes(m);
}

/**
 * A level (re)start inside a running game (1000:03FF -> 00CA): the entities are cleared and the level list is
 * loaded again. Score, lives and the other game-wide state are kept (the caller has already restored
 * them), the map must be reloaded by the host. [8BAA] keeps its value (real play stays real play).
 */
export function startLevel(m, ctx, { world, sub }) {
  m.w16(0x8b89, world); m.w16(0x8b8b, sub);
  mapFixups(m, world);
  clearEntities(m);
  m.w16(0xef23, m.u16(0xef25 + (world - 1) * 2)); // the world's tile-class table (1000:0D53)
  levelStateInit(m, 'd7b');
  // (the RNG is not reseeded here: see the free-run check against the second restart in capture 4)
  levelLoadEntities(m, levelListPointer(m, sub), ctx);
  rebuildVisibleList(m);
  scrollInit(m);
  m.w16(0x8bb5, 0x9396);
  levelUpdateAnimatedTiles(m, ctx);
  renderConsumes(m);
}
