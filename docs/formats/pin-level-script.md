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
layouts in `Entity_SpawnFromQueuedEvent` — see the next section for the full, field-by-field
decode of every one of them from `1000:c2f3`'s raw disassembly (not the decompiled pseudo-C, which
obscures the exact `BX`/`SI` pointer arithmetic that determines both field meaning *and* how many
payload bytes each record actually consumes).

## The nine special-opcode types, fully decoded — and why only two of them appear in real levels

`Entity_SpawnFromQueuedEvent` (`1000:c2f3`) is **not exclusively a level-script consumer** — it's
also the target of the runtime dynamic spawn queue (`[0x8bb5]`, pushed via
`Entity_PushSpawnEvent`/`Entity_PushPositionEvent`, e.g. an enemy's AI script spawning a
projectile or effect while playing). Both callers set up the same three inputs (`AX`=type,
`BX`=layout selector, `SI`=payload pointer) before calling in; the factory has no way to tell which
caller it came from. Tracing the raw disassembly of all nine bespoke branches — specifically how
far each one advances `BX` through the payload before falling into the shared tail/return logic —
settles which of the nine can plausibly appear in a static `.pin` file at all:

| type | consumes | payload meaning | file-compatible? |
|---|---|---|---|
| `0x11` (17) | **1 word** | `payload[0]` is read **directly as a pointer** (`MOV DI,[BX]`) to an existing live entity struct — dereferenced immediately (`[DI+1]`, `[DI+2]`, `[DI+0x2c]`, `[DI+0x40]`) to decide whether to attach a new one-shot child at the parent's position (`parent.X`, `parent.Y-8`). Aborts (no spawn) if the parent is already dying, already has a child, or has an invalid type. | **No** — a file can't encode a valid runtime memory address. |
| `0x25` (37) | **1 word** | Same pointer-read pattern (`MOV BX,[BX]`), but keeps the new child linked more richly (copies parent `+6/+8/+14`, computes a type-dependent Y offset, and — new here — evicts any *existing* child of that parent by marking it dying first, then calls `Entity_FindArraySlotForEntity` for its own list-insertion point instead of using the shared priority-insertion tail). | **No** — same reasoning as `0x11`. |
| `0x1d` (29) | **1 word** | Same pointer-read (`MOV DI,[BX]`), copies parent `+6/+8/+14` into the new entity, sets extended-state byte from `[0x8bf9]`. No abort checks, no back-reference (parent's own `+0x2c` is left untouched — a one-way "spawn near/tracking a live entity" rather than `0x11`/`0x25`'s two-way link). | **No** — same reasoning. |
| `0x2f` (47) | **1 word** | Same pointer-read again, copies parent `+6/+8/+14` (with a `-0x10` Y offset), links two-way, then **tail-jumps into `FUN_1000_c890`** instead of the shared insertion dispatch at `LAB_1000_c4de` — a completely different list-splice path. | **No** — same reasoning. |
| `0x44` (68) | **4 words** (fixed, ignores `BX`) | `X, Y, +0x14, kind-byte→+0xc table lookup` via **byte-swapped** reads (`XCHG AL,AH` after each word load — net effect identical to the generic branch's big-endian `MOV AH,[BX]`/`MOV AL,[BX+1]` idiom, just implemented differently), plus `entity+0x26 = [0x8b6b] & 0x70f` (a live RNG/frame-counter global, not payload data). Structurally identical to the *generic* layout's `BX`-selector-5 case (same 4 fields, same meaning) — this branch just hardcodes that count instead of reading `[0x8c1b]`. | Byte-layout-compatible with a real file record (if one used `BX=5`), but never observed — see below. |
| `0x53` (83) | **5 words**, *conditionally* | First **peeks** (without consuming) `payload[3]`; if non-zero, abandons the whole bespoke path and falls through to the ordinary generic branch instead (using the file's real `BX` selector for length). If zero: reads `X, Y, +0x14`, **skips one word** (`ADD BX,4` instead of `2` right after the `+0x14` read — the file's 4th payload word is present but discarded, unused), then reads one more word into `+10`. Fixed `+1`=`0x3b`, `+0xc`=`table[0x3b]`, `+0x26`=`0x204`. | Only self-consistent if paired with `BX=6` (the generic 5-word count) in the file — never observed. |
| `0x2b` (43) | **0 words of its own** | Sets three fixed fields (`state=0`, extended-state `0x14`, "charge" `0x36=0x32` — matching `Entity_ThinkChargingHazard`'s known threshold, `+0x14`(anim-set)`=4`), then **falls straight through** (`JMP c40c`) into the ordinary generic branch, consuming exactly whatever the file's own `BX` selector says (X, Y, and beyond). | **Yes** — this is really just "generic record with 3 extra hardcoded fields." |
| `0x5e` (94) | **0 words of its own** | Rolls a `Rng_NextValue()&3` to pick one of 4 fixed animation-frame ranges (the firework/particle burst — `docs/enemies.md`'s confirmed `Game_WarpToLevelStageAndRunLoop` ending-sequence effect), then **falls through** to the generic branch exactly like `0x2b`. | **Yes** — same reasoning. |
| `0x1f` (31) | **6 words**, *conditionally* | Only if the file's `BX` selector `== 7`; otherwise falls straight to the generic branch (`JMP c40c`, using whatever `BX` the file has). When it does apply: reads `X, Y, Z` (3 words, `Z`→`+0xa`), a 4th word (loaded into `CX`, never stored — dead read), a 5th word into global `[0x8c1f]`, and a 6th into global `[0x8c21]`, which is then used as the parameter to `CALL 1000:30b3` (a direction-vector/velocity setup, matching the decompile's "`Entity_SetupDirectionVector`" label). Total consumed (6 words) exactly matches the generic layout's own `BX=7` count, so byte-length bookkeeping is identical either way. | **Yes, when paired with `BX=7`** — and this is the one bespoke type actually shipped. |

**Verified against the real data** (all six unpacked `.pin` files, 3811 entity records total): only
**`0x1f`** and **`0x2b`** ever appear. `0x1f` always carries `BX=7` (matching its required
condition) in every file except `level3c.pin`, which also has some at `BX=6` — those fall through
to the ordinary generic 5-word layout instead, which is exactly what the code above predicts, not
a decoder bug. `0x2b` appears exactly once, in `level4.pin`. **`0x11`, `0x1d`, `0x25`, `0x2f`,
`0x44`, `0x53`, `0x5e` never appear** — confirming the "raw pointer" branches are runtime-only,
never authored, and that `0x44`/`0x53`'s fixed-length bespoke paths (which *could* theoretically
appear with the matching `BX`) simply weren't used by the level designers, who presumably always
reached the same effect through the plain generic layout instead.

**Practical upshot for `web/core/pin-level-script.js`**: the existing decoder — which determines
record length purely from the file's own `BX`/layout-selector word via `WORDS_BY_BX`, ignoring
`type` entirely — was already exactly correct. Verified two independent ways: (1) tracing every
bespoke branch's real `BX`-pointer advancement in raw disassembly shows it always consumes exactly
`WORDS_BY_BX[bx]` words in total, for every type that can legally appear in a file; (2) empirically,
none of the six files ever desyncs (every sub-level's stream reaches a genuine `0xAAAA` terminator,
never garbage). No decoder change was needed — this closes the "not decoded field-by-field" gap
the previous pass left open, with proof rather than a plausibility argument.

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

`level.html` now resolves any entity whose descriptor has `frameSourceMode === 1` (or bank
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
is exported in `entity-shapes.json` for exactly this follow-up. `level.html` falls back to
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

- **RESOLVED — "negative/out-of-frame X/Y" is not noise; it's content for OTHER rooms sharing the
  same byte stream.** Dumping one sub-level's records in file order (`new1.pin` sub-level 0, world
  1's level-1a stream) shows the negative-Y entities are **not garbage**: X stays in a plausible
  0-2000px range throughout, and Y values cluster into clean, tile-row-aligned bands (multiples of
  16px — `-48, -80, -96, -160, -176, -240, -288, -304, -432, -480, -496, -624, -832, ...`), exactly
  the pattern a level designer placing evenly-spaced rows of enemies would produce, just far above
  where level 1a's own `.pap` (0-2048px tall) can render them.

  The likely mechanism: `FUN_1000_59a9` (a trigger-entity update routine, gated on a hardcoded
  entity type `0x9e`/158 sitting at the exact position `X=0x90(144), Y=0x50(80)` — the same pixel
  as level 1a's own player spawn, strongly suggesting this trigger entity is itself spawned as a
  runtime-only linked child of the player, via one of the pointer-based opcodes above, not from
  static file data) checks the **"camera position" globals `[0x8bbb]`/`[0x8bbd]`** (set per-sublevel
  by `Level_InitStateForSublevel`, see `docs/port-plan.md`'s spawn-position follow-up entry) against
  a small table of seven hardcoded `(X, Y)` trigger anchors, e.g. `(-0x730, -0x5e0)` = `(-1840,
  -1504)` — squarely inside the same negative range as the level-script's own out-of-bounds
  entities. Each match pokes several state globals and **re-invokes `Level_RunScriptedEventStream`**
  from a different `[0x8c63]` entry pointer. This is a genuine room/checkpoint-warp dispatcher:
  world 1 has more than one screen's worth of authored content living inside `new1.pin`'s single
  byte stream, and a room's "local" entities are simply whichever records' `(X, Y)` happen to fall
  within that room's own camera window — which is also, incidentally, exactly what
  `web/main.js`'s existing `e.x/e.y` bounds-filter against `scene.widthPx/heightPx` already does
  when spawning entities for the currently-loaded level, so **this port's existing pragmatic
  filtering approach turns out to be the structurally correct one**, not a placeholder workaround.
  **Not fully closed**: the exact per-room coordinate origins (which would let every one of world
  1's other rooms be extracted precisely, not just level 1a) aren't mapped — `[0x8bbb]`/`[0x8bbd]`'s
  own static source table was already traced in the port-plan follow-up and found to be
  runtime-populated, not literal file bytes, so completing this would need either a live read per
  room or locating that table's true runtime-copy source.
- **RESOLVED — the nine special-opcode types' extra fields.** See the new section above: all nine
  are now decoded field-by-field from raw disassembly, with the added finding that seven of them
  (`0x11, 0x1d, 0x25, 0x2f, 0x44, 0x53, 0x5e`) never actually appear in shipped level data — four
  of those seven are provably runtime-only (their payload word is read as a live entity pointer,
  which a static file cannot encode).
- **PARTIALLY RESOLVED — why 13 sub-level entries exist per world file.** The room/checkpoint-warp
  mechanism found above (`FUN_1000_59a9` and friends) supports the existing "difficulty stage /
  checkpoint restart" hypothesis: multiple screens' worth of content genuinely does live inside one
  world's `.pin` file, addressed by a small per-room trigger-position table, not by a 1:1 mapping to
  `.pap` files.

  **Follow-up pass**: tried to assign each sub-level entry to a specific `.pap` map without a live
  read, via a pure-geometry fit test — for every sub-level's entity list, what fraction of entities
  land on a *non-solid* real-collision cell in level-A's map vs. level-B's map (`web/engine/
  real-terrain.js`'s own `buildRealCollisionGrid`, same table used for the port's collision). World
  1 (`new1.pin`, 2 candidate maps): weak but directionally consistent signal — sub-level 0 fits
  `level1a.pap` best (already hard-confirmed via the live DOSBox read in the previous port-plan
  entry) and sub-level 1 fits `level1b.pap` best, matching the ordinal `1a→index 0, 1b→index 1`
  assumption `web/engine/level-registry.js` already uses. Sub-levels 2–12 split close to evenly
  between the two maps with low absolute fit percentages (3–16%) — consistent with them being
  **checkpoint/scripted-sequence re-entries into the same one or two physical rooms**, not
  additional distinct rooms, rather than a fit-test failure (this game's terrain is extremely
  dense — see the earlier spawn-position investigation — so even a *correct* map only "fits" a
  modest fraction of positions). World 2 (`level2.pin`) shows a clearer split (sub-levels 0/1/5
  fit `level2b.pap` best, 2/3/4/6/7 fit `level2a.pap` best, at 35–70% either way) — plausibly closer
  to genuine alternation between the two rooms. World 4 (`level4.pin`, 15 header entries) is
  mostly uninformative (near-0% either way for most entries) and its last 5 entries are dead
  padding pointing at the same harmless offset (already noted in the Verification section above,
  confirmed again here as `BAIL`/0-entity). **Not strong enough evidence to assert a definitive
  per-entry room mapping beyond the two already-confirmed world-1 cases** — left as a soft,
  documented lead rather than a closed answer.
- **RESOLVED for AI-driven enemy types**: `docs/enemies.md` cross-references every type value
  reachable through `Entity_UpdateBehavior`'s two per-world × per-type AI dispatch tables
  (`Entity_DispatchUpdateByKind`/`Entity_DispatchHitReactionByKind`) against a movement-pattern
  catalog (patrol, chase/flee, gates, sleepers, charging hazard, vertical pathfinder) and against
  `entity-shapes.json`'s sprite-bank data — every one of those types resolves to bank 7 (`nastyN.pak`)
  except the cross-world-shared type `0x2c` (bank 6, `extras`).
  **RESOLVED (in the negative) for items/pickups/bonus rewards**: `docs/engine.md`'s
  `Entity_ChooseAndSpawnBonusItem` writeup already fully decoded the real collectible/reward-item
  type set — exactly ten values, `0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3f`, every
  one confirmed via its own decompile branch and cross-checked against `entity-shapes.json`'s
  sprite-bank data (bank 3/6, except `0x3f` which is bank 2). Checking all six `.pin` files' full
  entity census against that exact set: **zero matches, in any file.** Combined with that function's
  own mechanism (`Entity_PushSpawnEvent`, the *runtime* dynamic queue, fired from a 100-frame
  periodic timer and a set of difficulty counters, never from the level-script interpreter) this is
  conclusive, not just suggestive: **real bonus/pickup items are never level-authored** — they are
  100% procedurally spawned during gameplay, so there is no "pickup" record to find in the static
  file, and the earlier attempt (matching `Entity_InteractionPhaseType1bHandler`'s pickup-collection
  tags against a spawned entity's `+10` field) was chasing the wrong layer — `+10` gets set from the
  shape-descriptor table at spawn (copying the descriptor's own `animStart`-adjacent fields, not
  payload data) and evidently mutates further at runtime as the entity's own AI/animation
  progresses; it was never going to correlate with static file bytes.
  What remains genuinely unmapped is the ~40 *other* static entity types (neither AI-dispatch enemy
  nor bonus item) — background/environmental decoration and hazard-adjacent set dressing, per the
  bank census below. `docs/enemies.md` is the right home for any further per-type tracing, not this
  format doc.

  | bank | tile catalog | static `.pin` types observed |
  |---|---|---|
  | 2 (`bitkid`/`kidxN`, player-adjacent) | 80 tiles | `0x15, 0x19, 0x2b, 0x43, 0x56` |
  | 3 (`specialN`) | 20 tiles | `0x41` |
  | 5 | — | `0x1` |
  | 6 (`extras`/`extraxN`) | 320 tiles | the majority of the remaining types (decoration/effects) |
  | 7 (`nastyN`) | 60 tiles | mostly already covered by `docs/enemies.md`'s AI-dispatch census |
