# `.pip` full-screen picture format

Traced from the actual consumer function (`Gfx_DrawFullScreenPicture`, `1000:bd64`), found by
following `new.pip`'s load site in `World1_LoadBanks` — it's the very first
`Load_PackedFile` call in the whole function, loading into segment `2a49` with the exact
`.pip` file size (`0x7d42` = 32066) as the byte count, immediately followed by a call to this
function.

## Layout

```
offset 0x00 .. 0x21 (34 bytes) : unexplained (all zero in both samples checked)
offset 0x22 .. 0x22+30720-1    : picture data, 320x192, 4bpp EGA, DIRECT (no mask)
offset 0x22+30720 .. end       : 1312 trailing bytes, unexplained
```

Total: `34 + 30720 + 1312 = 32066` — matches every shipped `.pip` file's unpacked size exactly.

**Picture data encoding** (confirmed from `Gfx_DrawFullScreenPicture`'s disassembly): unlike
`.pak` sprites (4 separate contiguous bitplanes), `.pip` pixel data is **interleaved per
16-pixel group**: for each of 192 rows × 20 word-groups (16px each), 4 consecutive source
words appear in plane order 0,1,2,3 (8 bytes), then the next 16-pixel group's 4 plane-words,
and so on. No AND-mask plane — appropriate for an always-opaque background image (unlike
sprites, a full-screen picture never needs transparency). Same fixed default EGA palette as
`.pak` (see `docs/formats/pak.md` — no custom palette exists anywhere in the binary), **but
note the plane→color-bit assignment is *not* the naive textbook EGA convention** — see below.

## Verification (and where the plane/color mapping bug was actually found and fixed)

Two real bugs were caught and fixed here, in order:

1. **Byte-order bug**: the first extraction attempt combined each 16-pixel group's 2 bytes into
   a 16-bit little-endian integer before testing bits, which silently swaps the two bytes'
   pixel order. Fixed by processing each byte separately in its actual memory order. This
   fixed the *shape/structure* (user confirmed: "looks better" — recognizable geometry) but
   colors were still wrong.
2. **Plane→color-bit mapping**: the textbook EGA hardware convention (plane0=Blue, 1=Green,
   2=Red, 3=Intensity) produced wrong colors even with shapes correct. Ruled out VGA 256-color
   chunky mode entirely first (the disassembly unambiguously cycles the Sequencer Map Mask
   register per pixel group, which only makes sense for 4-plane addressing — this is not
   mode 0x13). Generated 5 candidate plane-to-bit permutations and sent them to the user for
   direct visual comparison; `PLANE_TO_INDEX_BIT = [1,0,3,2]` (see `tools/ega.js`) was picked as
   the best match ("could be correct" — a tentative but positive confirmation, not certainty).

Statistically, `new.pip` decodes as a real image rather than noise: all 16 palette colours
used with a natural, background-dominated, non-uniform distribution, and ~66% pixel match
between adjacent rows (random 4-bit noise would give ~6.25%) — though note this structural
statistic is *invariant* to the plane/color permutation (relabeling 16 values preserves which
pixels are equal to each other), so it could only validate the byte-order fix, not the color
mapping — that step genuinely needed a human looking at the picture.

`node tools/extract-pip.js build/raw/<file>.pip.raw` produces the final decode.

## Open questions

- **The 34-byte leading region and 1312-byte trailing region.** Both unexplained. The trailing
  bytes end with small, structured-looking non-zero values (not obviously padding) — possibly a
  small palette-remap or CGA/Tandy-specific data, given `Gfx_DrawFullScreenPicture` dispatches
  to entirely different functions (`FUN_1000_b1ce`/`FUN_1000_b07c`) for those modes; not yet
  examined. Worth checking whether those functions read from this same file at a different
  offset.
- Only `new.pip` and `endscrn.pip` are referenced by `GAMEU.EXE` — the `intro0-5.pip` files
  belong to the separate `intro.exe`, not analyzed in this project (out of scope so far).
