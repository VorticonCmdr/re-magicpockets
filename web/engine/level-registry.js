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
