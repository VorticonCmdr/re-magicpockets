/* mutate-engine.mjs — mutation-test the verify suite (idea and structure from ../gods-web/tools/mutate-actions.mjs, adapted here).
 *
 *   node tools/mutate-engine.mjs [--only N,M,...]
 *
 * A green suite is not evidence unless it can go red. Each mutant is a plausible mis-port (a swapped constant, a flipped comparison,
 * a dropped statement) of code that was ported from the disassembly; `npm run verify` is run against it and must fail. A SURVIVOR means
 * no check (live capture, pinned table, ...) exercises that statement: it is a work item for the next capture or check, or the
 * mutant is equivalent (say why). Every source file is restored on exit, including after a failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SR = 'web/engine/script-runner.js', HIT = 'web/engine/hit.js', EB = 'web/engine/entity-behavior.js', FIRE = 'web/engine/fire.js',
  GC = 'web/engine/ground-collision.js', SPR = 'web/render/sprites.js', HUD = 'web/engine/hud.js', EN = 'web/engine/enemy.js';
const files = [...new Set([SR, HIT, EB, FIRE, GC, SPR, HUD, EN])];
const orig = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]));

const MUTANTS = [
  ['opcode 70: the facing test inverted', SR, '=== 4 ? 0xfff6 : 0x12); // 3C57', '=== 4 ? 0x12 : 0xfff6); // 3C57'],
  ['level-code entry: Up adds 1 instead of 2', SR, 'else { m.w8(BUF + bx, m.u8(BUF + bx) + 2); if (m.u8(BUF + bx) === 0x14)', 'else { m.w8(BUF + bx, m.u8(BUF + bx) + 1); if (m.u8(BUF + bx) === 0x14)'],
  ['opcode 68: world 1 boss ending script 0xCD03 -> 0xCD04', SR, "step === 0 ? 0xcd03", "step === 0 ? 0xcd04"],
  ['opcode 13 weapon 0x27: first shot id 0x17 -> 0x18', SR, 'm.w16(0x8c21, 0x17 + k);', 'm.w16(0x8c21, 0x18 + k);'],
  ['power-up 0x1F: the [8C0A] count is not incremented', HIT, "m.w8(0x8c0a, m.u8(0x8c0a) + 1);\n    return true;\n  }\n  if (frame === 0x66)", "\n    return true;\n  }\n  if (frame === 0x66)"],
  ['power-up 0x66: two continues', HIT, 'if (frame === 0x66) { m.w8(0x8c0b, m.u8(0x8c0b) + 1);', 'if (frame === 0x66) { m.w8(0x8c0b, m.u8(0x8c0b) + 2);'],
  ['power-up 0x67: [8BA4] set to 0', HIT, 'if (frame === 0x67) { m.w8(0x8ba4, 1);', 'if (frame === 0x67) { m.w8(0x8ba4, 0);'],
  ['power-up 0x1E: [8C5F] 0x90 -> 0x91', HIT, 'm.w16(0x8c5f, 0x90); m.w16(0x8c61, 0x50);', 'm.w16(0x8c5f, 0x91); m.w16(0x8c61, 0x50);'],
  ['reward shower 5DBA: nine cells instead of ten', HIT, 'for (let cx = 0; cx < 10; cx++) {', 'for (let cx = 0; cx < 9; cx++) {'],
  ['pair class 2 (5E18) clears the wrong entity', HIT, "if (cl === 2) { m.w8(si + 0x40, 0x19); return false; } // 5E18", "if (cl === 2) { m.w8(bx + 0x40, 0x19); return false; } // 5E18"],
  ['carried class-0x40 touch: knock-back state 0xA9 -> 0xAA', HIT, 'm.w8(bx + 1, 0xa9); m.w16(bx + 0xc, 0xd167);', 'm.w8(bx + 1, 0xaa); m.w16(bx + 0xc, 0xd167);'],
  ['burden touch: knock-back state 0xC2 -> 0xC3', HIT, 'm.w8(bx + 1, 0xc2); m.w16(bx + 0xc, 0xd3bd);', 'm.w8(bx + 1, 0xc3); m.w16(bx + 0xc, 0xd3bd);'],
  ['bonus doorway: list 0xC pushes 0xA1 instead of 0xA0', HIT, "list = 0xc; m.w16(0x8bb9, 0xa0);", "list = 0xc; m.w16(0x8bb9, 0xa1);"],
  ['cart ride: cart offset 0x86/0x9A swapped', EB, 'm.u16(bx + 0x14) === 4 ? 0x86 : 0x9a', 'm.u16(bx + 0x14) === 4 ? 0x9a : 0x86'],
  ['put-down of the light item: x 0x90 -> 0x91', EB, 'm.w16(it + 6, 0x90);', 'm.w16(it + 6, 0x91);'],
  ['3E15 class 0x40 pick-up: frame 6 -> 7', EB, 'm.w16(item + 0xa, 6); }\n    return;\n  }\n  if (ax === 0x43)', 'm.w16(item + 0xa, 7); }\n    return;\n  }\n  if (ax === 0x43)'],
  ['special mode 0x1B: [8BF7] 0x1F -> 0x1E', FIRE, 'm.w16(0x8c69, 0x1b); m.w16(0x8bf9, 0); m.w16(0x8bf7, 0x1f);', 'm.w16(0x8c69, 0x1b); m.w16(0x8bf9, 0); m.w16(0x8bf7, 0x1e);'],
  ['special mode 0x40: thrown item state 0x5D -> 0x5E', FIRE, 'm.w8(bx + 1, 0x5d); m.w16(bx + 0xc, 0xcaef);', 'm.w8(bx + 1, 0x5e); m.w16(bx + 0xc, 0xcaef);'],
  ['burden landing: fire bounce 0x10 -> 0x11', GC, 'if ((cl & 0x80) !== 0) m.w8(si + 0x26, 0x10);', 'if ((cl & 0x80) !== 0) m.w8(si + 0x26, 0x11);'],
  ['sprites: the player mirror test uses facing 4', SPR, "if (mode === 0xa && cls === 3 && facing !== 8) mirror = true;", "if (mode === 0xa && cls === 3 && facing !== 4) mirror = true;"],
  ['sprites: the pan correction sign', SPR, 'cmds[i].dx -= pan;', 'cmds[i].dx += pan;'],
  ['HUD extra life: frame 0x7F -> 0x7E', HUD, 'm.w16(life + 0xa, 0x7f);', 'm.w16(life + 0xa, 0x7e);'],
];

const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',').map(Number)) : null;
const restore = () => { for (const f of files) writeFileSync(f, orig[f]); };
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });
let killed = 0, survived = [], missing = 0, ran = 0;
MUTANTS.forEach(([name, file, from, to], i) => {
  if (only && !only.has(i)) return;
  const s = orig[file];
  if (!s.includes(from)) { console.log(`  ??   #${i} ${name}: PATTERN NOT FOUND`); missing++; return; }
  writeFileSync(file, s.replace(from, to));
  let out = '', failed = false;
  try { out = execSync('node tools/verify-node.mjs 2>&1', { encoding: 'utf8', maxBuffer: 1 << 28 }); }
  catch (e) { failed = true; out = (e.stdout || '') + (e.stderr || ''); }
  writeFileSync(file, s);
  ran++;
  const bad = out.split('\n').filter((l) => /^\s*FAIL/.test(l)).length;
  if (failed || bad > 0) { killed++; console.log(`  KILL #${i} ${name} (${bad} failing checks)`); }
  else { survived.push(`#${i} ${name}`); console.log(`  LIVE #${i} ${name}`); }
});
console.log(`\n${killed} of ${ran} mutants killed, ${survived.length} survived${missing ? `, ${missing} patterns not found` : ''}`);
if (survived.length) console.log('survivors:\n  ' + survived.join('\n  '));
