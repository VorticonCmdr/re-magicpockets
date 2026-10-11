import { AssetCache } from '../loader/asset-cache.js';
import { sourceFromFileList, sourceFromFetch } from '../loader/asset-source.js';
import { WORLD_PALETTES } from '../core/palette.js';
import { decodePak } from '../core/pak.js';
import { decodePip } from '../core/pip.js';
import { decodePap } from '../core/pap.js';
import { decodeLevelScript } from '../core/pin-level-script.js';
import { decodePinSoundBank, extractCue } from '../core/pin-sound.js';
import { parseMidi, makeTickToSeconds } from '../core/midi.js';
import { playMidi } from '../audio/synth.js';
import { buildBackgroundCanvas, tileToCanvas, drawEntitiesLive, loadSpritePaks } from '../render/canvas.js';
import entityShapes from '../../symbols/entity-shapes.json';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size = (n) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const hex = (n) => `0x${n.toString(16).padStart(4, '0')}`;
const categories = [
  ['all', 'All assets', '◈', 'Sprites, worlds, pictures, and the sounds between them.'],
  ['sprites', 'Sprites & tiles', '▦', 'Characters, creatures, effects, and the pieces of each world.'],
  ['maps', 'Level maps', '▧', 'Explore the original tile maps, from caves to the final world.'],
  ['pictures', 'Pictures', '▣', 'Full-screen artwork from the original game.'],
  ['audio', 'MIDI & sounds', '♫', 'Listen to the recovered music and sound-effect cues.'],
  ['scripts', 'Level scripts', '≡', 'Inspect entity placements, sublevel records, and control markers.'],
  ['other', 'Other files', '◇', 'Files whose contents do not yet have a supported decoder.'],
];
const scriptNames = /^(level0|new1|level2|level3[abc]|level4)\.pin$/;
const bankNames = /^(adlib|roland|roland2|soundbnk)\.pin$/;
let assets = [], selected = null, cache, category = 'all', sourceEpoch = 0, detailEpoch = 0;
let paletteName = 'world1', previewCanvas = null, spriteIndex = 0;
let audioContext, audioMaster, playback, playbackTimer, currentTrack, trackStarted = 0, trackDuration = 0, audioEpoch = 0;
const stored = (name, fallback) => { try { return localStorage.getItem(name) || fallback; } catch { return fallback; } };
const remember = (name, value) => { try { localStorage.setItem(name, value); } catch { /* private browsing */ } };
$('volume').value = stored('mp-volume', '0.35');

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
function kind(name) {
  if (/\.pak$/i.test(name)) return 'sprites';
  if (/\.pap$/i.test(name)) return 'maps';
  if (/\.pip$/i.test(name)) return 'pictures';
  if (scriptNames.test(name)) return 'scripts';
  if (bankNames.test(name) || /\.mid$/i.test(name)) return 'audio';
  return 'other';
}
function worldFor(name) {
  return /^(?:blocks|nasty|kidx|extrax|special|level)([1-4])/.exec(name)?.[1] || (name === 'new1.pin' ? '1' : 'shared');
}
function categoryLabel(id) { return categories.find((c) => c[0] === id)[1]; }
function imageCanvas(rgba, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas;
}
function atlasCanvas(pak) {
  const columns = Math.min(12, pak.tileCount), gap = 2;
  const canvas = document.createElement('canvas');
  canvas.width = columns * (pak.tileWidth + gap) + gap;
  canvas.height = Math.ceil(pak.tileCount / columns) * (pak.tileHeight + gap) + gap;
  const ctx = canvas.getContext('2d');
  pak.tiles.forEach((rgba, index) => ctx.drawImage(tileToCanvas(rgba, pak.tileWidth, pak.tileHeight), gap + (index % columns) * (pak.tileWidth + gap), gap + Math.floor(index / columns) * (pak.tileHeight + gap)));
  return canvas;
}
function cloneCanvas(original) {
  const canvas = document.createElement('canvas');
  canvas.width = original.width; canvas.height = original.height;
  canvas.getContext('2d').drawImage(original, 0, 0);
  return canvas;
}
function thumbnail(original) {
  const canvas = document.createElement('canvas');
  const ratio = Math.min(1, 360 / original.width, 180 / original.height);
  canvas.width = Math.max(1, Math.round(original.width * ratio));
  canvas.height = Math.max(1, Math.round(original.height * ratio));
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
  return canvas;
}
function paletteFor(asset) { return `world${asset.world === 'shared' ? 1 : asset.world}`; }

async function decode(asset) {
  asset.raw = await cache.getRaw(asset.name);
  const palette = WORLD_PALETTES[paletteFor(asset)];
  if (asset.kind === 'sprites') {
    asset.decoded = decodePak(asset.name, asset.raw, palette);
    asset.summary = `${asset.decoded.tileCount} tiles · ${asset.decoded.tileWidth}×${asset.decoded.tileHeight}`;
    asset.thumbnail = thumbnail(atlasCanvas(asset.decoded));
  } else if (asset.kind === 'maps') {
    asset.decoded = decodePap(asset.raw);
    asset.summary = '128×128 tiles · 4096×2048 px';
    // Render a tiny overview directly, rather than keeping 10 full 32 MB map canvases alive.
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    const pakName = `blocks${asset.world === 'shared' ? 1 : asset.world}.pak`;
    if (cache.has(pakName)) {
      const pak = await cache.getPak(pakName, palette);
      for (let i = 0; i < asset.decoded.grid.length; i++) {
        const tile = pak.tiles[asset.decoded.grid[i] - 1];
        if (tile) ctx.drawImage(tileToCanvas(tile, pak.tileWidth, pak.tileHeight), (i % 128) * 4, Math.floor(i / 128) * 2, 4, 2);
      }
    } else {
      const pixels = ctx.createImageData(128, 128);
      asset.decoded.grid.forEach((value, i) => { pixels.data.set([value * 2, 110, 70, 255], i * 4); });
      const temp = document.createElement('canvas'); temp.width = temp.height = 128;
      temp.getContext('2d').putImageData(pixels, 0, 0); ctx.drawImage(temp, 0, 0, 512, 256);
    }
    asset.thumbnail = thumbnail(canvas);
  } else if (asset.kind === 'pictures') {
    if (!/^(new|endscrn)\.pip$/.test(asset.name)) {
      asset.state = 'unsupported'; asset.summary = 'Intro picture · format unverified';
      asset.reason = 'This picture belongs to INTRO.EXE. Its rendering path has not been verified; the game-picture decoder is not assumed to apply.';
      return;
    }
    asset.decoded = decodePip(asset.raw, palette);
    asset.thumbnail = thumbnail(imageCanvas(asset.decoded.rgba, 320, 192));
    asset.summary = '320×192 pixels · 16 colors';
  } else if (asset.kind === 'audio') {
    if (/\.mid$/.test(asset.name)) {
      asset.bank = null; asset.cues = [{ index: 0, bytes: asset.raw }];
    } else {
      asset.bank = decodePinSoundBank(asset.raw);
      if (!asset.bank) throw new Error('No supported MIDI resource table found');
      asset.cues = asset.bank.entries.filter((e) => e.midiLength != null).map((e) => ({ index: e.index, bytes: extractCue(asset.bank, e.index) }));
    }
    for (const cue of asset.cues) {
      const parsed = parseMidi(cue.bytes), toSeconds = makeTickToSeconds(parsed.tempoEvents, parsed.division);
      const lastTick = Math.max(0, ...parsed.tracks.flat().map((e) => e.tick));
      cue.duration = toSeconds(lastTick); cue.notes = parsed.tracks.flat().filter((e) => e.type === 0x90 && e.data2 > 0).length;
    }
    asset.summary = `${asset.cues.length} MIDI ${asset.cues.length === 1 ? 'track' : 'cues'}`;
  } else if (asset.kind === 'scripts') {
    asset.decoded = decodeLevelScript(asset.raw);
    asset.summary = `${asset.decoded.sublevels.length} entries · ${asset.decoded.entities.length} entities`;
  } else {
    asset.state = 'unsupported'; asset.summary = /\.pin$/.test(asset.name) ? 'Driver / undecoded payload' : 'Supporting file';
    asset.reason = /\.pin$/.test(asset.name) ? 'This file contains driver code or a sound/data format without a supported asset decoder. You can inspect and download its decompressed bytes.' : 'This supporting file has no visual or audio decoder. Its bytes are available for inspection and download.';
    return;
  }
  asset.state = 'ready';
}

async function setSource(files, source, label) {
  const epoch = ++sourceEpoch;
  ++detailEpoch; stopAudio(); selected = null; previewCanvas = null;
  if ($('expanded').open) $('expanded').close();
  $('inspector').innerHTML = '<div class="inspector-empty"><span>✦</span><h2>Opening the collection…</h2><p>Decoding original game files.</p></div>';
  cache = new AssetCache(source);
  assets = files.map((file) => ({ name: file.name.toLowerCase(), size: file.size, kind: kind(file.name.toLowerCase()), world: worldFor(file.name.toLowerCase()), state: 'loading', summary: 'Decoding…' })).sort((a, b) => a.name.localeCompare(b.name));
  $('source-label').textContent = label; renderCategories(); renderCards();
  let done = 0;
  const sourceCache = cache;
  for (const asset of assets) {
    if (epoch !== sourceEpoch) return;
    try { await decode(asset); } catch (error) { asset.state = 'error'; asset.summary = 'Could not decode'; asset.reason = error.message; }
    if (epoch !== sourceEpoch || sourceCache !== cache) return;
    done++;
    notice(`Opening collection · ${done} / ${files.length} files`);
    if (done % 8 === 0) { renderCards(); await new Promise((resolve) => setTimeout(resolve, 0)); }
  }
  renderCategories(); renderCards();
  const ready = assets.filter((a) => a.state === 'ready').length, errors = assets.filter((a) => a.state === 'error').length;
  notice(`${assets.length} files · ${ready} decoded · ${assets.length - ready - errors} without a verified decoder${errors ? ` · ${errors} decode errors` : ''}. Browse a category or select any file to inspect it.`, errors > 0);
  if (!assets.length) notice('No local assets found. Choose the folder containing your original .pak, .pap, .pip, and .pin files.');
  const remembered = stored('mp-selected', 'bitkid.pak');
  const first = selected || assets.find((a) => a.name === remembered && a.state === 'ready') || assets.find((a) => a.state === 'ready');
  if (first) selectAsset(first);
}
async function loadLocal() {
  const epoch = ++sourceEpoch;
  notice('Looking for original files in the local data folder…');
  try {
    const response = await fetch('/api/assets', { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('No local asset catalog');
    const files = await response.json();
    if (epoch !== sourceEpoch) return;
    await setSource(files, sourceFromFetch('/data', files.map((f) => f.name)), 'Local data folder');
  } catch (error) {
    if (epoch !== sourceEpoch) return;
    $('source-label').textContent = 'Choose your original files';
    notice('Choose your original asset folder to begin. A local Vite server also discovers files in data/ automatically.');
    renderCategories(); renderCards();
  }
}
function renderCategories() {
  $('categories').replaceChildren();
  categories.forEach(([id, label, icon]) => {
    const button = document.createElement('button'); button.classList.toggle('active', category === id);
    button.setAttribute('aria-pressed', String(category === id));
    button.innerHTML = `<span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span><span class="nav-count">${assets.filter((a) => id === 'all' || a.kind === id).length}</span>`;
    button.onclick = () => { category = id; renderCategories(); renderCards(); };
    $('categories').append(button);
  });
  const entry = categories.find((c) => c[0] === category);
  $('collection-title').textContent = entry[1]; $('collection-description').textContent = entry[3];
  $('collection-total').textContent = assets.filter((a) => category === 'all' || a.kind === category).length.toString().padStart(2, '0');
}
function filteredAssets() {
  const search = $('search').value.toLowerCase().trim(), world = $('world').value;
  return assets.filter((a) => (category === 'all' || a.kind === category) && (world === 'all' || a.world === world) && `${a.name} ${a.summary}`.toLowerCase().includes(search)).sort((a, b) => $('sort').value === 'size' ? b.size - a.size : $('sort').value === 'kind' ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
}
function renderCards() {
  const list = filteredAssets();
  $('results-count').textContent = `${list.length} ${list.length === 1 ? 'asset' : 'assets'}`;
  $('cards').replaceChildren();
  if (!list.length) {
    $('cards').innerHTML = `<div class="empty-results">${assets.length ? 'No matching assets. Try another search or world.' : 'Your collection will appear here.<br><br>Choose an asset folder to get started.'}</div>`;
    return;
  }
  list.forEach((asset) => {
    const button = document.createElement('button'); button.className = 'asset-card';
    button.classList.toggle('selected', selected === asset); button.dataset.name = asset.name;
    button.setAttribute('aria-label', `${asset.name}, ${asset.summary}`); button.setAttribute('aria-pressed', String(selected === asset));
    const badge = asset.state === 'unsupported' ? 'UNVERIFIED' : asset.state === 'error' ? 'ERROR' : asset.name.split('.').pop().toUpperCase();
    button.innerHTML = `<div class="thumbnail ${asset.kind === 'audio' ? 'audio' : ''}"></div><div class="card-text"><strong>${escape(asset.name)}</strong><div class="card-meta"><span>${escape(asset.summary)}</span></div><div class="card-meta" style="margin-top:10px"><span class="badge ${asset.state === 'unsupported' || asset.state === 'error' ? 'unknown' : ''}">${badge}</span><span>${size(asset.size)}</span></div></div>`;
    const view = button.querySelector('.thumbnail');
    if (asset.thumbnail) view.append(cloneCanvas(asset.thumbnail));
    else if (asset.kind === 'audio' && asset.state === 'ready') view.innerHTML = `<div class="wave" aria-hidden="true">${Array.from({ length: 18 }, (_, i) => `<i style="height:${12 + ((i * 13 + 7) % 35)}px"></i>`).join('')}</div>`;
    else view.innerHTML = `<span class="file-symbol" aria-hidden="true">${asset.kind === 'scripts' ? '{ }' : '◇'}</span>`;
    button.onclick = () => { if (asset.state !== 'loading') selectAsset(asset, window.innerWidth < 850); };
    $('cards').append(button);
  });
}
function metadata(asset, extra = []) {
  return `<dl class="metadata">${[['File size', size(asset.size)], ['Unpacked', size(asset.raw?.length || 0)], ['Category', categoryLabel(asset.kind)], ['World', asset.world === 'shared' ? 'Shared / unknown' : asset.world], ...extra].map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`;
}
function download(bytes, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadPng(canvas, name) { canvas.toBlob((blob) => { if (blob) download(blob, name, 'image/png'); }); }
function jsonDownload(asset, value) { download(JSON.stringify(value, null, 2), `${asset.name}.json`, 'application/json'); }
function paletteControls() {
  return `<div class="controls-row"><label>Palette <select id="palette">${[1, 2, 3, 4].map((n) => `<option value="world${n}" ${paletteName === `world${n}` ? 'selected' : ''}>World ${n}</option>`).join('')}</select></label></div><div class="palette-swatches">${WORLD_PALETTES[paletteName].map((color, i) => `<i style="background:rgb(${color.join(',')})" title="Color ${i}: ${color.join(', ')}"></i>`).join('')}</div>`;
}
function previewControls() {
  return '<div id="preview" class="preview-stage checker"></div><div class="action-row"><button id="expand">Expand / zoom</button><button id="export-png">Download PNG</button></div><p id="pixel-hint" class="hint">Expand to zoom and drag around the image.</p>';
}
function showPreview(canvas) {
  previewCanvas = canvas; $('preview').replaceChildren(canvas);
  $('expand').onclick = () => {
    $('expanded-title').textContent = selected.name;
    $('expanded-stage').replaceChildren(cloneCanvas(canvas));
    $('expanded-zoom').value = canvas.width > 1000 ? '0.25' : '2'; zoomExpanded(); $('expanded').showModal();
  };
  $('export-png').onclick = () => downloadPng(canvas, `${selected.name}.png`);
}
async function selectAsset(asset, scroll = false) {
  selected = asset; paletteName = paletteFor(asset); spriteIndex = 0;
  remember('mp-selected', asset.name);
  renderCards(); await renderInspector();
  if (scroll) $('inspector').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function renderInspector() {
  const asset = selected, epoch = ++detailEpoch;
  if (!asset) return;
  $('inspector').innerHTML = `<div class="inspector-heading"><div class="eyebrow">${escape(categoryLabel(asset.kind))}</div><h2>${escape(asset.name)}</h2><p>${escape(asset.summary)}</p></div><div class="inspector-body" id="detail"></div>`;
  const detail = $('detail');
  if (asset.state !== 'ready') {
    detail.innerHTML = `<div class="${asset.state === 'error' ? 'error-detail' : 'notice'}">${escape(asset.reason || 'This file is still being decoded.')}</div><p class="hint">First 128 decompressed bytes</p><pre class="hex">${Array.from(asset.raw?.subarray(0, 128) || [], (b) => b.toString(16).padStart(2, '0')).join(' ')}</pre><div class="action-row"><button id="raw-download" ${asset.raw ? '' : 'disabled'}>Download unpacked bytes</button></div>${metadata(asset)}`;
    $('raw-download').onclick = () => download(asset.raw, `${asset.name}.raw`);
    return;
  }
  try {
    if (asset.kind === 'sprites') {
      const pak = decodePak(asset.name, asset.raw, WORLD_PALETTES[paletteName]);
      detail.innerHTML = `${paletteControls()}${previewControls()}<div class="sprite-detail"><div class="controls-row"><strong>Individual tile</strong><button id="prev-tile" aria-label="Previous tile">‹</button><label>Index <input id="tile-index" type="number" min="0" max="${pak.tileCount - 1}" value="${spriteIndex}" style="width:65px"></label><button id="next-tile" aria-label="Next tile">›</button></div><div id="single-tile" class="checker"></div><p class="hint">Indices are zero-based. Click the atlas to select a tile.</p><button id="export-tile">Download tile PNG</button></div>${metadata(asset, [['Tile count', pak.tileCount], ['Tile dimensions', `${pak.tileWidth} × ${pak.tileHeight}`]])}`;
      const canvas = atlasCanvas(pak); showPreview(canvas);
      const drawTile = () => {
        spriteIndex = Math.max(0, Math.min(pak.tileCount - 1, Number($('tile-index').value) || 0));
        $('tile-index').value = spriteIndex;
        $('single-tile').replaceChildren(imageCanvas(pak.tiles[spriteIndex], pak.tileWidth, pak.tileHeight));
        $('prev-tile').disabled = spriteIndex === 0; $('next-tile').disabled = spriteIndex === pak.tileCount - 1;
      };
      drawTile(); $('tile-index').oninput = drawTile;
      $('prev-tile').onclick = () => { $('tile-index').value = spriteIndex - 1; drawTile(); };
      $('next-tile').onclick = () => { $('tile-index').value = spriteIndex + 1; drawTile(); };
      $('export-tile').onclick = () => downloadPng($('single-tile').firstChild, `${asset.name}.tile-${spriteIndex}.png`);
      canvas.onclick = (event) => {
        const box = canvas.getBoundingClientRect();
        const x = (event.clientX - box.left) * canvas.width / box.width, y = (event.clientY - box.top) * canvas.height / box.height;
        const index = Math.floor((y - 2) / (pak.tileHeight + 2)) * Math.min(12, pak.tileCount) + Math.floor((x - 2) / (pak.tileWidth + 2));
        if (index >= 0 && index < pak.tileCount) { $('tile-index').value = index; drawTile(); }
      };
    } else if (asset.kind === 'pictures') {
      const picture = decodePip(asset.raw, WORLD_PALETTES[paletteName]);
      detail.innerHTML = `${paletteControls()}${previewControls()}${metadata(asset, [['Dimensions', '320 × 192'], ['Colors', 16]])}`;
      showPreview(imageCanvas(picture.rgba, picture.width, picture.height));
    } else if (asset.kind === 'maps') {
      const tilesets = assets.filter((a) => /^blocks[1-4]\.pak$/.test(a.name) && a.state === 'ready');
      const scripts = assets.filter((a) => a.kind === 'scripts' && a.state === 'ready');
      const defaultTileset = asset.view?.tileset || tilesets.find((a) => a.world === asset.world)?.name || tilesets[0]?.name;
      const defaultScript = asset.view?.script ?? (scripts.find((a) => a.name === asset.name.replace('.pap', '.pin'))?.name || scripts.find((a) => a.world === asset.world)?.name);
      detail.innerHTML = `${paletteControls()}<div class="controls-row"><label>Tileset <select id="map-tileset">${tilesets.map((a) => `<option ${a.name === defaultTileset ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select></label></div><div class="controls-row"><label><input id="show-entities" type="checkbox"> Entities</label><select id="map-script" aria-label="Entity script"><option value="">None</option>${scripts.map((a) => `<option ${a.name === defaultScript ? 'selected' : ''}>${escape(a.name)}</option>`).join('')}</select></div>${previewControls()}<p class="hint">Tileset and script pairing are inferred from filenames; override them to compare. Shared maps have no confirmed world pairing. Entity coordinates are shown as decoded.</p><button id="map-json">Download tile grid JSON</button>${metadata(asset, [['Grid', '128 × 128'], ['Dimensions', '4096 × 2048']])}`;
      const draw = async () => {
        const chosenPak = $('map-tileset').value, scriptName = $('map-script').value, withEntities = $('show-entities').checked;
        asset.view = { tileset: chosenPak, script: scriptName, entities: withEntities };
        const token = ++detailEpoch;
        if (!chosenPak) { $('preview').textContent = 'Choose a folder containing blocks1–4.pak to render this map.'; $('expand').disabled = $('export-png').disabled = true; return; }
        try {
          const pak = await cache.getPak(chosenPak, WORLD_PALETTES[paletteName]);
          if (token !== detailEpoch) return;
          const canvas = buildBackgroundCanvas(pak, asset.decoded);
          if (withEntities && scriptName) {
            const world = Number(/blocks([1-4])/.exec(chosenPak)[1]);
            const spritePaks = await loadSpritePaks(cache, entityShapes, world, WORLD_PALETTES[paletteName]);
            if (token !== detailEpoch) return;
            const script = assets.find((a) => a.name === scriptName);
            drawEntitiesLive(canvas.getContext('2d'), script.decoded.entities, entityShapes, spritePaks, world, { x: 0, y: 0 }, canvas.width, canvas.height);
          }
          showPreview(canvas);
          canvas.onmousemove = (event) => {
            const box = canvas.getBoundingClientRect(), col = Math.floor((event.clientX - box.left) / box.width * 128), row = Math.floor((event.clientY - box.top) / box.height * 128);
            $('pixel-hint').textContent = `Column ${col}, row ${row} · tile value ${asset.decoded.grid[row * 128 + col]} · expand for a closer look.`;
          };
        } catch (error) { if (token === detailEpoch) $('preview').textContent = error.message; }
      };
      $('map-tileset').onchange = draw; $('map-script').onchange = draw; $('show-entities').onchange = draw;
      $('show-entities').checked = asset.view?.entities || false;
      $('map-json').onclick = () => jsonDownload(asset, { width: 128, height: 128, grid: Array.from(asset.decoded.grid) });
      await draw();
    } else if (asset.kind === 'scripts') {
      const data = asset.decoded;
      detail.innerHTML = `<div class="controls-row"><label>Entry <select id="script-entry"><option value="all">All unique records</option>${data.sublevels.map((sl) => `<option value="${sl.sublevelIndex}">${sl.sublevelIndex} · ${hex(sl.startOffset)}</option>`).join('')}</select></label></div><div id="script-summary" class="hint"></div><div class="table-wrap"><table><thead><tr><th>Offset</th><th>Type</th><th>X</th><th>Y</th><th>Layout</th></tr></thead><tbody id="script-records"></tbody></table></div><p class="hint">Hover a record for its raw payload. Positions can be off-map; these values are not verified player spawn locations.</p><div class="action-row"><button id="script-json">Download decoded JSON</button><button id="raw-download">Unpacked bytes</button></div>${metadata(asset, [['Entry points', data.sublevels.length], ['Unique entities', data.entities.length]])}`;
      const records = () => {
        const index = $('script-entry').value, sl = index === 'all' ? null : data.sublevels[Number(index)];
        $('script-summary').textContent = sl ? `${sl.entities.length} entities · ${sl.events.length} control markers · terminal ${sl.terminal}` : `${data.entities.length} unique entities across ${data.sublevels.length} overlapping entry points`;
        $('script-records').innerHTML = (sl?.entities || data.entities).map((record) => `<tr title="Payload: ${escape(record.payload.map(hex).join(' '))}"><td>${hex(record.offset)}</td><td>${record.type}</td><td>${record.x ?? '—'}</td><td>${record.y ?? '—'}</td><td>${record.bx}</td></tr>`).join('');
        const events = sl?.events || [...new Map(data.sublevels.flatMap((entry) => entry.events).map((event) => [event.offset, event])).values()];
        let markers = $('script-markers');
        if (!markers) {
          markers = document.createElement('div'); markers.id = 'script-markers';
          $('script-records').closest('.table-wrap').after(markers);
        }
        markers.innerHTML = `<p class="hint">Control markers (${events.length})</p><div class="table-wrap" style="max-height:160px"><table><thead><tr><th>Offset</th><th>Marker</th><th>Value</th></tr></thead><tbody>${events.map((event) => `<tr><td>${hex(event.offset)}</td><td>${event.kind}</td><td>${event.arg ?? event.waitTarget ?? '—'}</td></tr>`).join('')}</tbody></table></div>`;
      };
      records(); $('script-entry').onchange = records;
      $('script-json').onclick = () => jsonDownload(asset, data); $('raw-download').onclick = () => download(asset.raw, `${asset.name}.raw`);
    } else if (asset.kind === 'audio') {
      renderAudio(asset, detail);
    }
    if ($('palette')) $('palette').onchange = () => { paletteName = $('palette').value; renderInspector(); };
  } catch (error) {
    if (epoch === detailEpoch) detail.innerHTML = `<div class="error-detail">${escape(error.message)}</div>`;
  }
}

function renderAudio(asset, detail) {
  detail.innerHTML = `<div class="action-row"><button id="play-bank">▶ Play all cues</button><button id="stop-bank">Stop</button></div><p class="hint">A lightweight MIDI synth previews the recovered notes. Original AdLib / MT-32 instrument timbres are not emulated. Cue IDs preserve their original table positions.</p><input id="cue-search" class="cue-filter" type="search" placeholder="Filter by cue ID…" aria-label="Filter MIDI cues"><div class="table-wrap"><table><thead><tr><th>Cue</th><th>Length</th><th>Notes</th><th>Listen</th><th>Save</th></tr></thead><tbody id="cue-rows"></tbody></table></div>${asset.bank && asset.bank.count !== asset.cues.length ? `<p class="hint">${asset.bank.count - asset.cues.length} non-MIDI table entries cannot be played.</p>` : ''}${asset.name === 'soundbnk.pin' ? '<p class="hint">Only a tiny embedded MIDI track is decoded. Most of this file remains unidentified trailing data.</p>' : ''}${metadata(asset, [['Playable cues', asset.cues.length], ['Container entries', asset.bank?.count || 1]])}`;
  const rows = () => {
    const search = $('cue-search').value.trim();
    $('cue-rows').replaceChildren();
    asset.cues.filter((cue) => String(cue.index).includes(search)).forEach((cue) => {
      const row = document.createElement('tr'); row.dataset.cue = cue.index;
      row.classList.toggle('playing', currentTrack?.asset === asset && currentTrack.cue === cue);
      row.innerHTML = `<td class="cue-title">${String(cue.index).padStart(2, '0')}</td><td>${cue.duration.toFixed(2)}s</td><td>${cue.notes}</td><td><button class="play-cue" aria-label="Play cue ${cue.index}">▶</button></td><td><button class="save-cue" aria-label="Download cue ${cue.index}">↓ MIDI</button></td>`;
      row.querySelector('.play-cue').onclick = () => startAudio(asset, cue);
      row.querySelector('.save-cue').onclick = () => download(cue.bytes, `${asset.name}.cue-${cue.index}.mid`, 'audio/midi');
      $('cue-rows').append(row);
    });
  };
  rows(); $('cue-search').oninput = rows;
  $('play-bank').onclick = () => { $('autoplay').checked = true; $('loop-cue').checked = false; startAudio(asset, asset.cues[0]); };
  $('stop-bank').onclick = stopAudio;
}
function markPlaying() {
  document.querySelectorAll('#cue-rows tr').forEach((row) => row.classList.toggle('playing', selected === currentTrack?.asset && Number(row.dataset.cue) === currentTrack?.cue.index));
}
function stopAudio(clear = true) {
  ++audioEpoch;
  playback?.stop(); playback = null; clearInterval(playbackTimer);
  if (clear) { currentTrack = null; $('player').hidden = true; }
  markPlaying();
}
async function startAudio(asset, cue) {
  const requestEpoch = sourceEpoch;
  stopAudio();
  const requestAudioEpoch = audioEpoch;
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioMaster = audioContext.createGain(); audioMaster.connect(audioContext.destination);
    }
    audioMaster.gain.value = Number($('volume').value);
    await audioContext.resume();
    if (requestEpoch !== sourceEpoch || requestAudioEpoch !== audioEpoch) return;
    currentTrack = { asset, cue };
    playback = playMidi(audioContext, cue.bytes, 1, audioMaster);
    trackDuration = Math.max(0.1, playback.durationSeconds); trackStarted = audioContext.currentTime;
    $('player').hidden = false; $('toggle-play').textContent = 'Ⅱ'; $('toggle-play').setAttribute('aria-label', 'Pause playback');
    $('track-name').textContent = `${asset.name} · cue ${String(cue.index).padStart(2, '0')}`;
    $('track-progress').value = 0; $('track-time').textContent = `0:00 / ${clock(trackDuration)}`;
    updateTrackButtons(); markPlaying();
    playbackTimer = setInterval(() => {
      const elapsed = audioContext.currentTime - trackStarted;
      $('track-progress').value = Math.min(1, elapsed / trackDuration);
      $('track-time').textContent = `${clock(Math.min(elapsed, trackDuration))} / ${clock(trackDuration)}`;
      if (elapsed >= trackDuration + 0.1) {
        if ($('loop-cue').checked) startAudio(asset, cue);
        else if ($('autoplay').checked && asset.cues.indexOf(cue) < asset.cues.length - 1) startAudio(asset, asset.cues[asset.cues.indexOf(cue) + 1]);
        else stopAudio();
      }
    }, 80);
  } catch (error) { stopAudio(); notice(`Audio could not start: ${error.message}`, true); }
}
function updateTrackButtons() {
  if (!currentTrack) return;
  const i = currentTrack.asset.cues.indexOf(currentTrack.cue);
  $('previous-cue').disabled = i === 0; $('next-cue').disabled = i === currentTrack.asset.cues.length - 1;
}
function skipCue(direction) {
  if (!currentTrack) return;
  const { asset, cue } = currentTrack, next = asset.cues[asset.cues.indexOf(cue) + direction];
  if (next) startAudio(asset, next);
}
$('toggle-play').onclick = async () => {
  if (!currentTrack) return;
  if (audioContext.state === 'running') { await audioContext.suspend(); $('toggle-play').textContent = '▶'; $('toggle-play').setAttribute('aria-label', 'Resume playback'); }
  else { await audioContext.resume(); $('toggle-play').textContent = 'Ⅱ'; $('toggle-play').setAttribute('aria-label', 'Pause playback'); }
};
$('previous-cue').onclick = () => skipCue(-1); $('next-cue').onclick = () => skipCue(1); $('stop').onclick = () => stopAudio();
$('loop-cue').onchange = () => { if ($('loop-cue').checked) $('autoplay').checked = false; };
$('autoplay').onchange = () => { if ($('autoplay').checked) $('loop-cue').checked = false; };
$('volume').oninput = () => { if (audioMaster) audioMaster.gain.value = Number($('volume').value); remember('mp-volume', $('volume').value); };
$('choose-folder').onclick = () => $('folder').click();
$('folder').onchange = () => {
  if (!$('folder').files.length) return;
  const files = Array.from($('folder').files);
  const names = new Set(), unique = [];
  for (const file of files) {
    if (file.name.startsWith('.') || !/\.(pak|pap|pip|pin|mid|txt|ini)$/i.test(file.name)) continue;
    const name = file.name.toLowerCase();
    if (!names.has(name)) { names.add(name); unique.push(file); }
  }
  setSource(unique, sourceFromFileList(unique), `Selected folder · ${unique.length} files`);
};
$('reload').onclick = loadLocal;
$('search').oninput = renderCards; $('world').onchange = renderCards; $('sort').onchange = renderCards;
$('close-expanded').onclick = () => $('expanded').close();
function zoomExpanded() {
  const canvas = $('expanded-stage').firstChild;
  if (canvas) { const scale = Number($('expanded-zoom').value); canvas.style.width = `${canvas.width * scale}px`; canvas.style.height = `${canvas.height * scale}px`; }
}
$('expanded-zoom').onchange = zoomExpanded;
let drag;
$('expanded-stage').onpointerdown = (event) => {
  const stage = $('expanded-stage'); drag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  stage.setPointerCapture(event.pointerId); stage.classList.add('dragging');
};
$('expanded-stage').onpointermove = (event) => {
  if (!drag) return; const stage = $('expanded-stage');
  stage.scrollLeft = drag.left - (event.clientX - drag.x); stage.scrollTop = drag.top - (event.clientY - drag.y);
};
$('expanded-stage').onpointerup = $('expanded-stage').onpointercancel = () => { drag = null; $('expanded-stage').classList.remove('dragging'); };
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input,select,textarea') || $('expanded').open) return;
  if (event.key === '/') { event.preventDefault(); $('search').focus(); }
  if (event.code === 'Space' && currentTrack && event.target === document.body) { event.preventDefault(); $('toggle-play').click(); }
  if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && event.target.closest('.asset-card')) {
    const cards = [...$('cards').querySelectorAll('.asset-card')], index = cards.indexOf(event.target.closest('.asset-card'));
    const card = cards[index + (event.key === 'ArrowRight' ? 1 : -1)]; if (card) { event.preventDefault(); card.focus(); card.click(); }
  }
});
window.addEventListener('pagehide', () => stopAudio());
renderCategories(); loadLocal();
