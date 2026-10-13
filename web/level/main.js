// The classic level viewer, reading the user's own game files in the browser (no build/ output): .pap maps, blocksN.pak tile sheets,
// level-script .pin entity placements and the sprite banks entity-shapes.json points at are depacked and decoded here (web/core, web/loader).
import entityShapes from '../../symbols/entity-shapes.json';
import { AssetCache } from '../loader/asset-cache.js';
import { sourceFromFileList, sourceFromFetch } from '../loader/asset-source.js';
import { WORLD_PALETTES } from '../core/palette.js';

const $ = (id) => document.getElementById(id);
const levelSelect = $('levelSelect'), tilesetSelect = $('tilesetSelect'), entitySelect = $('entitySelect'), entityToggle = $('entityToggle');
const zoomInput = $('zoom'), zoomLabel = $('zoomLabel'), statusEl = $('status'), canvas = $('canvas'), ctx = canvas.getContext('2d'), tip = $('tip');
const TIP_DEFAULT = tip.textContent;
const LEVEL_SCRIPT_FILES = ['level0.pin', 'new1.pin', 'level2.pin', 'level3a.pin', 'level3b.pin', 'level3c.pin', 'level4.pin'];

let cache = null, names = new Set();
let currentGrid = null; // {width, height, rows}
let currentAtlas = null; // {meta:{tileWidth,tileHeight,cols,tileCount}, image: canvas}
let currentEntities = null; // {entities: [...]}
let loadedAtlases = {}; // "kidx2" -> {meta, image}
let atlasWorldLoaded = null;

const setStatus = (msg, isError) => { statusEl.textContent = msg; statusEl.className = isError ? 'error' : ''; };
const colorForType = (type) => `hsl(${(type * 47) % 360}, 85%, 60%)`;
const worldOf = (name) => { const m = name.match(/([1-4])/); return m ? Number(m[1]) : null; };
// blocksN / nastyN / kidxN / extraxN / specialN belong to world N's palette; the shared banks use world 1 (as tools/build-all.js did)
const paletteFor = (base) => { const m = base.match(/^(?:blocks|nasty|kidx|extrax|special)([1-4])$/); return WORLD_PALETTES[m ? `world${m[1]}` : 'world1']; };

/** A decoded .pak as one sheet canvas (tiles laid out left to right, 10 per row) plus the metadata the renderer indexes it by. */
async function loadAtlas(base) {
  const pak = await cache.getPak(`${base}.pak`, paletteFor(base));
  const cols = 10, rows = Math.ceil(pak.tileCount / cols);
  const image = document.createElement('canvas');
  image.width = cols * pak.tileWidth; image.height = rows * pak.tileHeight;
  const c = image.getContext('2d');
  pak.tiles.forEach((rgba, i) => {
    c.putImageData(new ImageData(new Uint8ClampedArray(rgba), pak.tileWidth, pak.tileHeight), (i % cols) * pak.tileWidth, Math.floor(i / cols) * pak.tileHeight);
  });
  return { meta: { tileWidth: pak.tileWidth, tileHeight: pak.tileHeight, cols, tileCount: pak.tileCount }, image };
}

function guessTileset(levelName) { const w = worldOf(levelName); return w && names.has(`blocks${w}.pak`) ? `blocks${w}` : null; }
function guessEntityScript(levelName) {
  const w = worldOf(levelName);
  if (!w) return '';
  const candidates = scripts().filter((n) => worldOf(n) === w);
  return candidates.find((n) => n === levelName) || candidates[0] || '';
}
const scripts = () => LEVEL_SCRIPT_FILES.filter((f) => names.has(f)).map((f) => f.replace(/\.pin$/, ''));

async function loadLevel(levelName) {
  const pap = await cache.getPap(`${levelName}.pap`);
  const rows = [];
  for (let r = 0; r < pap.size; r++) rows.push(pap.grid.subarray(r * pap.size, (r + 1) * pap.size));
  currentGrid = { width: pap.size, height: pap.size, rows };
}
async function loadEntities(name) { currentEntities = name ? await cache.getLevelScript(`${name}.pin`) : null; }

// Loads every tile atlas any bankAtlas entry references for the world. Best effort per file: a missing atlas makes the entities that use it dots.
async function loadSpriteAtlasesForWorld(world) {
  if (!world) return;
  const worldChanged = atlasWorldLoaded !== world;
  atlasWorldLoaded = world;
  const files = new Set();
  for (const atlas of Object.values(entityShapes.bankAtlas || {})) for (const part of atlas.parts) files.add(part.perWorld ? `${part.file}${world}` : part.file);
  await Promise.all([...files].map(async (name) => {
    if (loadedAtlases[name] && !(worldChanged && /[1-4]$/.test(name))) return;
    try { loadedAtlases[name] = await loadAtlas(name); } catch { delete loadedAtlases[name]; }
  }));
}

// {atlas, tileIndex} for entities whose shape has a confirmed direct animStart -> tile mapping (frameSourceMode 1, or bank 6), else null (a dot).
function resolveEntitySprite(entity) {
  if (entity.type == null || entity.type >= entityShapes.descriptors.length) return null;
  const desc = entityShapes.descriptors[entity.type];
  const atlasSpec = entityShapes.bankAtlas[desc.bankId];
  if (!atlasSpec) return null;
  if (desc.bankId !== 6 && desc.frameSourceMode !== 1) return null;
  let tileIndex = desc.animStart;
  for (const part of atlasSpec.parts) {
    if (tileIndex < part.tiles) {
      const atlas = loadedAtlases[part.perWorld ? `${part.file}${atlasWorldLoaded}` : part.file];
      return atlas ? { atlas, tileIndex } : null;
    }
    tileIndex -= part.tiles;
  }
  return null;
}

function render() {
  if (!currentGrid || !currentAtlas) return;
  const { width, height, rows } = currentGrid;
  const { tileWidth, tileHeight, cols, tileCount } = currentAtlas.meta;
  canvas.width = width * tileWidth; canvas.height = height * tileHeight;
  ctx.imageSmoothingEnabled = false;
  let outOfRange = 0;
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const tileIndex = rows[row][col] - 1; // 1-based on-disk index -> 0-based
    if (tileIndex < 0 || tileIndex >= tileCount) { outOfRange++; continue; }
    ctx.drawImage(currentAtlas.image, (tileIndex % cols) * tileWidth, Math.floor(tileIndex / cols) * tileHeight, tileWidth, tileHeight, col * tileWidth, row * tileHeight, tileWidth, tileHeight);
  }
  let entityStatus = '';
  if (currentEntities && entityToggle.checked) {
    let drawn = 0, offMap = 0, sprited = 0;
    for (const e of currentEntities.entities) {
      if (e.x === undefined || e.y === undefined) continue;
      if (e.x < -500 || e.x > canvas.width + 500 || e.y < -500 || e.y > canvas.height + 500) { offMap++; continue; }
      drawn++;
      const resolved = resolveEntitySprite(e);
      if (resolved) {
        sprited++;
        const { atlas, tileIndex } = resolved;
        const { tileWidth: tw, tileHeight: th, cols: acols } = atlas.meta;
        ctx.drawImage(atlas.image, (tileIndex % acols) * tw, Math.floor(tileIndex / acols) * th, tw, th, e.x, e.y, tw, th);
      } else {
        ctx.beginPath(); ctx.arc(e.x, e.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = colorForType(e.type); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
      }
    }
    entityStatus = ` -- ${drawn} entities shown (${sprited} real sprites, ${drawn - sprited} dots, ${offMap} far off-map)`;
  }
  const zoom = Number(zoomInput.value);
  canvas.style.width = `${canvas.width * zoom}px`; canvas.style.height = `${canvas.height * zoom}px`;
  setStatus(`${width}x${height} tiles (${canvas.width}x${canvas.height}px) -- ${tilesetSelect.value}.pak (${tileCount} tiles, ${tileWidth}x${tileHeight})` +
    (outOfRange ? ` -- ${outOfRange} cell(s) out of tileset range!` : '') + entityStatus, outOfRange > 0);
}

async function onTilesetChangeInner() { currentAtlas = await loadAtlas(tilesetSelect.value); render(); }
async function onLevelChange() {
  const levelName = levelSelect.value;
  const ts = guessTileset(levelName);
  if (ts && [...tilesetSelect.options].some((o) => o.value === ts)) tilesetSelect.value = ts;
  const es = guessEntityScript(levelName);
  if ([...entitySelect.options].some((o) => o.value === es)) entitySelect.value = es;
  setStatus(`loading ${levelName}...`);
  try {
    await loadLevel(levelName); await loadEntities(entitySelect.value);
    await loadSpriteAtlasesForWorld(worldOf(levelName)); await onTilesetChangeInner();
  } catch (e) { setStatus(String(e.message || e), true); }
}

canvas.addEventListener('mousemove', (ev) => {
  if (!currentGrid || !currentAtlas) return;
  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) * (canvas.width / rect.width), py = (ev.clientY - rect.top) * (canvas.height / rect.height);
  if (currentEntities && entityToggle.checked) {
    const hit = currentEntities.entities.find((e) => e.x !== undefined && Math.hypot(e.x - px, e.y - py) <= 6);
    if (hit) { tip.textContent = `entity type ${hit.type} at (${hit.x}, ${hit.y}) -- file offset 0x${hit.offset.toString(16)}, layout-selector ${hit.bx}, payload [${hit.payload.join(', ')}]`; return; }
  }
  const col = Math.floor(px / currentAtlas.meta.tileWidth), row = Math.floor(py / currentAtlas.meta.tileHeight);
  if (row >= 0 && row < currentGrid.height && col >= 0 && col < currentGrid.width) {
    const value = currentGrid.rows[row][col];
    tip.textContent = `row ${row}, col ${col} -- tile value ${value} (atlas index ${value - 1})`;
  }
});
canvas.addEventListener('mouseleave', () => { tip.textContent = TIP_DEFAULT; });
zoomInput.addEventListener('input', () => { zoomLabel.textContent = `${Math.round(Number(zoomInput.value) * 100)}%`; render(); });
levelSelect.addEventListener('change', onLevelChange);
tilesetSelect.addEventListener('change', async () => { setStatus(`loading ${tilesetSelect.value}...`); try { await onTilesetChangeInner(); } catch (e) { setStatus(String(e.message || e), true); } });
entitySelect.addEventListener('change', async () => { try { await loadEntities(entitySelect.value); render(); } catch (e) { setStatus(String(e.message || e), true); } });
entityToggle.addEventListener('change', render);

const fill = (select, items, label) => { select.replaceChildren(); for (const [value, text] of items) { const o = document.createElement('option'); o.value = value; o.textContent = text ?? value; select.append(o); } if (label) { const o = document.createElement('option'); o.value = ''; o.textContent = label; select.prepend(o); } };

async function useSource(source, label) {
  cache = new AssetCache(source); names = new Set(source.keys()); loadedAtlases = {}; atlasWorldLoaded = null;
  const levels = [...names].filter((n) => n.endsWith('.pap')).map((n) => n.replace(/\.pap$/, '')).sort();
  const tilesets = [...names].filter((n) => /^blocks[1-4]\.pak$/.test(n)).map((n) => n.replace(/\.pak$/, '')).sort();
  if (!levels.length || !tilesets.length) { setStatus('No .pap level maps or blocksN.pak tile sheets in that folder. Pick the folder with your Magic Pockets data files.', true); return false; }
  fill(levelSelect, levels.map((n) => [n, worldOf(n) ? `${n}  (world ${worldOf(n)})` : n]));
  fill(tilesetSelect, tilesets.map((n) => [n]));
  fill(entitySelect, scripts().map((n) => [n, `${n}  (world ${worldOf(n) ?? '-'})`]), '(none)');
  $('btnFolder').textContent = `Game files: ${label} (change…)`;
  await onLevelChange();
  return true;
}

async function init() {
  $('btnFolder').onclick = () => $('inpFolder').click();
  $('inpFolder').onchange = async () => { const files = [...$('inpFolder').files]; if (files.length) await useSource(sourceFromFileList(files), 'your folder'); };
  try { // the dev server lists data/ itself
    const response = await fetch('/api/assets', { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('no local catalog');
    const files = await response.json();
    if (await useSource(sourceFromFetch('/data', files.map((f) => f.name)), 'data/')) return;
  } catch { /* hosted: ask for the folder */ }
  setStatus('Choose the folder with your copy of Magic Pockets (the data files: .pap, .pak, .pin). The files are read in your browser and never uploaded.');
}
init();
