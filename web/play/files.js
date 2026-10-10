// Where the game's own files come from for index.html (the same idea as gods-web's "Load folder..." button): the files are never
// bundled. In the dev server they are served from /game/ and /data/; otherwise the player picks the install folder in the browser and
// the files are matched by lower-case base name (the originals have unique names: GAMEU.EXE, INTROU.EXE, KLOGOPOU.EXE, blocks1.pak, ...).

'use strict';

const NEEDED = ['gameu.exe', 'new1.pin', 'pcmap.pap', 'level0.pin', 'autoplay.pin', 'new.pip'];

/** A `fetchBytes(url)` that answers from a picked-folder map by base name, else from the network. */
export function makeFetchBytes(picked) {
  return async (url) => {
    const name = url.split('/').pop().toLowerCase();
    if (picked && picked.has(name)) return new Uint8Array(await picked.get(name).arrayBuffer());
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** True when GAMEU.EXE and data/ are served next to the page (the dev server and `vite preview` on the project). */
export async function servedHere() {
  try {
    const [a, b] = await Promise.all([fetch('/game/GAMEU.EXE', { method: 'HEAD' }), fetch('/data/new1.pin', { method: 'HEAD' })]);
    const type = (r) => r.headers.get('content-type') || '';
    return a.ok && b.ok && !type(a).includes('text/html') && !type(b).includes('text/html'); // a SPA fallback answers 200 with HTML
  } catch { return false; }
}

/** Map<lower-case base name, File> from an <input webkitdirectory> selection. */
export function mapFolder(fileList) {
  const map = new Map();
  for (const f of fileList) map.set(f.name.toLowerCase(), f);
  return map;
}

/** Which of the files every start needs are missing from a picked folder. */
export function missingFiles(map) { return NEEDED.filter((n) => !map.has(n)); }
