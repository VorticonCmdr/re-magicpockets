// Standard MIDI File parser -- ported from tools/midi-player.html's parseMidi/makeTickToSeconds
// (already isomorphic ArrayBuffer/DataView code, just relocated so both the browser engine and
// any future CLI tooling can share it). Pure data-in/data-out, no Web Audio dependency -- see
// web/audio/synth.js for playback.

'use strict';

function readVLQ(bytes, pos) {
  let value = 0;
  let count = 0;
  while (true) {
    const b = bytes[pos++];
    value = (value << 7) | (b & 0x7f);
    count++;
    if (!(b & 0x80) || count > 4) break;
  }
  return { value, pos };
}

/** Parses a Uint8Array/ArrayBuffer containing a Standard MIDI File. */
export function parseMidi(bufOrView) {
  const bytes = bufOrView instanceof Uint8Array ? bufOrView : new Uint8Array(bufOrView);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'MThd') {
    throw new Error('not a MIDI file (no MThd)');
  }
  const division = view.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-division MIDI files are not supported here');

  let pos = 8 + view.getUint32(4);
  const tracks = [];
  const tempoEvents = [];

  while (pos < bytes.length) {
    if (String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]) !== 'MTrk') break;
    const trackLen = view.getUint32(pos + 4);
    let p = pos + 8;
    const trackEnd = p + trackLen;
    let tick = 0;
    let runningStatus = null;
    const events = [];

    while (p < trackEnd) {
      const delta = readVLQ(bytes, p);
      p = delta.pos;
      tick += delta.value;
      let status = bytes[p];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        p++;
        if (status !== 0xff && status !== 0xf0 && status !== 0xf7) runningStatus = status;
      }
      if (status === 0xff) {
        const type = bytes[p++];
        const len = readVLQ(bytes, p);
        p = len.pos;
        if (type === 0x51) {
          const usPerQuarter = (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
          tempoEvents.push({ tick, usPerQuarter });
        }
        p += len.value;
        if (type === 0x2f) break; // end of track
      } else if (status === 0xf0 || status === 0xf7) {
        const len = readVLQ(bytes, p);
        p = len.pos + len.value;
      } else {
        const hi = status & 0xf0;
        const channel = status & 0x0f;
        const nbytes = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        const data1 = bytes[p];
        const data2 = nbytes === 2 ? bytes[p + 1] : undefined;
        p += nbytes;
        events.push({ tick, type: hi, channel, data1, data2 });
      }
    }
    tracks.push(events);
    pos = trackEnd;
  }

  return { division, tracks, tempoEvents };
}

/** Builds a tick -> seconds converter from a (possibly empty) list of tempo-change events. */
export function makeTickToSeconds(tempoEvents, division) {
  const sorted = [...tempoEvents].sort((a, b) => a.tick - b.tick);
  const anchors = [{ tick: 0, time: 0, usPerQuarter: 500000 }];
  for (const ev of sorted) {
    if (ev.tick === 0) {
      anchors[0].usPerQuarter = ev.usPerQuarter;
      continue;
    }
    const prev = anchors[anchors.length - 1];
    const time = prev.time + ((ev.tick - prev.tick) * (prev.usPerQuarter / 1e6)) / division;
    anchors.push({ tick: ev.tick, time, usPerQuarter: ev.usPerQuarter });
  }
  return (tick) => {
    let anchor = anchors[0];
    for (const a of anchors) {
      if (a.tick > tick) break;
      anchor = a;
    }
    return anchor.time + ((tick - anchor.tick) * (anchor.usPerQuarter / 1e6)) / division;
  };
}
