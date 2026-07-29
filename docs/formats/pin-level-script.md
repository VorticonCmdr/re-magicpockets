# Level-script format: `new1.pin` / `level2.pin` / `level3a-c.pin` / `level4.pin`

Despite the shared `.pin` extension with the sound-driver/bank files (`docs/formats/pin.md`),
these six files are **not sound at all** — they are the missing piece the project had flagged as
open since early sessions ("Sprite *placement/identity* metadata... lives elsewhere, not yet
traced"): a per-world **level-scripting bytecode** giving every enemy/item/trigger's type and
(X, Y) spawn position. One file per world: `new1.pin` (world 1 — oddly named, not `level1.pin`),
`level2.pin` (world 2), `level3a.pin`/`level3b.pin`/`level3c.pin` (world 3 — three variants),
`level4.pin` (world 4).

## How this was found

Traced from the load site, not guessed: every `World*_LoadBanks` loads its world's `.pin` file
directly into the **main data segment** (`6de3:0000`, offset 0) at exactly the file's own
unpacked size — a different pattern from every other asset, which load into dedicated
`CODE_N` scratch segments. Inspecting the raw bytes showed obviously structured data (repeating
tagged records, not sound), which led to the real consumers:

- **`Level_RunScriptedEventStream`** (`1000:c1e6`) — a level-authored event-stream interpreter,
  distinct from the runtime `[8bb5]` dynamic spawn-event queue. Its raw disassembly (not the
  decompiled pseudocode, which obscured the exact register loads) gives the byte-exact record
  format below.
- **`Entity_SpawnFromQueuedEvent`** (`1000:c2f3`) — the entity-spawn factory, called once per
  record with `AX`=entity type, `BX`=a word-count "layout selector", `SI`=payload pointer.
- **`Entity_LookupShapeDescriptor`** (`1000:c16a`, see `docs/formats/pak.md`) is called from here
  too, resolving each entity's sprite-shape descriptor (frame count, tile-bank segment, height).

## On-disk layout

**Header**: a sequence of big-endian 16-bit **sub-level entry-point offsets** into this same file,
terminated by a sentinel value ≥ the file's own length (in practice the file length, repeated).
Each entry is an independent starting point for a record stream — not necessarily a "room": many
entry points re-enter a long *shared/overlapping* tail of the same physical bytes (e.g. one entry
starts a few records earlier than another, both then reading identical subsequent enemies) —
plausibly alternate entry conditions (level start vs. a specific checkpoint) rather than distinct
screens.

**Record stream** (confirmed from `Level_RunScriptedEventStream`'s raw disassembly at
`1000:c1e6`):

```
word0 = marker (BE16)
```

`word0` is checked against four control opcodes; anything else is a generic entity-spawn record
(the marker's own value isn't meaningful data — `0xEEEE` in practice, but the code never
compares against that literal, only against the four below):

| marker | meaning | bytes consumed | effect |
|---|---|---|---|
| `0xAAAA` | terminal | 2 | ends this sub-level's stream. Also special-cases a hardcoded world-1/sub-level-6 cutscene trigger (resets several state globals, repositions a found entity). |
| `0xBBBB` | sub-level position query | 4 (marker + 1 word arg) | calls `Level_LookupSublevelPosition`, storing a target position at `[8c65]`/`[8c67]` — doesn't appear to offset subsequent entity coordinates. |
| `0xCCCC` | timed wait | 4 (marker + 1 word target) | busy-polls a frame counter (`[0x89f6]`) until it reaches the given target. |
| `0xDDDD` | terminal | 2 | starts the attract-mode demo (`Game_StartAttractDemoAndRunLoop`) and ends the stream. |
| anything else | entity spawn | 6 + payload (see below) | spawns/configures an entity via `Entity_SpawnFromQueuedEvent`. |

**Entity-spawn record** (the common case):

```
word0 = marker            (BE16, discriminant only, value not otherwise meaningful)
word1 = BX                (BE16, "layout selector" -- see WORDS_BY_BX below)
word2 = AX                (BE16, entity type -> runtime entity struct field +2)
payload = WORDS_BY_BX[BX] further BE16 words
```

`BX` is **not** a literal payload word count — it's a layout selector passed straight through to
`Entity_SpawnFromQueuedEvent` as `[0x8c1b]`, which branches on it to decide how many of the
generic fields to populate (confirmed directly from its decompile's `if (3 < BX)` /
`if (4 < BX)` / `if (BX == 8)` / `if (5 < BX)` / `if (6 < BX)` chain):

| BX | payload words | generic fields populated |
|---|---|---|
| 2 or 3 | 2 | X, Y |
| 4 | 3 | X, Y, entity+0x14 |
| 5 | 4 | X, Y, entity+0x14, state/script-table lookup |
| 6 | 5 | + entity+10 |
| 7 | 6 | + entity+0x26 |
| 8 | 6 | a *different*, byte-level (not word-pair) layout for the tail fields — same total word count, different meaning |

For the generic layout: `payload[0]` → entity field `+6` (X), `payload[1]` → entity field `+8`
(Y) — confirmed independently from `Gfx_DrawObject`'s own first two lines, which read those same
two fields as the entity's screen X/Y at render time. `AX` (entity type) matches several already-
known type constants from `Gfx_DrawObject`'s dispatch (e.g. `0x2b`/43 is the "charging hazard"
entity `Entity_ThinkChargingHazard` already documented in `docs/engine.md`).

Nine type values (`0x11, 0x1d, 0x1f, 0x25, 0x2b, 0x2f, 0x44, 0x53, 0x5e`) get bespoke field
layouts in `Entity_SpawnFromQueuedEvent` instead of the generic one (linked-child spawns, boss
segments, direction-vector setups, etc.) — **not decoded field-by-field here**, but their `X`/`Y`
extraction still works because every branch checked writes the same entity `+6`/`+8` fields from
the same leading payload positions.

## Entity sprite rendering (which tile does entity type `T` actually draw?)

Every entity's `type` (the level-script `AX` field above) is also the index into a **96-entry,
28-byte shape-descriptor table at `6de3:b91a`** (indexed via `Entity_LookupShapeDescriptor`,
`1000:c16a`, see `docs/formats/pak.md`). Two of its fields matter for rendering:

- `+0xe` = **bank id** — an index into a small segment table (`6de3:f941`) giving which loaded
  segment this shape's pixel data lives in (e.g. bank 6 → segment `0x5c53`).
- `+2` = **animStart** — the entity's initial animation-frame index, copied into the runtime
  entity struct's own current-frame field (`entity+0xa`) at spawn time
  (`Entity_InitFromTemplateRecord`/`Entity_SpawnFromQueuedEvent`).

**Confirmed exact** for bank id 6 (segment `0x5c53` = `extras.pak` (240 tiles) + `extraxN.pak` (80
tiles) concatenated, world N's per-world bonus/HUD icon bank — see `docs/formats/pak.md`):
`animStart` is a direct flat tile index into that combined 320-tile space (index < 240 →
`extras.pak`, else `extraxN.pak` at `index - 240`). Verified two ways: (1) every one of the ~44
bank-6 descriptors' `animStart`/`animEnd` values falls exactly inside 0–319 with zero exceptions
— not a coincidence at that sample size; (2) rendering each resolved entity's actual sprite tile
at its level position produces recognizable bonus-item art (stars, spinning icons, sparkles)
sitting at sensible in-level spawn points, not noise.

**Not yet resolved** for the other bank ids (2 = `kidxN.pak`, 3 = `specialN.pak`, 5 = `blocksN.pak`,
7 = `nastyN.pak`) — these cover most enemies/characters. `animStart` values there exceed each
file's own tile count. `tools/viewer.html` renders bank-6 entities as real sprites and falls back
to a colored dot for everything else, rather than guess wrong tiles.

### Investigation trail for banks 2/3/7 (dead-ended — read this before retrying)

Several hypotheses were tried and ruled out; a future session should start past these rather than
repeat them:

1. **Segment concatenation** (like bank 6's `extras`+`extraxN`): confirmed bank 2's segment
   (`0x4353`) really does load `bitkid.pak` (60 tiles) *before* `kidxN.pak` (20 tiles) each world —
   but even the combined 80-tile space doesn't cover the `animStart` values observed (up to 214).
   Bank 3 (`specialN.pak`, loaded alone, no prefix file found) shows values up to 225 with no
   second file to concatenate. **Ruled out as the general explanation.**

2. **Mirror-sprite generator as an extra source**: found `1000:b3c4`/`1000:b3f2` — real functions
   that regenerate horizontally-mirrored sprites in place (using the confirmed bit-reversal table
   at `0x8eee`) by copying from segments `0x4fd3` (kidx-related) / `0x2a49` (nasty-related).
   **Ruled out**: both are called only from `Game_StartAttractDemoAndRunLoop` (the attract-mode
   demo) — irrelevant to normal per-level entity rendering. Also, no load site into `0x4fd3` was
   ever found via any `Load_PackedFile` call, so its contents remain unexplained regardless.

3. **Per-entity-kind lookup tables**: `Gfx_DrawObject` computes a sprite/text source pointer via
   one of three near-pointer tables selected by the entity's *kind* field (descriptor `+0x18`, a
   separate field from bank id): kind 5 (or type `0x2b`) → table at `6de3:e4fa`; kind 2 or 4 →
   `6de3:e906`; type `0x2d` → `6de3:dea2`; everything else → `e4fa` again. This looked promising —
   until the **target data both `e4fa` and `e906` point to was read directly and turned out to be
   small sequential/repeated-integer sequences** (e.g. `7,52,9,10,66,67,42,70,71,72,73,74,75,76,
   77,78,79,200,200,200,200,11,12,...`) — indistinguishable from glyph/character codes, not
   sprite pixel data, even for entries whose descriptor `+8` field ("orientation", copied to
   `entity+0x16`) is `0x0f` — nominally the masked-bitmap-sprite shape-type dispatch value in
   `Gfx_DrawObject`. **Dead end**: either these tables are used exclusively by the text/glyph
   shape path (`0x0a`) and the real masked-bitmap sprite source pointer for `0x0e`/`0x0f` entities
   comes from a different register/variable this pass didn't correctly isolate in
   `Gfx_DrawObject`'s ~600-line decompile, or there's a subtlety the decompiled pseudocode is
   hiding (as has happened elsewhere in this project — raw disassembly has repeatedly disagreed
   with it). **Next step, if picked back up**: re-trace `Gfx_DrawObject` instruction-by-instruction
   (raw `disassemble_function`, not the decompiled C) specifically for the `0x0e`/`0x0f` dispatch
   branches, following the actual register that ends up in `SI`/`DS` right before
   `Gfx_BlitSpriteMaskedAlt`/`Wide` is called, rather than trusting which decompiled variable name
   claims to feed it. A dosbox-x breakpoint at `Gfx_BlitSpriteMaskedAlt` (`1000:7ff2`) or `Wide`
   (`1000:81ad`) dumping `DS:SI` for a live, on-screen kidx/nasty/special sprite would settle this
   immediately and is likely faster than further static tracing.

`symbols/entity-shapes.json` (Ghidra-derived, checked into git like other symbol exports, copied
into `build/` by `tools/build-all.js`) holds the decoded descriptor table + bank-to-segment map.

## Verification

`node tools/extract-level-script.js build/raw/<file>.pin.raw` parses every sub-level stream. All
six files parse cleanly: every sub-level terminates at a real `0xAAAA` (never runs into garbage),
except `level4.pin`, where 5 of its 15 header entries all point at the same harmless
padding/unused offset near EOF (immediately produces 0 entities, not a parse failure).

**Visual confirmation**: overlaying the extracted (type, X, Y) positions on the rendered level
(`blocksN.pak` + `levelNx.pap`, see `docs/viewer.md`) shows strong, non-coincidental structure —
world 4's decorative rooftop masts/antennas each get an entity marker almost exactly at their tip
(`level4a` + `level4.pin`), and world 2's jungle levels show markers clustered along the vine/
platform trunks (`level2a` + `level2.pin`). Same-type entities also form coherent evenly-spaced
horizontal rows at a consistent Y in several worlds — exactly the pattern a level designer placing
a row of collectibles or a patrol line of enemies would produce.

## Open questions

- **A meaningful fraction of records have negative or far out-of-frame X/Y** (a consistent
  "noise band" near Y≈0 appears in every world tested). Not yet explained — candidates: (a)
  genuinely off-map spawn triggers (falling/dropped-in enemies, pre-staged items) which is a
  normal platformer pattern, or (b) a per-sub-level coordinate base this extractor doesn't apply
  (`Level_LookupSublevelPosition`'s `[8c65]`/`[8c67]` output doesn't obviously feed back into
  subsequent entity coordinates from the code read so far, but hasn't been fully ruled out).
- **The nine special-opcode types' extra fields** (beyond X/Y) are not decoded — direction
  vectors, linked-parent/child relationships, hitbox extents, animation-set selectors.
- **Per-type semantic meaning** (which numeric type = which enemy/item) is not mapped — cross-
  referencing against `Entity_UpdateBehavior`'s per-world × per-kind dispatch tables (see
  `docs/engine.md`'s entity-system section) would be the next step.
- **Why 13 sub-level entries exist per world file** when each world only has 1-2 `.pap` maps —
  overlapping entry points suggest these may be authored "difficulty stage" or "checkpoint restart"
  variants (`Game_WarpToLevelStageAndRunLoop`, already documented) rather than distinct rooms.
