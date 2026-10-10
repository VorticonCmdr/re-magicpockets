// Every playable level this port can load, straight from the real shipped file names
// (docs/formats/pin-level-script.md: world 1's script is oddly named new1.pin; world 3 has three
// script variants, level3a/b.pap each paired with the a/b-suffixed script per
// level.html's existing guessEntityScriptForLevel heuristic -- level3c.pin has no matching
// .pap and isn't used here). Palette selection matches docs/memory-map.md's per-world bank names.

'use strict';

export const LEVELS = [
  { id: '1a', world: 1, pap: 'level1a.pap', pak: 'blocks1.pak', pin: 'new1.pin', palette: 'world1' },
  { id: '1b', world: 1, pap: 'level1b.pap', pak: 'blocks1.pak', pin: 'new1.pin', palette: 'world1' },
  { id: '2a', world: 2, pap: 'level2a.pap', pak: 'blocks2.pak', pin: 'level2.pin', palette: 'world2' },
  { id: '2b', world: 2, pap: 'level2b.pap', pak: 'blocks2.pak', pin: 'level2.pin', palette: 'world2' },
  { id: '3a', world: 3, pap: 'level3a.pap', pak: 'blocks3.pak', pin: 'level3a.pin', palette: 'world3' },
  { id: '3b', world: 3, pap: 'level3b.pap', pak: 'blocks3.pak', pin: 'level3b.pin', palette: 'world3' },
  { id: '4a', world: 4, pap: 'level4a.pap', pak: 'blocks4.pak', pin: 'level4.pin', palette: 'world4' },
  { id: '4b', world: 4, pap: 'level4b.pap', pak: 'blocks4.pak', pin: 'level4.pin', palette: 'world4' },
];

export function findLevel(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

/** The level after `id` in this port's fixed sequence, wrapping to the first after the last. */
export function nextLevel(id) {
  const i = LEVELS.findIndex((l) => l.id === id);
  return LEVELS[(i + 1) % LEVELS.length];
}

/**
 * The files the game itself loads for each (world, sub-level), `[PROVEN]` by dumping DS:0 (the script) and DS:0x4200 (the map) after
 * each level-code warp in DOSBox and matching them against every shipped file (tools/attract-capture/level-files.json holds the crc16 of
 * the real memory; `npm run verify` recomputes them from the shipped files). World 1 sub-levels 1-5 were matched by the earlier captures.
 * The maps are the files' own decode (`web/core/pap.js` layout: column-major, 128 x 128), not the viewer's `LEVELS` list above.
 */
export const LEVEL_FILES = (() => {
  const t = {};
  const put = (world, subs, pin, pap) => { for (const sub of subs) t[`${world}.${sub}`] = { pin, pap }; };
  put(1, [1], 'new1.pin', 'pcmap.pap'); put(1, [2], 'new1.pin', 'level1a.pap'); put(1, [3, 4, 5, 6], 'new1.pin', 'level1b.pap');
  put(2, [1, 2, 3], 'level2.pin', 'level2b.pap'); put(2, [4, 5, 6, 7], 'level2.pin', 'level2a.pap');
  put(3, [1, 2, 3], 'level3a.pin', 'level3a.pap'); put(3, [4, 5, 6, 7], 'level3b.pin', 'level3b.pap'); put(3, [8], 'level3c.pin', 'sea.pap');
  put(4, [1, 2, 3, 4], 'level4.pin', 'level4a.pap'); put(4, [5, 6, 7, 8], 'level4.pin', 'level4b.pap');
  return t;
})();

/** @returns {{pin: string, pap: string}|null} the script and map files the game loads for a level */
export function levelFilesFor(world, sub) {
  return LEVEL_FILES[`${world}.${sub}`] || null;
}
