// Camera_UpdateScroll (docs/engine.md, main-loop call #1) equivalent. The original reads a
// scroll-target struct, negates X/Y, and splits the result into a whole-tile part (divided by the
// tile size, 32px horizontally / 16px vertically) used to compute the read pointer into the
// column-major level-map buffer, plus a sub-tile pixel remainder ([0x8b69] for X) later fed to
// the EGA pixel-panning register by Video_FlipAndScroll for hardware fine-scroll.
//
// A browser canvas has no equivalent hardware limitation -- ctx.drawImage crops at any fractional
// pixel offset directly, so there's no need to emulate the tile-pointer/pixel-panning-register
// split for rendering. `split` below still exposes the same tile/remainder decomposition (for
// parity with the original's data model, and because later phases -- ground collision, tile
// lookups -- will need the tile-index part the same way Camera_UpdateScroll's callers did).

'use strict';

export const TILE_WIDTH = 32;
export const TILE_HEIGHT = 16;

export class Camera {
  constructor({ levelWidthPx, levelHeightPx, viewportWidthPx, viewportHeightPx, speedPxPerSec = 180 }) {
    this.levelWidthPx = levelWidthPx;
    this.levelHeightPx = levelHeightPx;
    this.viewportWidthPx = viewportWidthPx;
    this.viewportHeightPx = viewportHeightPx;
    this.speedPxPerSec = speedPxPerSec;
    this.x = 0; // camera top-left, in level-pixel space (sub-pixel precision kept as a float)
    this.y = 0;
  }

  /** Move the camera by held input direction, clamped to keep the viewport inside the level. */
  update(dtSeconds, input) {
    const step = this.speedPxPerSec * dtSeconds;
    if (input.left) this.x -= step;
    if (input.right) this.x += step;
    if (input.up) this.y -= step;
    if (input.down) this.y += step;

    const maxX = Math.max(0, this.levelWidthPx - this.viewportWidthPx);
    const maxY = Math.max(0, this.levelHeightPx - this.viewportHeightPx);
    this.x = Math.min(Math.max(this.x, 0), maxX);
    this.y = Math.min(Math.max(this.y, 0), maxY);
  }

  /** Center the viewport on (targetX, targetY) -- e.g. the player -- clamped to level bounds. */
  centerOn(targetX, targetY) {
    const maxX = Math.max(0, this.levelWidthPx - this.viewportWidthPx);
    const maxY = Math.max(0, this.levelHeightPx - this.viewportHeightPx);
    this.x = Math.min(Math.max(targetX - this.viewportWidthPx / 2, 0), maxX);
    this.y = Math.min(Math.max(targetY - this.viewportHeightPx / 2, 0), maxY);
  }

  /** Camera_UpdateScroll's whole-tile / sub-tile-remainder split, for parity/debug display. */
  get split() {
    const tileCol = Math.floor(this.x / TILE_WIDTH);
    const tileRow = Math.floor(this.y / TILE_HEIGHT);
    const subX = this.x - tileCol * TILE_WIDTH;
    const subY = this.y - tileRow * TILE_HEIGHT;
    return { tileCol, tileRow, subX, subY };
  }
}
