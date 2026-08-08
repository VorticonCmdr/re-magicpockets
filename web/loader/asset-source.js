// Abstracts "where do original game file bytes come from" behind one interface: a
// Map<lowercased-filename, () => Promise<Uint8Array>>. Two concrete sources; the engine only
// ever talks to the Map, never to File/fetch directly, so it doesn't care which one is active.

'use strict';

/** User-picked local folder (original, unmodified data/ directory) via <input webkitdirectory>. */
export function sourceFromFileList(fileList) {
  const map = new Map();
  for (const file of fileList) {
    // webkitdirectory gives paths like "data/blocks1.pak"; only the basename matters to us.
    const name = file.name.toLowerCase();
    map.set(name, () => file.arrayBuffer().then((ab) => new Uint8Array(ab)));
  }
  return map;
}

/** Dev-server fallback: fetch() straight from a served data/ directory (see tools/serve.js). */
export function sourceFromFetch(baseUrl, filenames) {
  const map = new Map();
  for (const name of filenames) {
    map.set(name.toLowerCase(), async () => {
      const res = await fetch(`${baseUrl}/${name}`);
      if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  }
  return map;
}
