// Structural sprite scan: every 25th row of every live capture through collectDraws; prints draw commands whose tile is
// unresolved or outside its bank. [PROVEN] only for 'no out-of-range tiles'; says nothing about pixels.
import fs from 'node:fs'; import zlib from 'node:zlib';
import { prepare, loadRow, expandRows } from '../web/verify/conformance-lib.js';
import { collectDraws, BANKS } from '../web/render/sprites.js';
const R=new URL('../', import.meta.url).pathname; // repo root
const exe=new Uint8Array(fs.readFileSync(R+'game/GAMEU.EXE'));
const env=prepare(exe,new Uint8Array(fs.readFileSync(R+'data/autoplay.pin')),new Uint8Array(fs.readFileSync(R+'data/pcmap.pap')));
for (const f of fs.readdirSync(R+'tools/attract-capture').filter(x=>/^live\d+.*\.capture\.json\.gz$/.test(x))) {
  let rows=JSON.parse(zlib.gunzipSync(fs.readFileSync(R+'tools/attract-capture/'+f)));
  if (rows.rows) rows=rows.rows;
  rows=expandRows(rows);
  const bad={}, worlds=new Set(); let n=0, cmdsTotal=0;
  for (let i=0;i<rows.length;i+=25) {
    const m=loadRow(env,rows[i]); worlds.add(m.u16(0x8b89)); n++;
    for (const c of collectDraws(m)) { cmdsTotal++;
      const b=BANKS[c.bank];
      if (!c.bank||c.tile<0) { const k='unresolved type '+c.type+' mode '+c.mode; bad[k]=(bad[k]||0)+1; }
      else if (!b) { const k='unknown bank '+c.bank+' type '+c.type; bad[k]=(bad[k]||0)+1; }
      else if (c.tile>=b.tiles) { const k='tile '+c.tile+'>= '+b.tiles+' bank '+c.bank+' type '+c.type; bad[k]=(bad[k]||0)+1; }
    }
  }
  console.log(f, 'worlds', [...worlds].join(), 'rows', n, 'cmds', cmdsTotal, JSON.stringify(bad));
}
