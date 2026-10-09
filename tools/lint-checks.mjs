/* lint-checks.mjs — find assertions that cannot fail.
 *
 * Adapted from gods-web's tools/lint-checks.mjs. A check that compares the port
 * against the very constant it was built from (`A === A`) reads as evidence but
 * proves nothing. The rule: at least ONE side of an equality inside a check()
 * must be a literal, or a value derived from the shipped bytes at runtime.
 *
 *   node tools/lint-checks.mjs        (exit 1 on findings)
 */

import { readFileSync } from 'node:fs';

const FILE = new URL('../web/verify/checks.js', import.meta.url);
const src = readFileSync(FILE, 'utf8');

const imported = new Set();
for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
  for (const raw of m[1].split(',')) {
    const name = raw.trim().split(/\s+as\s+/).pop().trim();
    if (name) imported.add(name);
  }
}

const findings = [];
const re = /check\(/g;
let m;
while ((m = re.exec(src))) {
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    }
    i++;
  }
  const body = src.slice(m.index, i);
  const line = src.slice(0, m.index).split('\n').length;

  const code = body.replace(/'(?:[^'\\]|\\.)*'/g, "''")
                   .replace(/"(?:[^"\\]|\\.)*"/g, '""')
                   .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  const EQ = /(^|[^\w$.\])\s])\s*([A-Za-z_$][\w$]*)\s*===\s*([A-Za-z_$][\w$]*)\s*($|[^\w$.\[(\s])/g;
  for (const cmp of code.matchAll(EQ)) {
    const [, lead, a, b, trail] = cmp;
    if (/[-+*/%]/.test(lead) || /[-+*/%]/.test(trail)) continue;
    if (imported.has(a) && imported.has(b)) {
      findings.push({ line, expr: `${a} === ${b}`,
        why: 'both sides are imported constants — this is X === X by construction' });
    }
  }
  for (const cmp of code.matchAll(/([A-Za-z_$][\w$]*)\.([\w$]+)\s*===\s*([A-Z][A-Z_0-9]*)\s*\[/g)) {
    const [, , field, table] = cmp;
    if (imported.has(table)) {
      findings.push({ line, expr: `.${field} === ${table}[...]`,
        why: `the field is served FROM ${table}, so this restates the assignment` });
    }
  }
}

if (!findings.length) {
  console.log(`ok    no tautological assertions in checks.js (${imported.size} imported names scanned)`);
  process.exit(0);
}
console.log(`FAIL  ${findings.length} assertion(s) that cannot fail:\n`);
for (const f of findings) console.log(`  checks.js:${f.line}  ${f.expr}\n      ${f.why}`);
console.log('\nAt least one side must be a literal or a value derived from the shipped bytes.');
process.exit(1);
