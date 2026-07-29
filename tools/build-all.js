#!/usr/bin/env node
// Regenerates every derived build/ artifact from data/ in one shot, using the current
// extractor code -- exists specifically so build/ output can never silently go stale again
// (a previous session hand-ran extractors file-by-file after fixing tools/ega.js's
// plane-to-color mapping, and quietly missed re-running most files: see git history around
// the "Confirm identity plane mapping" fix. Only kidx1/nasty1/blocks1 etc. -- whichever files
// were used as the fix's spot-check samples -- got regenerated; every other .pak/.pip ended up
// years, well, minutes out of date with visibly wrong colors).
//
// Usage: node tools/build-all.js

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = 'data';
const RAW_DIR = 'build/raw';
const PNG_DIR = 'build/png';
const MIDI_DIR = 'build/midi';

// blocksN/nastyN/kidxN/extraxN/specialN -> that file's assets belong to world N (see
// docs/memory-map.md's per-world load tables). Files without a world-numbered name (ape,
// bitkid, extras) have no confirmed world association -- default to world1, matching the
// original extraction pass.
function paletteForPakName(baseName) {
  const m = baseName.match(/^(?:blocks|nasty|kidx|extrax|special)([1-4])$/);
  return m ? `world${m[1]}` : 'world1';
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(PNG_DIR, { recursive: true });
  fs.mkdirSync(MIDI_DIR, { recursive: true });

  console.log('=== Unpacking data/ -> build/raw/ ===');
  run('node', ['tools/unpack.js', '--out', RAW_DIR]);

  const dataFiles = fs.readdirSync(DATA_DIR).filter((f) => !f.startsWith('.'));

  console.log('\n=== Extracting .pak sprite banks ===');
  for (const f of dataFiles.filter((f) => f.endsWith('.pak'))) {
    const baseName = f.replace(/\.pak$/, '');
    const rawPath = path.join(RAW_DIR, `${f}.raw`);
    const pngPath = path.join(PNG_DIR, `${f}.png`);
    run('node', [
      'tools/extract-pak.js',
      rawPath,
      pngPath,
      '--palette',
      paletteForPakName(baseName),
    ]);
  }

  console.log('\n=== Extracting .pip full-screen pictures (in-scope files only) ===');
  // intro0-5.pip belong to the separate intro.exe (out of scope) -- see docs/formats/pip.md.
  const IN_SCOPE_PIP = ['new.pip', 'endscrn.pip'];
  for (const f of dataFiles.filter((f) => f.endsWith('.pip'))) {
    if (!IN_SCOPE_PIP.includes(f)) {
      console.log(`SKIP  ${f} (belongs to intro.exe, not GAMEU.EXE -- see docs/formats/pip.md)`);
      continue;
    }
    const rawPath = path.join(RAW_DIR, `${f}.raw`);
    const pngPath = path.join(PNG_DIR, `${f}.png`);
    run('node', ['tools/extract-pip.js', rawPath, pngPath]);
  }

  console.log('\n=== Extracting .pap level maps ===');
  for (const f of dataFiles.filter((f) => f.endsWith('.pap'))) {
    const rawPath = path.join(RAW_DIR, `${f}.raw`);
    const pngPath = path.join(PNG_DIR, `${f}.png`);
    run('node', ['tools/extract-pap.js', rawPath, pngPath]);
  }

  console.log('\n=== Extracting level-script entity placements (new1/level2/level3*/level4.pin) ===');
  // These .pin files are level-scripting bytecode (enemy/item placements), NOT sound -- see
  // docs/formats/pin-level-script.md. Every other .pin is a sound driver/bank, handled below.
  const LEVEL_SCRIPT_FILES = ['level0.pin', 'new1.pin', 'level2.pin', 'level3a.pin', 'level3b.pin', 'level3c.pin', 'level4.pin'];
  for (const f of LEVEL_SCRIPT_FILES) {
    if (!dataFiles.includes(f)) continue;
    const rawPath = path.join(RAW_DIR, `${f}.raw`);
    const jsonPath = path.join(PNG_DIR, `${f}.json`);
    run('node', ['tools/extract-level-script.js', rawPath, jsonPath]);
  }

  console.log('\n=== Copying symbols/entity-shapes.json -> build/ (for tools/viewer.html) ===');
  // Ghidra-derived data (the shape-descriptor table, 6de3:b91a) -- not regenerable from data/,
  // so it's checked into symbols/ like the other Ghidra exports and just copied into build/.
  fs.copyFileSync(path.join('symbols', 'entity-shapes.json'), path.join(PNG_DIR, 'entity-shapes.json'));

  console.log('\n=== Writing build/manifest.json (for tools/viewer.html) ===');
  const levelFiles = dataFiles.filter((f) => f.endsWith('.pap')).map((f) => f.replace(/\.pap$/, ''));
  const tilesetFiles = dataFiles
    .filter((f) => /^blocks[1-4]\.pak$/.test(f))
    .map((f) => f.replace(/\.pak$/, ''));
  const entityScriptFiles = LEVEL_SCRIPT_FILES.filter((f) => dataFiles.includes(f)).map((f) => f.replace(/\.pin$/, ''));
  const worldOf = (name) => {
    const m = name.match(/([1-4])/);
    return m ? Number(m[1]) : null;
  };
  const manifest = {
    levels: levelFiles.map((name) => ({ name, world: worldOf(name) })),
    tilesets: tilesetFiles.map((name) => ({ name, world: worldOf(name) })),
    entityScripts: entityScriptFiles.map((name) => ({ name, world: worldOf(name) })),
  };
  fs.writeFileSync(path.join('build', 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`${levelFiles.length} levels, ${tilesetFiles.length} tilesets, ${entityScriptFiles.length} entity scripts`);

  console.log('\n=== Extracting .pin embedded MIDI (best-effort; most files have none) ===');
  for (const f of dataFiles.filter((f) => f.endsWith('.pin'))) {
    const rawPath = path.join(RAW_DIR, `${f}.raw`);
    try {
      run('node', ['tools/extract-pin.js', rawPath, MIDI_DIR]);
    } catch (e) {
      // extract-pin.js exits non-zero (and already logged NO-MIDI) for driver-code-only files.
    }
  }

  console.log('\nDone.');
}

main();
