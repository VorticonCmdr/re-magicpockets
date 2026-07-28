# RNC ProPack "method 1" — as used by Magic Pockets

Every file in `data/` is RNC ProPack method 1 ("RNC\x01"). Implemented in `tools/rnc.js`,
verified against all 60 shipped data files (see below) by matching the CRC16 embedded in each
file's own header — not just guessed at, but proven byte-exact against what `GAMEU.EXE` itself
produces, since the decoder is a direct transliteration of the game's own depacker
(`Rnc_Depack`, Ghidra `1000:fcc4`, and its helpers `1000:fec2`/`fe86`/`ff22`).

## Header (18 bytes, big-endian numeric fields)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Magic `"RNC\x01"` (bytes `52 4E 43 01`) |
| 4 | 4 | Unpacked length (BE32) |
| 8 | 4 | Packed length (BE32) |
| 12 | 2 | Unpacked-data CRC16 (BE16) |
| 14 | 2 | Packed-data CRC16 (BE16) |
| 16 | 1 | Leeway (unused by our decoder) |
| 17 | 1 | Number of chunks |

Compressed data starts immediately at offset 18.

## CRC16 variant

**CRC-16/ARC** (poly `0xA001`, reflected, init `0`) — the classic table-free "CRC-16" used by
lots of DOS-era tools. Confirmed by direct match against all 60 files' header `unpackedCrc`
field (`tools/rnc.js::crc16arc`, exercised by `tools/unpack.js`).

## Bitstream

LSB-first, 16-bit-word-oriented. Two 16-bit registers form a sliding window:
- `fcbb` ("current"): low `fcc3` bits are valid, ready to be consumed.
- `fcbd` ("reserve"): not yet merged into `fcbb`.
- `fcc3`: count of valid unconsumed bits currently in `fcbb`.

`GetBits(n)` pulls the low `n` bits out of `fcbb`, refilling from `fcbd` (and, if that isn't
enough, reading a fresh word from the stream into `fcbd`) as needed. See `tools/rnc.js`'s
`getBits` for the exact bit-for-bit port (transcribed from `1000:fec2`'s disassembly, not the
Ghidra decompiler's pseudo-C, which renders the funnel-shift as three confusing OR'd terms —
one of which is always zero and can be dropped).

Bootstrap (once per file, before the first chunk): `fcbb` = first stream word (raw, unshifted);
then one `GetBits(2)` call is made and its result thrown away — this is what actually seeds
`fcbd` from the second stream word and sets `fcc3 = 14`.

## Huffman tables (`Rnc_BuildHuffTable`, `1000:ff22`)

Each chunk has **three** tables, rebuilt fresh every chunk, read off the bitstream in this
order: **raw-length table**, **distance table**, **length table**.

Table encoding:
1. `count = GetBits(5)` — number of symbols (0..31).
2. `count` code lengths, `GetBits(4)` each (0 = symbol unused).
3. Canonical Huffman assignment: for `len` 1..16, for each symbol with that code length (in
   read order), assign the next code at that length (running code starts at 0, weight starts
   at `0x8000` and halves per length step — the standard canonical-code algorithm), then
   **bit-reverse** the length-`len` low bits of the running code. Store `(mask=(1<<len)-1,
   code=reversed, codeLen=len, classIndex=<the symbol's 0-based read order>)`.

`classIndex` is the key trick: it is simultaneously "which symbol" (for table lookup) *and* the
value-class parameter for decoding (see below) — RNC's length/distance encoding is
self-describing, it needs no separate side-channel for the value class.

## Symbol decode (`Rnc_DecodeSymbol`, `1000:fe86`)

1. Linear-scan the table for the entry where `(fcbb & entry.mask) == entry.code`.
2. `GetBits(entry.codeLen)` — this call's *only* purpose is to advance the stream past the
   matched code; **its result is discarded**. (This tripped up the first implementation attempt:
   `Rnc_GetBits` returns its value in AX, but `Rnc_DecodeSymbol` returns via CX, which
   `Rnc_GetBits`'s own `PUSH CX .. POP CX` prologue/epilogue leaves untouched across the call.)
3. If `classIndex < 2`: return `classIndex` (0 or 1) directly.
4. Else: `n = classIndex - 1`; return `GetBits(n) | (1 << n)` — the classic Elias/Deflate-style
   escape encoding, where each successive class doubles the representable range using one more
   raw bit.

## Chunk body (`Rnc_Depack`'s main loop, `1000:fd96`-`fe1c`)

Per chunk: build the 3 tables, then `count = GetBits(16)` (number of literal/match groups).
```
copy a raw run:  rawLen = decode(rawTable); if rawLen>0, copy rawLen bytes VERBATIM straight
                 out of the compressed stream (not bit-packed!) and re-sync the bit window
                 (see "Literal resync" below).
count--
while count > 0:
    distRaw = decode(distTable); lenRaw = decode(lenTable)
    matchLen = lenRaw + 2         (RNC_MIN_MATCH = 2)
    matchDist = distRaw + 1       (min distance = 1)
    copy matchLen bytes from (outPos - matchDist) to outPos, byte-by-byte (distance can be
    smaller than length -- self-overlapping runs, e.g. run-length-encoding a single byte)
    rawLen = decode(rawTable); if rawLen>0, copy + re-sync (as above)
    count--
```
So a chunk with `count` groups has `count` raw runs and `count-1` matches (raw, then
`(match, raw)` repeated). Chunks share the same bit-reader state; only the tables reset.

### Literal resync

Raw literal bytes are stored byte-aligned, inline in the compressed stream — copied directly
via the stream pointer, not through `GetBits`. After such a copy, the bit window must be rebuilt
from the new stream position while preserving the `fcc3` bits of `fcbb` that were already valid
before the interruption. Exact formula (from `1000:fded`-`fe13`, ported verbatim in
`resyncAfterLiteralCopy`):
```
keep = fcc3
w0 = word at current stream position;  w1 = word right after it
fcbb = (old fcbb & mask(keep)) | (w0 << keep)
fcbd = (w1 << keep) | (w0 >>> (16 - keep))     [top `keep` bits of w0, or 0 if keep==0]
```
`fcc3` and the stream pointer are **not** touched by this step (only the preceding raw-byte copy
moved the stream pointer, by exactly `rawLen` bytes).

## Verification

`node tools/unpack.js` depacks all 60 files in `data/` and checks each one's CRC-16/ARC against
the header's `unpackedCrc` field. Current status: **60/60 pass**. This is strong evidence the
port is bit-exact, not just "probably right" — a single wrong bit anywhere in a multi-thousand-
byte decompressed file would flip the CRC.
