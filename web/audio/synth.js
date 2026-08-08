// Web Audio playback for parsed MIDI data -- ported from tools/midi-player.html's
// playMidiBuffer, decoupled from that page's DOM/UI bits. This is a small oscillator-per-note
// synth (one of 4 waveforms picked by MIDI program number), NOT a real OPL2/MT-32 emulation --
// docs/formats/pin.md flags that adlib.pin's cues embed OPL2 timbre parameters as FF 7F SysEx
// meta events a standard MIDI player (this one included) ignores, so playback timbre won't match
// the original AdLib sound. Good enough to hear the extracted note data is sane and to give the
// port real, audible sound effects/music -- not a faithful hardware recreation.

'use strict';

import { parseMidi, makeTickToSeconds } from '../core/midi.js';

const WAVEFORMS = ['square', 'sawtooth', 'triangle', 'sine'];

function noteToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/**
 * Schedules playback of `midiBytes` (a Uint8Array SMF) on `audioCtx`, starting shortly after now,
 * mixed at `volume` (0-1) into a dedicated GainNode. Returns { stop, durationSeconds }.
 */
export function playMidi(audioCtx, midiBytes, volume = 0.5) {
  const { division, tracks, tempoEvents } = parseMidi(midiBytes);
  const tickToSeconds = makeTickToSeconds(tempoEvents, division);

  const allEvents = tracks.flat().sort((a, b) => a.tick - b.tick);
  const channelProgram = new Array(16).fill(0);
  const channelGain = new Array(16).fill(1);

  const master = audioCtx.createGain();
  master.gain.value = volume;
  master.connect(audioCtx.destination);

  const startAt = audioCtx.currentTime + 0.03;
  const active = new Map(); // "channel:note" -> {osc, gain}
  const scheduledNodes = [];
  let maxTime = startAt;

  for (const ev of allEvents) {
    const t = startAt + tickToSeconds(ev.tick);
    maxTime = Math.max(maxTime, t);
    if (ev.type === 0xc0) {
      channelProgram[ev.channel] = ev.data1;
    } else if (ev.type === 0xb0 && ev.data1 === 7) {
      channelGain[ev.channel] = ev.data2 / 127;
    } else if (ev.type === 0x90 && ev.data2 > 0) {
      const key = ev.channel + ':' + ev.data1;
      const existing = active.get(key);
      if (existing) {
        existing.gain.gain.setValueAtTime(0, t);
        existing.osc.stop(t);
      }
      const osc = audioCtx.createOscillator();
      osc.type = WAVEFORMS[channelProgram[ev.channel] % WAVEFORMS.length];
      osc.frequency.value = noteToFreq(ev.data1);
      const gain = audioCtx.createGain();
      const peak = (ev.data2 / 127) * channelGain[ev.channel] * 0.2;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.01);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      active.set(key, { osc, gain });
      scheduledNodes.push(osc);
    } else if (ev.type === 0x80 || (ev.type === 0x90 && ev.data2 === 0)) {
      const key = ev.channel + ':' + ev.data1;
      const existing = active.get(key);
      if (existing) {
        existing.gain.gain.setValueAtTime(existing.gain.gain.value, t);
        existing.gain.gain.linearRampToValueAtTime(0, t + 0.03);
        existing.osc.stop(t + 0.04);
        active.delete(key);
      }
    }
  }
  for (const { osc, gain } of active.values()) {
    gain.gain.setValueAtTime(gain.gain.value, maxTime);
    gain.gain.linearRampToValueAtTime(0, maxTime + 0.05);
    osc.stop(maxTime + 0.06);
    scheduledNodes.push(osc);
  }

  function stop() {
    for (const osc of scheduledNodes) {
      try { osc.stop(audioCtx.currentTime); } catch { /* already stopped */ }
    }
    master.disconnect();
  }

  return { stop, durationSeconds: maxTime - audioCtx.currentTime };
}
