// Snd_TriggerEffect equivalent (docs/formats/pin.md, docs/memory-map.md): loads adlib.pin's
// sound-effect bank and plays cues by ID through the Web Audio oscillator synth (synth.js), plus
// loops roland2.pin's embedded song as level music. This is NOT a port of the real driver
// dispatch (Snd_TriggerEffect far-calls into whichever hardware driver pockets.ini selected;
// this port always uses adlib.pin's bank, regardless of any driver concept) and the event->sound
// ID mapping below is NOT decoded from the game -- docs/formats/pin.md confirms table entry N
// *is* sound_id N, but never resolved which IDs correspond to which real gameplay event (the one
// ID whose meaning IS confirmed, adlib.pin's 11, is the rare World-4 ending fanfare -- not used
// here). The IDs below are arbitrary picks from the 78 real MIDI cues in the bank, chosen only to
// give each gameplay event in this port ITS OWN distinct real sound, not a verified mapping.
//
// Browsers block audio until a user gesture -- call unlock() from a click/keydown handler before
// anything will actually play (see web/main.js's "click to enable audio" affordance).

'use strict';

import { playMidi } from './synth.js';
import { extractCue } from '../core/pin-sound.js';

// Arbitrary distinct sound_ids from adlib.pin's bank (78 real MIDI cues, IDs 0-81 minus the 4
// non-MIDI slots 11/52/59/69) -- see module header. Picked to spread across the low IDs.
export const SFX = {
  BREAK_BLOCK: 2,
  PICKUP: 5,
  DAMAGE: 8,
  DEATH: 13,
  BONUS_SPAWN: 20,
  LEVEL_EXIT: 30,
  GATE_TURN: 40,
};

const SFX_BANK_FILE = 'adlib.pin';
const MUSIC_FILE = 'roland2.pin';

export class SoundManager {
  constructor(cache) {
    this.cache = cache;
    this.audioCtx = null;
    this.sfxBank = null;
    this.cueCache = new Map(); // sound_id -> Uint8Array SMF
    this.musicCue = null;
    this.musicStop = null;
    this.musicEnabled = true;
    this.sfxVolume = 0.5;
    this.musicVolume = 0.28;
  }

  get unlocked() {
    return this.audioCtx !== null && this.audioCtx.state === 'running';
  }

  /** Must be called from a user-gesture handler (click/keydown) -- browser autoplay policy. */
  async unlock() {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    if (!this.sfxBank) {
      this.sfxBank = await this.cache.getPinSoundBank(SFX_BANK_FILE).catch(() => null);
    }
    if (!this.musicCue && this.cache.has(MUSIC_FILE)) {
      const bank = await this.cache.getPinSoundBank(MUSIC_FILE).catch(() => null);
      this.musicCue = bank ? extractCue(bank, 0) : null;
    }
  }

  /** Fire-and-forget playback of sound_id from the SFX bank. No-op if audio isn't unlocked yet. */
  trigger(soundId) {
    if (!this.unlocked || !this.sfxBank) return;
    let cue = this.cueCache.get(soundId);
    if (cue === undefined) {
      cue = extractCue(this.sfxBank, soundId);
      this.cueCache.set(soundId, cue);
    }
    if (!cue) return; // non-MIDI table entry, or out of range -- silently skip
    try {
      playMidi(this.audioCtx, cue, this.sfxVolume);
    } catch {
      // malformed/unsupported cue -- don't let audio errors interrupt gameplay
    }
  }

  startMusic() {
    if (!this.unlocked || !this.musicCue || !this.musicEnabled || this.musicStop) return;
    const { stop, durationSeconds } = playMidi(this.audioCtx, this.musicCue, this.musicVolume);
    this.musicStop = stop;
    this._musicLoopTimer = setTimeout(() => {
      this.musicStop = null;
      this.startMusic();
    }, Math.max(200, durationSeconds * 1000));
  }

  stopMusic() {
    clearTimeout(this._musicLoopTimer);
    if (this.musicStop) this.musicStop();
    this.musicStop = null;
  }
}
