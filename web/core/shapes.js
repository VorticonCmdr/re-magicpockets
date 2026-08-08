// Entity shape-descriptor resolution -- given an entity's level-script `type` and the
// Ghidra-derived symbols/entity-shapes.json table, work out which .pak tile (if any) it draws.
// Port of tools/viewer.html's resolveEntitySprite, split out as a pure function so the engine can
// call it without any DOM/fetch coupling. See docs/formats/pin-level-script.md's "Entity sprite
// rendering" section -- frameSourceMode gates three addressing modes; only frameSourceMode===1
// (or bankId 6, always-direct) is a confirmed direct animStart -> tile-index mapping today.

'use strict';

/**
 * Returns { file, localTileIndex } for entities with a CONFIRMED direct animStart -> tile index
 * mapping, or null if unresolved (frameSourceMode 0 = indirect near-pointer table, not yet
 * decoded; 0xffff = live video-memory effect, no static tile). `file` is the bare .pak basename
 * without extension (e.g. "extras", or "nasty3" for a perWorld part already resolved to `world`).
 */
export function resolveEntitySprite(entityType, entityShapes, world) {
  if (!entityShapes || entityType == null || entityType >= entityShapes.descriptors.length) return null;
  const desc = entityShapes.descriptors[entityType];
  const atlasSpec = entityShapes.bankAtlas[desc.bankId];
  if (!atlasSpec) return null;
  if (desc.bankId !== 6 && desc.frameSourceMode !== 1) return null;

  let tileIndex = desc.animStart;
  for (const part of atlasSpec.parts) {
    if (tileIndex < part.tiles) {
      const file = part.perWorld ? `${part.file}${world}` : part.file;
      return { file, localTileIndex: tileIndex };
    }
    tileIndex -= part.tiles;
  }
  return null; // out of range for every part -- shouldn't happen for a confirmed direct mapping
}

/** Every .pak basename (without extension) any bankAtlas entry could need for the given world. */
export function paksNeededForWorld(entityShapes, world) {
  const files = new Set();
  for (const atlas of Object.values(entityShapes.bankAtlas || {})) {
    for (const part of atlas.parts) {
      files.add(part.perWorld ? `${part.file}${world}` : part.file);
    }
  }
  return [...files];
}
