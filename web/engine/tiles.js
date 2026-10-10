// Call #2, Level_UpdateAnimatedTiles (1000:02A3): every negative tile byte in the 14x11 window of the
// map buffer at the scroll position is an animating tile (a broken block, say); each iteration
// steps it. World 1's rule is ported; worlds 2 and 3 record themselves as unported.

'use strict';

export function levelUpdateAnimatedTiles(m, ctx) {
  const world = m.u16(0x8b89);
  if (world === 4) return;
  if (world === 3) {
    let al = (m.u8(0x8c19) - 1) & 0xff;
    if (al === 0xab) al = 0xaf;
    m.w8(0x8c19, al);
  }
  const sub = world || m.u16(0x8b8b);
  const start = m.u16(0x8c13);
  for (let row = 0; row < 11; row++) {
    let si = (start + 0x80 * row) & 0xffff;
    for (let col = 0; col < 14; col++) {
      const al = m.u8(si);
      si = (si + 1) & 0xffff;
      if (!(al & 0x80)) continue;
      if (sub === 1) { // 02FE
        const p = (-al) & 0xff;
        m.w8(si - 1, p === 0xa ? p : -(p - 0xa));
      } else if (sub === 2) {
        worldTwoTile(m, si, al);
      } else if (sub === 3) { // 030C: the water cycle [8C19] and the splash tiles
        const dl = m.u8(0x8c19), at = (si - 1) & 0xffff;
        if (al === 0xe1) m.w8(at, 0x1f);
        else if (al === 0xd4) m.w8(at, 0xd3);
        else if (al === 0xd3) m.w8(at, 0xd2);
        else if (al === 0xd2 || (al >= 0xac && al <= 0xaf)) m.w8(at, dl);
        else m.w8(at, (al + 1) & 0xff);
      }
    }
  }
}

/**
 * 1000:034D (world 2): the negative tile byte `al` at si-1 is a block that was hit (the tile value negated); each iteration it either steps
 * (value - 1) or, for a few tile values, settles into its replacement and sets its neighbours (0x73 is the "pillar" tile).
 */
function worldTwoTile(m, si, al) {
  const at = (si - 1) & 0xffff, left = (si - 2) & 0xffff, up = (si - 0x81) & 0xffff, down = (si + 0x7f) & 0xffff;
  const p = (-al) & 0xff;
  if (p === 0x6e) { // 036F
    if (m.u8(left) === 0x73) { m.w8(at, 0x96); return; }
    m.w8(at, 0x6e);
    return;
  }
  if (p === 0x6c) { // 0381
    if (m.u8(up) === 0x73) { m.w8(at, 0xdd); return; }
    if (m.u8(down) === 0x73) { m.w8(at, 0xdc); return; }
    m.w8(at, 0x6d);
    if (m.u8(left) === 0x73) { m.w8(left, 0x96); return; }
    m.w8(at, 0x6e);
    return;
  }
  if (p === 0x23) { m.w8(up, 0xd7); m.w8(at, 0x2d); m.w8(left, 0x96); return; } // 03EA
  if (p === 0x24) { m.w8(down, 0xe1); m.w8(at, 0x2e); m.w8(left, 0x96); return; } // 03D6
  if (p === 0x2b) { // 03AC
    if (m.u8(up) === 0x73) { m.w8(at, 0x2c); m.w8(up, 0xd7); } else m.w8(at, 0x2b);
    return;
  }
  if (p === 0x21) { // 03C2
    if (m.u8(down) === 0x73) { m.w8(at, 0x22); m.w8(down, 0xe1); } else m.w8(at, 0x21);
    return;
  }
  m.w8(at, (m.u8(at) - 1) & 0xff); // 036A
}
