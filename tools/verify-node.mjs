/* verify-node.mjs — run the invariant suite headlessly from disk.
 *
 * Same groups as a future in-page panel; reads data/ and game/ straight from the repo.
 *   node tools/verify-node.mjs      (exit 1 on any FAIL)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runAllChecks } = await import('../web/verify/checks.js');

if (!existsSync(join(ROOT, 'data')) || !existsSync(join(ROOT, 'game', 'GAMEU.EXE'))) {
  console.log('FAIL  data/ and game/GAMEU.EXE are required (original game files are not committed)');
  process.exit(1);
}

const ctx = {
  fetchRaw: async (url) => new Uint8Array(readFileSync(join(ROOT, url))),
  listData: async () => readdirSync(join(ROOT, 'data')).sort(),
};

console.log('Magic Pockets port — headless invariant run\n');
const { results } = await runAllChecks(ctx);

let asserts = 0, notes = 0, bad = 0;
for (const r of results) {
  if (r.note) notes++; else asserts++;
  if (!r.pass && !r.note) bad++;
  const tag = r.note ? 'note' : r.pass ? 'ok  ' : 'FAIL';
  console.log(`  ${tag}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}

console.log(`\n${asserts} assertions + ${notes} notes = ${results.length} rows, ${bad} failed`);
process.exit(bad ? 1 : 0);
