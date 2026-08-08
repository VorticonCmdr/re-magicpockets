// Input_ReadState equivalent (docs/memory-map.md's "Input subsystem"), keyboard-event-driven
// instead of the original's INT 9h ISR + per-frame poll. The original resolves to a 5-bit action
// mask (order confirmed from Config_ParseIniAndLoadSoundDriver's key-binding table: 0=up, 1=down,
// 2=left, 3=right, 4=fire) held in [0x8c85]/read out at [0x8b5d] -- we keep that same bit order so
// downstream code (camera, eventually player movement) can treat the mask identically to the
// original's `[0x8b5d]` byte. Joystick input (Input_PollJoystickPort) is out of scope for a
// browser port.

'use strict';

export const ACTION_UP = 1 << 0;
export const ACTION_DOWN = 1 << 1;
export const ACTION_LEFT = 1 << 2;
export const ACTION_RIGHT = 1 << 3;
export const ACTION_FIRE = 1 << 4;

// A reasonable modern default binding -- the original's actual mapping came from pockets.ini and
// isn't reproduced here (that's a player-configurable file, not fixed game logic).
const DEFAULT_KEY_MAP = {
  ArrowUp: ACTION_UP,
  KeyW: ACTION_UP,
  ArrowDown: ACTION_DOWN,
  KeyS: ACTION_DOWN,
  ArrowLeft: ACTION_LEFT,
  KeyA: ACTION_LEFT,
  ArrowRight: ACTION_RIGHT,
  KeyD: ACTION_RIGHT,
  Space: ACTION_FIRE,
  ControlLeft: ACTION_FIRE,
};

export class Input {
  constructor(target = window, keyMap = DEFAULT_KEY_MAP) {
    this.keyMap = keyMap;
    this.mask = 0; // mirrors [0x8c85]/[0x8b5d]'s held-state bitmask
    this._onKeyDown = (ev) => {
      const bit = this.keyMap[ev.code];
      if (bit === undefined) return;
      ev.preventDefault();
      this.mask |= bit;
    };
    this._onKeyUp = (ev) => {
      const bit = this.keyMap[ev.code];
      if (bit === undefined) return;
      ev.preventDefault();
      this.mask &= ~bit;
    };
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    this._target = target;
  }

  dispose() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
  }

  get up() { return (this.mask & ACTION_UP) !== 0; }
  get down() { return (this.mask & ACTION_DOWN) !== 0; }
  get left() { return (this.mask & ACTION_LEFT) !== 0; }
  get right() { return (this.mask & ACTION_RIGHT) !== 0; }
  get fire() { return (this.mask & ACTION_FIRE) !== 0; }
}
