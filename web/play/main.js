// index.html: play the port. The game flow (logo, intro, world intros, levels, GAME OVER, ...) is web/demo/game.js; this page adds the
// shell around it: file loading (served files or "Load folder..."), a scale selector, a pause key, and a ?debug side panel.
//
//   ?nointro   start at the world 1 intro instead of the launcher's logo and intro
//   ?mute      no AdLib sound (it is on by default; browsers start audio on the first key press)
//   ?pick      always ask for the folder (the dev server would otherwise serve game/ and data/)
//   ?debug     the side panel (status line history, keys, links to the asset explorer and the level viewer)

'use strict';

import { startGame } from '../demo/game.js';
import { makeFetchBytes, servedHere, mapFolder, missingFiles } from './files.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
// Outside ?debug only errors and lines passed with show = true (things the player must act on) are visible; the running tick/score line is not.
const setStatus = (msg, err = false, show = false) => { statusEl.textContent = msg; statusEl.className = err ? 'error' : show ? 'show' : ''; log(msg); };
const history = [];
let lastKey = '';
function log(msg) { const key = msg.replace(/[0-9]+/g, '#'); if (key !== lastKey) { lastKey = key; history.push(msg); if (history.length > 40) history.shift(); const el = $('log'); if (el) el.textContent = history.join('\n'); } }

const canvas = $('screen');
const params = new URLSearchParams(location.search);
if (params.has('debug')) document.documentElement.classList.add('debug');
const gameParams = new URLSearchParams(location.search);
if (!gameParams.has('nointro')) gameParams.set('intro', '');
if (!gameParams.has('mute')) gameParams.set('sound', '');

// ---- scale: the largest size that fits the view, or a fixed 1x..4x; remembered ----
const sel = $('scale'), view = $('view');
try { const s = localStorage.getItem('mp.scale'); if (s && sel.querySelector(`option[value="${s}"]`)) sel.value = s; } catch { /* storage may be blocked */ }
function fit() {
  const w = canvas.width, h = canvas.height;
  const max = sel.value === 'max';
  view.style.overflow = max ? 'hidden' : 'auto';
  const k = max ? Math.min(view.clientWidth / w, view.clientHeight / h) : Number(sel.value);
  canvas.style.width = `${Math.floor(w * k)}px`;
  canvas.style.height = `${Math.floor(h * k)}px`;
}
sel.onchange = () => { try { localStorage.setItem('mp.scale', sel.value); } catch { /* ignore */ } sel.blur(); fit(); };
new ResizeObserver(fit).observe(view);
new MutationObserver(fit).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] }); // the game switches between 320x192 and 320x200
fit();

// ---- files ----
async function chooseSource() {
  if (!params.has('pick') && await servedHere()) return { fetchBytes: makeFetchBytes(null) }; // ?pick forces the folder picker even when the files are served
  const btn = $('btnFolder'), input = $('inpFolder');
  btn.hidden = false;
  setStatus('Pick the folder with your copy of Magic Pockets (it holds GAMEU.EXE, INTROU.EXE, KLOGOPOU.EXE and the data/ files). Nothing is uploaded.', false, true);
  btn.onclick = () => input.click();
  return new Promise((resolve) => {
    input.onchange = () => {
      const map = mapFolder(input.files);
      const missing = missingFiles(map);
      if (missing.length) { setStatus(`That folder lacks ${missing.join(', ')}. Pick the folder that contains GAMEU.EXE and the data files (the parent of data/ also works).`, true); return; }
      btn.hidden = true;
      resolve({ fetchBytes: makeFetchBytes(map) });
    };
  });
}

async function main() {
  const { fetchBytes } = await chooseSource();
  setStatus('loading the game files...');
  const exe = await fetchBytes('/game/GAMEU.EXE');
  await startGame({ exe, fetchBytes, canvas, setStatus, params: gameParams });
  canvas.focus?.();
}
main().catch((err) => { console.error(err); setStatus(`Could not start: ${err.message}`, true); });
