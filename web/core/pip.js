// GAMEU.EXE's confirmed 320x192 picture path, shared with the CLI extraction algorithm.
// intro0–5.pip use a separate, unverified intro renderer and are deliberately not decoded here.
import { decodeDirectPicture } from './ega.js';

export function decodePip(bytes, palette) {
  const offset = 0x22;
  const width = 320;
  const height = 192;
  if (bytes.length < offset + width * height / 2) throw new Error('Truncated .pip picture');
  return { width, height, rgba: decodeDirectPicture(bytes, offset, width / 16, height, palette) };
}
