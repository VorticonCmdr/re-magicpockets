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
`1000:c16a`, see `docs/formats/pak.md`). The fields that matter for rendering:

- `+0xe` = **bank id** — an index into a small segment table (`6de3:f941`) giving which loaded
  segment this shape's pixel data lives in (e.g. bank 6 → segment `0x5c53`).
- `+2` = **animStart** — the entity's initial animation-frame index, copied into the runtime
  entity struct's own current-frame field (`entity+0xa`) at spawn time
  (`Entity_InitFromTemplateRecord`/`Entity_SpawnFromQueuedEvent`).
- `+0x16` = **frameSourceMode** — copied to a global (`[0x89e4]`) inside `Gfx_DrawObject` and
  read right after the bank segment is resolved. This is the field that broke the original
  "just use `animStart` as a tile index" assumption for banks 2/3/7 — see below.

**Confirmed exact — RESOLVED for every bank, not just bank 6.** Found by re-tracing
`Gfx_DrawObject`'s raw disassembly (`1000:7419`) instruction-by-instruction for the `0x0e`/`0x0f`
masked-bitmap dispatch branches, exactly as the previous session's dead-end note recommended.
The key evidence, in order:

1. `Gfx_DrawObject`'s caller, `Gfx_RenderVisibleEntities` (`1000:73a5`), does
   `MOV AX, word ptr [SI+0xa]; MOV [0x8c21],AX` immediately before every `CALL Gfx_DrawObject` —
   i.e. **the entity's own current-frame value (`entity+0xa`, initialized from `animStart`) is
   copied into `[0x8c21]` on every single draw call.** This is the "cumulative running offset"
   used by the three near-pointer tables (`e4fa`/`e906`/`dea2`) documented (but misread) in the
   prior investigation.
2. Disassembling `Gfx_BlitSpriteMaskedAlt`/`Wide` (`1000:81ad`/`1000:7ff2`) shows a `LODSW ES:SI`
   plane-blit loop (EGA/VGA latch writes through ports `0x3ce`/`0x3c4`) — confirming `DS:SI` is a
   genuine pixel-data pointer, `DS` set from `[0x89e6]` = `bankToSegment[bankId]` right before the
   call. This rules out the tables holding pixel data directly (they never reach `DS:SI` — only
   `BX`).
3. In `Gfx_DrawObject` itself, right before the blit: `[0x89e4]` (descriptor `+0x16`,
   *frameSourceMode*) gates two completely different addressing modes:
   - **`frameSourceMode != 0` (typically `1`) — direct mode.** `entity+0xa` (the frame value
     `[0x8c21]` was just copied from) is used **directly** as a flat tile index into
     `bankToSegment[bankId]`, multiplied by `0x280` (640 bytes = one 32×32 5-plane masked tile) —
     the exact same mechanism already confirmed for bank 6, just not gated behind a bank-id
     special case.
   - **`frameSourceMode == 0` — indirect mode.** `entity+0xa` is instead used as a *word index*
     into one of the three near-pointer tables (`e4fa`/`e906`/`dea2`, selected by the descriptor's
     `kind` field, `+0x18`) to fetch a pointer, and **one byte is read from that pointer** as the
     real tile index (more bytes for tall composite sprites, `frameCount` of them, each byte
     advancing through the target stream). This is why the earlier pass's raw sample of that
     target data (`7,52,9,10,66,67,...`) looked like small unrelated integers — they *are* tile
     indices, just for a different, dynamically-selected sprite, not for the entity whose
     `animStart` was being misread as the index in the first place. **Still not extracted** — see
     "Open questions" below.
   - **`frameSourceMode == 0xffff`** — a third, rarer mode: `SI` is forced to `0xa000` (EGA/VGA
     display memory) instead of a bank segment, i.e. the entity's "sprite" is actually a live
     grab of on-screen video memory (a portal/mirror-style special effect, not a real bank tile).

`tools/build-all.js`'s regenerated `symbols/entity-shapes.json` now exports `frameSourceMode` and
`kind` per descriptor, plus a `bankAtlas` map describing each bank's on-disk tile-catalog layout
(confirmed by reading `World1..4_LoadBanks`'s raw disassembly — identical across all 4 worlds):

| bank id | segment | tile catalog | total |
|---|---|---|---|
| 2 | `0x4353` | `bitkid.pak` (60 tiles, index 0-59) + `kidxN.pak` (20 tiles, index 60-79) | 80 |
| 3 | `0x6a63` | `specialN.pak` alone (no prefix file) | 20 |
| 6 | `0x5c53` | `extras.pak` (240 tiles, index 0-239) + `extraxN.pak` (80 tiles, index 240-319) | 320 |
| 7 | `0x20e9` | `nastyN.pak` alone (no prefix file) | 60 |

`tools/viewer.html` now resolves any entity whose descriptor has `frameSourceMode === 1` (or bank
id 6, which is always direct) to its real sprite tile, loading whichever atlas file(s) the
`bankAtlas` entry lists for the current world. Verified two ways: (1) the direct-mode `animStart`
values for every bank now fall exactly inside that bank's own tile budget (0-79 for bank 2, 0-19
for bank 3, 0-59 for bank 7) with zero exceptions, mirroring the bank-6 verification; (2) counting
resolved-vs-total entities across all 7 level scripts shows 70-97% of entities per world now
render as real sprites (up from bank-6-only coverage), and the newly-visible `nastyN.pak`/
`specialN.pak`/`bitkid.pak` atlases are all clean, recognizable sprite art (birds, snakes, ape-like
walk cycles, bubble/foam effects, player-costume frames) — not noise.

**Not yet resolved**: entities with `frameSourceMode === 0` (the indirect near-pointer-table path)
— roughly a third of bank 7's entities, the bulk of bank 2's, and a handful of bank 3's. The full
addressing mechanism is now known (see above) but the three tables' target byte-streams
(`6de3:e4fa`/`e906`/`dea2`) haven't been dumped and mapped per-`kind`/per-frame-index yet. `kind`
is exported in `entity-shapes.json` for exactly this follow-up. `tools/viewer.html` falls back to
a colored dot for these, and for `frameSourceMode === 0xffff` (video-memory effects, which have no
static tile to show at all).

`symbols/entity-shapes.json` (Ghidra-derived, checked into git like other symbol exports, copied
into `build/` by `tools/build-all.js`) holds the decoded descriptor table + bank-to-segment map +
per-bank atlas layout.

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
