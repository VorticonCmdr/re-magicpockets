// Entity shape-descriptor resolution -- given an entity's level-script `type` and the
// Ghidra-derived symbols/entity-shapes.json table, work out which .pak tile (if any) it draws.
// Port of level.html's resolveEntitySprite, split out as a pure function so the engine can
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

/**
 * Resolves a KNOWN-GOOD representative tile for an entity whose descriptor is frameSourceMode 0
 * (indirect near-pointer addressing, undecoded -- docs/formats/pin-level-script.md), by bank/
 * world plus an explicitly supplied local tile index, bypassing animStart entirely.
 *
 * This exists because the obvious shortcut -- treating animStart as if it were a direct index
 * anyway -- was tried first and is actively WRONG, not just imprecise: for the player descriptor
 * (type 3), animStart (65) maps to kidx1.pak local index 5, which is a genuinely EMPTY/unused
 * tile slot (verified by rendering all 20 of kidx1.pak's tiles -- indices 0-4/6/10-17 are real
 * character frames -- cap, sunglasses, walk/punch poses -- 5/7/8/9/18/19 are blank placeholders).
 * A user-reported "player still isn't a sprite" bug traced to exactly this: the sprite pipeline
 * was working correctly end-to-end, it was just drawing a transparent tile every frame. So this
 * takes an explicit, verified-by-eye local index instead of derived data that looked plausible
 * but wasn't -- still not frame-accurate (real per-frame selection needs the undecoded indirect
 * table), but at minimum guaranteed to draw the right CHARACTER, not a blank square.
 */
export function resolveShapeTileByBank(entityType, entityShapes, world, localTileIndex) {
  if (!entityShapes || entityType == null || entityType >= entityShapes.descriptors.length) return null;
  const desc = entityShapes.descriptors[entityType];
  const atlasSpec = entityShapes.bankAtlas[desc.bankId];
  if (!atlasSpec) return null;
  let remaining = localTileIndex;
  for (const part of atlasSpec.parts) {
    if (remaining < part.tiles) {
      const file = part.perWorld ? `${part.file}${world}` : part.file;
      return { file, localTileIndex: remaining };
    }
    remaining -= part.tiles;
  }
  return null;
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
