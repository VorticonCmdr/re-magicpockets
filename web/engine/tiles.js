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
      } else if (sub === 2 || sub === 3) {
        ctx.unported.add(`animated tile rule, world ${sub}`);
      }
    }
  }
}
