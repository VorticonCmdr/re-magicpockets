#!/usr/bin/env node
// CLI: depack every RNC-compressed file under data/ into build/raw/, verifying each one
// against the CRC16 embedded in its own RNC header (see docs/formats/rnc.md).
//
// Usage: node tools/unpack.js [--out build/raw] [file...]
//   With no file arguments, processes every file in data/.

'use strict';

const fs = require('fs');
const path = require('path');
const { rncUnpack, crc16arc } = require('./rnc.js');

function parseArgs(argv) {
  const args = { out: 'build/raw', files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      args.out = argv[++i];
    } else {
      args.files.push(argv[i]);
    }
  }
  return args;
}

function main() {
  const { out, files } = parseArgs(process.argv.slice(2));
  const inputs =
    files.length > 0
      ? files
      : fs
          .readdirSync('data')
          .filter((f) => !f.startsWith('.'))
          .map((f) => path.join('data', f));

  fs.mkdirSync(out, { recursive: true });

  let okCount = 0;
  let failCount = 0;

  for (const inputPath of inputs) {
    const name = path.basename(inputPath);
    const buf = fs.readFileSync(inputPath);
    const result = rncUnpack(buf);

    if (result === null) {
      console.log(`SKIP  ${name} (not RNC-compressed, or too short)`);
      continue;
    }

    const actualCrc = crc16arc(result.data);
    const crcOk = actualCrc === result.unpackedCrc;
    const sizeOk = result.data.length === result.unpackedLen;

    // Keep the original extension in the name (level3a.pap and level3a.pin must not collide).
    const outPath = path.join(out, name + '.raw');
    fs.writeFileSync(outPath, result.data);

    if (crcOk && sizeOk) {
      okCount++;
      console.log(
        `OK    ${name}  ${buf.length} -> ${result.data.length} bytes  ` +
          `(${result.numChunks} chunk${result.numChunks === 1 ? '' : 's'})  -> ${outPath}`
      );
    } else {
      failCount++;
      console.log(
        `FAIL  ${name}  size ${sizeOk ? 'ok' : `MISMATCH (got ${result.data.length}, want ${result.unpackedLen})`}` +
          `  crc ${crcOk ? 'ok' : `MISMATCH (got 0x${actualCrc.toString(16)}, want 0x${result.unpackedCrc.toString(16)})`}`
      );
    }
  }

  console.log(`\n${okCount} OK, ${failCount} FAILED`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
