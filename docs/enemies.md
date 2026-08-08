# GAMEU.EXE enemy/AI behavior system

How enemies (and other AI-driven entities) decide what to do, per frame, per hit, and on landing —
reverse-engineered from `Entity_UpdateBehavior` and its two `(world, type)`-keyed dispatch tables.
This is the direct follow-up to `docs/engine.md`'s "Open threads" entry on `Entity_UpdateBehavior`
and to `docs/formats/pin-level-script.md`'s open question about per-type semantic meaning.
Confidence is marked per finding: **confirmed** (read directly off real disassembly/decompile) vs.
**guess** (structure clear, exact semantics inferred).

## Three different "kind"-ish fields — do not conflate them

This project's own docs have already tripped over this once (see `docs/formats/pin-level-script.md`),
and the behavior system has a *third* one, so it's worth stating plainly up front. An entity has:

- **`+2` — type** (this doc calls it "type" throughout). This is the level-script `AX` field
  (`docs/formats/pin-level-script.md`), the index into the 96-entry shape-descriptor table
  (`docs/formats/pak.md`/`entity-shapes.json`), *and* the value both AI dispatch tables below switch
  on. One number, three consumers.
- **`+4` — class**. A small integer (0–8 seen) that `Entity_UpdateBehavior` itself switches on first,
  selecting a broad behavioral category (player/camera anchor, AI-driven enemy, background prop,
  attached projectile, etc. — see below). This is what `docs/engine.md` was calling "kind" in its
  entity-struct field list.
2 and 4 (both "AI-driven enemy" classes, see below) are the only class values that lead into the
  per-type dispatch tables this doc is about.
- **Shape-descriptor `+0x18` — a *third*, unrelated "kind"** (`docs/formats/pin-level-script.md`
  calls it exactly that). It only selects which of three near-pointer tables
  (`6de3:e4fa`/`e906`/`dea2`) a `frameSourceMode==0` sprite reads its tile stream from. Has nothing
  to do with AI behavior. Confirmed disjoint from both fields above by inspection of the same sample
  descriptors used below.

## `Entity_UpdateAll`'s per-entity call — CORRECTION to docs/engine.md

**Confirmed**, from `Entity_UpdateAll` (`1000:c91d`) raw decompile: `docs/engine.md` describes this
as dispatching to *either* a heavier update (`FUN_1000_22da`) *or* a lighter step (`FUN_1000_ca6d`)
for "inactive" entities. That's wrong. The actual logic per live entity (state `+0x40 != 0x19`):

```
if (entity[+1] != 0)         // "has an active script" flag
    Entity_RunScript()       // the 78-opcode bytecode VM (docs/entity-script-vm.md)
Entity_UpdateBehavior()      // ALWAYS called, unconditionally, for every live entity
```

`Entity_UpdateBehavior` is not a fallback for inactive entities — it is *the* per-frame behavior
step for every entity, every frame. `Entity_RunScript` is an optional *extra* step some entities
also get first (cutscene/scripted-position entities, going by its opcode set). This document is
entirely about what `Entity_UpdateBehavior` does.

## `Entity_UpdateBehavior`'s top-level dispatch (`1000:ca6d`)

**Confirmed structure, and now decoded branch-by-branch for every class (0-7) and both special-type
pre-checks** — a follow-up pass over the initial dispatch-shape-only version of this doc. The two
global mode/event bytes gating the whole function (`[0x8ba1]`, `[0x8c0c]`) and all 8 per-class
branches are covered below with concrete detail; the handful of things still not traced to full
byte-level certainty (mostly individual `+0xc` script-pointer bytecode bodies, deliberately out of
scope — see "What remains genuinely open") are called out inline rather than left as a blanket
disclaimer. Two special-cased `+2` type values are checked before anything else:

- **type `8`** — a "system" pseudo-entity: calls `EntityOp_RebuildVisibleList` and returns. Not a
  gameplay entity at all.
- **type `0x5e` or `0xf`** — the firework/particle entity. **Confirmed** and directly ties back to
  `docs/formats/pin-level-script.md`'s note that opcode `0x5e` is "the firework/particle-spawn
  opcode... picking one of 4 random animation-frame ranges via `Rng_NextValue`": the code at
  `LAB_1000_cb1c` reads the RNG output (`[0x8b6b]`) exactly to pick 1 of 4 animation-frame ranges
  (`0x50–0x5b`, `0x66` static, `0x1e` static, `0x67` static), advances the frame, and kills the
  entity (`+0x40=0x19`) once the frame counter reaches `0x4f`. A one-shot particle effect, not an
  enemy.
- **type `0x11` / `0x2f`** — linked-child position-sync (a child entity tracks its parent's
  position via the `+0x2c` parent pointer, killing itself if the parent is gone). Matches
  `docs/engine.md`'s already-documented `0x11`/`0x2f` spawn-opcode semantics in
  `Entity_SpawnFromQueuedEvent`.

Everything else falls through to a switch on **`+4` (class)**. Two upstream gates matter first —
**confirmed this pass** by a full raw decompile of `Entity_UpdateBehavior` (previously only the
dispatch *shape* was confirmed; the classes below were largely guesses):

- **`[0x8ba1]` mode byte.** The entire class switch is wrapped in `if (-1 < *(char*)0x8ba1)`
  (sign bit clear). When `[0x8ba1]` is negative, execution skips straight past the whole switch to
  the **class-3 tail** (below) — and even *inside* the guarded block, an explicit
  `if (*(char*)0x8ba1=='E') goto LAB_1000_cb10` does the same for every class. So this byte is a
  global mode switch: some value(s) freeze **every** entity's normal per-class logic and leave only
  the class-3 (player, see below) entity's camera/hitbox bookkeeping running each frame — consistent
  with a cutscene/scripted-sequence freeze. (Confirmed distinct from the video-driver-selector byte
  at `6de3:8a5a`, which coincidentally also uses `'E'` as one of its own values — different address,
  unrelated variable, don't conflate them.)
- **`[0x8c0c]` global-event trigger** (values `8`, `0xe`, `0x14`), checked before the per-type
  dispatch for *every* class-2/4 entity, pre-empting normal AI for that entity this frame:
  - **`8`** → calls **`Entity_SelectNextStateByWorldAndKind`** (`1000:50ae`) — a **third
    `(world, type)`-keyed dispatch table**, confirmed exact from raw decompile, that retires the
    entity's current type into a type-specific negative "defeat/vanish" state constant (e.g. world 1
    type `0x20` → state `-0x68`/`0x98`, world 4 type `0x5d` → state `-0xf`/`0xf1` — one distinct
    state per type, presumably each pointing at its own canned death/poof animation script via
    `Entity_SetStateAndScript`). Its per-world/type roster is near-identical to
    `Entity_DispatchUpdateByKind`'s (below) with one addition — **world 3 type `0x4e`**, which has no
    entry in the AI-think table (see the note under that table). One special case: type `0x2b`
    (the charge-hazard-spawn opcode type from `docs/formats/pin-level-script.md`) instead just adds
    `AX*5` to a running counter at `[0x8c6b]` — a **score/counter increment**, not a state change —
    strongly suggesting `[0x8c0c]==8` is the game's **"clear all enemies for a bonus/level-end
    tally" trigger**: each enemy type either pops into its death animation or, for the dedicated
    bonus-item type, contributes directly to a score tally instead. Any type absent from this table
    falls to a default path: pushes a generic "vanish" event (opcode `0x11`, offset 8px back on X)
    plus a sound — i.e. everything gets *some* visible reaction, named handler or not.
  - **`0xe`/`0x14`** → the entity kills itself into a fixed-frame (`0xe`) or charge-quantized-angle
    (`0x14`, angle derived from the entity's own `+0x36` charge field) particle burst, reusing the
    same `Rng_NextValue`-driven frame-range-pick machinery already documented above for the
    `0x5e`/`0xf` firework entity, via `Entity_QueueRandomizedSpawn`/`Entity_PushSpawnEvent`.

| class | role | confidence |
|---|---|---|
| 0 | No-op. Inert/placeholder entities. | confirmed |
| 1 | **Confirmed structure** (was a guess): gated on `[0x8ba1]!='2'` and sub-level `[0x8b8b]!=0`, finds a target entity by kind (`Entity_FindEntityByKind`) and, unless a global state byte `[0x8b98]==-1`, calls `Entity_HandleCollisionOrStateDispatch` (below), then clears a collision-tracking global (`[0x8c01]`) and the target's own collision flags, then broadcasts an AABB-overlap event to same-class visible entities (`Entity_BroadcastEventToVisibleByKindFlag`, see below). This is a collision/trigger-vs-player class, not a self-moving enemy — a pickup, checkpoint, or hazard-tile trigger. | confirmed structure; exact target semantics guess |
| 2 | **AI-driven enemy, set A.** After the `[0x8c0c]` pre-check above, calls `EntityOp_SyncCameraTargetThenUnknown` then **`Entity_DispatchUpdateByKind`** — see below. Post-dispatch, most types fall to a shared `Entity_MoveHorizontalByFlags` + `Entity_AdvanceAnimationFrame` step (the actual position-delta application for "plain" patrollers happens *here*, not inside the per-type think function); exceptions: type `0x4b` has bespoke post-dispatch reset logic keyed on hit-state `0xcb` (see the ground-collision cross-reference below), types `0x23`/`0x51` (and `0x57` when its extended-state is `'C'`) roll a chance and, on success, self-trigger `Entity_DispatchHitReactionByKind` directly (an enemy that can "attack itself into" a hit-reaction, not just react to being hit by the player), and animation-set `0x15` freezes movement entirely (no move/animate call at all). | confirmed |
| 3 | **Confirmed: the player entity.** (Was "very likely"; now backed by a sprite cross-reference — see below.) Reached via `LAB_1000_cb10` (the `[0x8ba1]` side-door above) rather than the main class switch, and only proceeds if class `==3`. Calls `Entity_UpdateCameraTargetFromEntity` (recomputes the global scroll-delta `[0x8bb7]`/`[0x8bb9]` from this entity's position — confirming the camera is *literally* keyed off the class-3 entity every frame), `Entity_HandleWorld3SpecialTrigger` (a world-3-only scripted sequence gated on a global state/counter pair `[0x8b98]`/`[0x8bea]`, gating a boss/checkpoint-style entity search and dual spawn-event push — not fully decoded, still a guess at its exact narrative role), `Entity_SetHitboxByOrientation` (a two-value hitbox-size table keyed on facing), sets extended-state `0xf6` (see the cross-class `0xf6` convention below), then unconditionally rebuilds the visible-entity list and re-caches a pointer to "the next class-3 entity" at `[0x8b87]`. | confirmed |
| 4 | **AI-driven enemy, set B.** Same shape as class 2, but several types have their movement *fully inlined here* rather than left to the per-type think function: type `0x12` (world-1 swinging gate) runs an explicit raise/lower state machine for states `0xd`/`0xb` (a counter `+0x27` stepped by per-frame speed `+0x28`, counting down to 0 before flipping to the other vertical direction or settling) layered on top of the shared horizontal-target logic documented below; types `0x4e`/`0x4f` (world 3) apply their own `Entity_MoveHorizontalByFlags`/`MoveVerticalUpByFlags`/`MoveVerticalDownByFlags` calls directly based on state and a `+0x28` counter, *before* falling through to `Entity_DispatchUpdateByKind` — type `0x4e` in particular has **no entry in `Entity_DispatchUpdateByKind`'s table** (confirmed by the table dump below) precisely because all of its behavior (a plain, always-forward walk with no turn-around logic) is already handled by this inlined code; the dispatch call for it is a harmless no-op. Types `0x48`/`0x49` (sleepers) and `0x54`/`0x5d` (gates) set a posture/variant marker (`+0x29`) before dispatch — sleepers copy their own charge field, gates hardcode `2`. | confirmed |
| 5 | **Confirmed: parent-attached entities, some specifically tied to the player.** Copies position from a parent pointer (`+0x2c`) every frame. Types `0xe`/`0x40` are simpler self-contained riders (idle/burst-animation state machines, `0xe` shares the firework's `Rng_NextValue` frame-range-pick trick for a burst at frame `0x12`). **Types `0x1a`/`0x41` require the parent to be class `3` — the player** (`if (*(int*)(parent+2) != 3) return;`) — i.e. these are player-carried entities, not generic projectiles. Their screen offset is computed from a per-*player-animation-frame* lookup table (two parallel byte tables indexed by `(playerFrame-0x1f)*2`, giving X/Y nudges, plus extra fixed nudges for specific player frames `0xe2`-`0xea`) — exactly what carrying an item through a multi-frame walk/jump/attack animation would need. Given the game's own title, the strongest reading is that this is the **carried "magic pocket"/prize item** riding the player's hand position frame-by-frame; not independently confirmed against gameplay footage. References `DAT_1000_22d7` (the alt-build/CGA sentinel) directly — the offset differs between the normal and alt builds. | structure confirmed; "carried player item" identity is an informed guess |
| 6 | **Confirmed** (was a guess, now fully verified from decompile): when extended-state `==0xf6`, position is advanced by the raw camera-scroll delta (`[0x8bb7]`/`[0x8bb9]`) every frame instead of by its own movement logic — riding the parallax scroll rather than moving under AI control; otherwise just advances its idle animation. See the `0xf6` cross-class convention below. | confirmed |
| 7 | **Confirmed structure**: when extended-state `==0xf6`, finds a target entity by kind and computes a **homing Y offset** from the *same* per-target-animation-frame lookup-table mechanism class 5 uses for its player-carried types (`table[(target's current frame - 0x1f)*2 - 0xb06]`) — i.e. this is a "track a specific animation frame of another entity" mechanism reused across two unrelated classes. Otherwise (extended-state `!=0x65`) broadcasts an AABB-overlap event to visible same-class-flagged entities (`Entity_BroadcastEventToVisibleByKindFlag`, shared with class 1 above). | confirmed |

**Classes 2 and 4 are the only ones that reach the per-type AI dispatch tables below** — i.e. "enemy
behavior" in the classic patrol/chase/attack sense lives entirely behind class 2 or 4.

**Cross-class discovery: extended-state `0xf6` (`-10`) is a general "tracking/attached" sentinel**,
confirmed used consistently by four independent branches above: class 3 (player, set unconditionally
every frame — the camera/visible-list anchor), class 5 (implicitly, via its parent-pointer riders),
class 6 (ride the camera-scroll delta), and class 7 (home in on a found target's animation frame).
Whatever else `0xf6` means state-machine-wise for a given type, in this specific field it uniformly
means "this entity's position this frame is derived from something else, not its own movement code."

**Sprite cross-reference for classes 3/5/1's special types** (same method as the main AI-enemy
table below): class-3 type `3` (the player) resolves to **bank 2** (`bitkid.pak`, frames 65-72) —
the same bank `docs/formats/pin-level-script.md` already flagged as containing "player-costume
frames," now tied concretely to the class confirmed to be the player. The `0x11`/`0x2f` linked-child
special types from the very top of this doc are bank 6 (`extras`) and bank 2 (`bitkid`, frame 70 —
immediately adjacent to the player's own 65-72 range) respectively; class-5's player-attached types
`0x1a`/`0x41` are bank 6 (`extras`)/bank 3 (`specialN`), both tiny single-frame effect sprites,
consistent with a small carried-item or hit-spark graphic rather than a full character.

## The two per-(world, type) dispatch tables — the concrete deliverable

Both tables switch on **world number** first (`[0x8b89]`, falling back to `[0x8b8b]` when
`[0x8b89]==0` — the same world-selector pair documented in `docs/memory-map.md`), then on the
entity's **type (`+2`)**. **Confirmed exact** — read directly off `disassemble_function`, not
decompiler pseudocode, and every target already carried a real name from a prior naming pass (no
guessing involved in resolving jump targets).

### `Entity_DispatchUpdateByKind` (`1000:5e22`) — per-frame "think" dispatch

Called every frame for every class-2/4 entity, after the class-level pre-processing above.

| World | Type | Handler | Movement pattern |
|---|---|---|---|
| 1 | `0x12` | `Entity_ThinkSwingingGate` | Gate/switch family (below) |
| 1 | `0x13` | `Entity_ThinkPatrolDefaultB` | Generic patrol |
| 1 | `0x14` | `Entity_ThinkPeriodicIdleFidgetA` | Idle fidget |
| 1 | `0x20` | `Entity_ThinkChargingHazard` | Charging hazard |
| 1 | `0x23` | `Entity_ThinkPatrolDefaultA` | Generic patrol |
| 1 | `0x2c` | `Entity_ThinkPatrolDefaultC` | Generic patrol (shared across **all 4 worlds**) |
| 2 | `0x42` | `Entity_ThinkPatrolDefaultD` | Generic patrol |
| 2 | `0x48` | `Entity_ThinkSleeperWakeUp` | Sleeper (wakes with sound cue) |
| 2 | `0x49` | `Entity_ThinkSleeperWakeUpQuiet` | Sleeper (wakes silently) |
| 2 | `0x4a` | `Entity_ThinkPatrolDefaultB` | Generic patrol (same handler as world 1's `0x13`) |
| 2 | `0x4b` | `Entity_ThinkEdgeDetectReset` | Edge/obstacle-triggered reset |
| 2 | `0x4c` | `Entity_ThinkPeriodicIdleFidgetB` | Idle fidget |
| 2 | `0x2c` | `Entity_ThinkPatrolDefaultC` | Generic patrol (shared) |
| 3 | `0x4f` | `Entity_ThinkVerticalPathfinder` | Vertical-column pathfinder |
| 3 | `0x50` | `Entity_ThinkPatrolWithCustomTileTableA` | Patrol, custom tile-flag table |
| 3 | `0x51` | `Entity_ThinkPatrolWithCustomTileTableB` | Patrol, custom tile-flag table (hover/flight variant) |
| 3 | `0x54` | `Entity_ThinkSlidingGate` | Gate/switch family |
| 3 | `0x2c` | `Entity_ThinkPatrolDefaultC` | Generic patrol (shared) |
| 4 | `0x57` | `Entity_ThinkPatrolDefaultE` | Generic patrol |
| 4 | `0x58` | `Entity_ThinkPatrolDefaultF` | Generic patrol |
| 4 | `0x59` | `Entity_ThinkPatrolDefaultH` | Generic patrol |
| 4 | `0x5a` | `Entity_ThinkPatrolDefaultG` | Generic patrol |
| 4 | `0x5d` | `Entity_ThinkRotatingGate` | Gate/switch family |
| 4 | `0x2c` | `Entity_ThinkPatrolDefaultC` | Generic patrol (shared) |

Any other `(world, type)` combination under class 2/4 is a silent no-op (falls through the table
with no default handler).

### `Entity_DispatchHitReactionByKind` (`1000:677c`) — "just got hit" dispatch

**Confirmed** structure: sets a hit-stun timer pair (`+0x27`, `+0x26=7`) unconditionally, then
special-cases type `0x2c` (always → `Entity_HitReactToState15`, matching its "shared across all
worlds" status in the think table above) before the same world→type switch:

| World | Type | Handler |
|---|---|---|
| 1 | `0x13` | `Entity_HitReactToState83` |
| 1 | `0x14` | `Entity_RunMovementAiScript` **(directly — not a `HitReactToStateXX` leaf; see below)** |
| 1 | `0x20` | `Entity_HitReactToState97` |
| 1 | `0x23` | `Entity_HitReactToState99` |
| 2 | `0x4a` | `Entity_HitReactToStateCe` |
| 2 | `0x4b` | `Entity_HitReactToStateCb` |
| 2 | `0x4c` | `Entity_HitReactToStateD0` |
| 3 | `0x50` | `Entity_HitReactToStateDa` |
| 3 | `0x51` | `Entity_HitReactToStateE0` |
| 4 | `0x57` | `Entity_HitReactToStateE9OrAlt` |
| 4 | `0x58` | `Entity_HitReactToStateEc` |
| 4 | `0x59` | `Entity_HitReactToStateE6` |
| 4 | `0x5a` | `Entity_HitReactToStateFa` |

Every `Entity_HitReactToStateXX` leaf checked (`83`, `97`, `99`, and by extension the rest given the
identical shape) is a **trivial, confirmed** two-line setter: `entity[+1] = <state constant>;
entity[+0xc] = <script pointer constant>`. The hex in each name is literally the state byte it
writes — hit reactions are "jump into a specific hit-stagger/death animation state and hand control
to that state's script" (the `+0xc` script pointer, consumed by `Entity_RunScript`'s bytecode VM),
not bespoke per-enemy logic. The interesting part is *which* state/script each type jumps to, which
would require decoding each `+0xc` script pointer's own opcode stream — out of scope here.

**Type `0x14`'s hit reaction is a genuine oddity**: instead of a `HitReactToStateXX` leaf, it
re-enters `Entity_RunMovementAiScript` directly — being hit re-runs (part of) the movement AI
interpreter rather than switching to a canned reaction. Confirmed by both
`Entity_DispatchHitReactionByKind` and its sibling `Entity_HitReactDispatchByKind` below.

**A third, near-identical copy exists**: `Entity_HitReactDispatchByKind` (`1000:682f`, not to be
confused with `Entity_DispatchHitReactionByKind` above — the project's own naming came out this
close by coincidence across sessions) is called from inside `Entity_RunMovementAiScript`'s `'p'`/`'q'`
opcodes and reproduces the *exact same* per-world/per-type table (plus a knockback-direction byte
lookup from a table at `0xed3a` beforehand) — i.e. the movement AI script can itself trigger a hit
reaction (e.g. a patrol enemy walking into an obstacle it "attacks"), reusing the same table rather
than duplicating handler logic.

## Movement-pattern catalog

### Patrol with 3-tile lookahead — `Entity_ThinkPatrolAI` (`1000:5f14`)

**Confirmed**, the shared foundation nearly every non-gate/non-sleeper handler above delegates to
when idle (state `+1==0` and not globally script-locked, `[0x8bc7]==0`). Each frame:

1. Read 3 tile-lookahead flags via a **swappable pointer table at `[0xef23]`**, indexed relative to
   a scan-base pointer at `[0x8bd7]`: offsets `-1`, `-2`, and `0` from that pointer.
2. If **both** of the `-1`/`-2` flags are set → `Entity_SelectAiScriptTableBlocked` ("blocked" case).
3. Else if the `0` flag is clear → `Entity_SelectAiScriptTableClear` ("clear path" case).
4. Else → `Entity_SelectAiScriptTableDefault` (mixed/edge case).

Each selector sets the opcode-stream pointer `[0x8c77]` to one of three base tables — **confirmed
exact addresses**: `0xec7c` (blocked), `0xec68` (clear), `0xec90` (default) — offset by the entity's
own **animation-set selector** (`+0x39`), then calls `Entity_RunMovementAiScript` (below) to
actually execute the chosen opcode stream. So each of the ~10 animation-sets used across all enemies
gets its own 1-byte-per-table opcode sequence for each of the 3 terrain situations — 30 short
scripts total, not one shared movement routine per enemy type.

**The `[0xef23]` swappable table is confirmed real**, not a fixed address: two handlers
(`Entity_ThinkPatrolWithCustomTileTableA`/`B`) explicitly overwrite it from its default
(`0xf189`) to an alternate table (`0xf27b`) immediately before calling `Entity_ThinkPatrolAI`, then
restore the default afterward — letting the same shared patrol code enforce different
terrain/collision rules for specific enemy types without duplicating `Entity_ThinkPatrolAI` itself.

### `Entity_RunMovementAiScript` (`1000:6320`) — the opcode VM

**Structure confirmed, semantics characterized at the opcode level** (not decoded line-by-line — at
~150 dense decompiled lines per the project's own stated effort/payoff bar). Reads one character at
a time from the `[0x8c77]` stream set up above; recognized opcodes:

| Opcode | Role (confirmed from decompile) |
|---|---|
| `'n'` | **Turn-around/retreat.** Checks the entity's animation-set (`+0x39`) for specific values (`0`, `0xa`) or that the previous opcode was `'q'`, else rolls a random chance (`Entity_RollRandomBehaviorIndex`) — then calls `Entity_AiOpTurnOrRetreat`, which flips the entity's orientation/collision-blocked flags (`+0x14`/`+0x24`) or, for animation-sets `5`/`0xf`, escalates straight to a hit-reaction dispatch. |
| `'p'` | **Scan ahead (tile column).** Scans a tile column via `Entity_ScanTileColumnForFlag`; on a hit plus a random-chance pass, reads the swappable `[0xef23]` table and, depending on a charge/threshold field (`+0x36`) vs. computed distance, triggers `Entity_DispatchHitReactionByKind` — i.e. "obstacle/target found ahead → react/attack." |
| `'q'` | **Scan behind (tiles backward).** Same shape as `'p'` but scans backward (`Entity_ScanTilesBackwardForFlag`, twice, at two different offsets) and triggers `Entity_HitReactDispatchByKind` on success — a "check behind, then react" op, gated by orientation flags in `[0x8c2b]`/`+0x14`. |
| `'r'` | **Single-tile check-then-turn.** Reads one tile via the swappable `[0xef23]` table at `[0x8bd7]-1`; if clear and a random roll passes, either retreats (animation-set `0xa`) or is gated further by animation-set `5` — a lighter obstacle/edge check than `'p'`/`'q'`. |
| `'s'` | **Acquire target and decide.** The main "sense the world" opcode. For animation-set `0xa` ("prey capture" mode, confirmed by its use of `Entity_FindNextEntityByKind` — matches the already-named `Entity_AiOpCaptureNearbyPrey*` family), walks the entity list looking for a valid same/other-kind target; otherwise calls `Entity_ComputeDirectionAndDistanceToTarget` (below) against the player-ish target from `Entity_FindEntityByKind`. Based on the resulting direction bitmask and tile-distance thresholds (`[0x8c1b]`/`[0x8c1d]`, compared against `+0x37`/`+0x38` per-entity range fields), either falls through to opcode `'t'`'s approach logic, sets an attack/orientation state (`Entity_SetOrientationFlagsAndAnimRange`, `Entity_AiOpSpecialByKind`), turns away (`Entity_AiOpTurnOrRetreat`), or despawns/kills the target (`Entity_AiOpDespawnOrKill`) — this is the **chase/flee/capture decision point**. |
| `'t'` | **Approach and strike.** Scans up to 4 tiles backward (looped, `±0x80`-byte row stride — i.e. it can scan up or down a column depending on orientation `+0x14==4`) via `Entity_ScanTilesBackwardForFlag`; on finding the target/obstacle within a charge-threshold range (`+0x36`), calls `Entity_HitReactDispatchByKindWithKnockback` — the final "close enough, hit with knockback" step chase sequences resolve into. |

**Supporting primitives, all confirmed:**

- **`Entity_ComputeDirectionAndDistanceToTarget`/`ToEntity`** (`1000:721f`/`7227`) — the core "sense
  the target" primitive. Computes a **4-bit direction bitmask** into `[0x8c29]` (bit `1`=target
  below, `2`=above, `4`=target left, `8`=target right — i.e. "which quadrant is the target relative
  to me") and **tile-quantized distances** `|dx|/32 → [0x8c1b]`, `|dy|/16 → [0x8c1d]` (32×16 being
  the tile unit already established elsewhere in this project). Every chase/attack range check in
  the opcode table above reads these two globals.
- **`Entity_RollRandomBehaviorIndex`** (`1000:71d5`) — the randomized-behavior mechanism referenced
  throughout `docs/engine.md`. Rolls `Rng_NextValue`, combines it with the entity's own `+0x38`
  field, and indexes a small lookup table at `0xeca4` to produce a 0/1 gate value in `[0x8be5]`.
  **Confirmed deterministic override**: when either demo flag (`[0x8ba4]` record or `[0x8ba3]`
  playback) is active, this *skips the RNG entirely* and forces the result to `1` — demo/attract-mode
  playback needs identical enemy behavior every run, so randomized AI choices are suppressed during
  demo record/playback.

Net effect: enemies are **not simple back-and-forth patrollers** — every "idle" enemy re-evaluates a
short opcode script every frame based on live tile-lookahead state, and a meaningful fraction of
enemies (animation-set `0xa`) actively hunt the nearest matching entity via the same distance/
direction primitive the player-facing "sense" system uses.

### The three per-animation-set script tables, dumped byte-exact

**Confirmed exact — read directly from live memory** (`read_memory` at `6de3:ec68`, 120 bytes),
resolving the single open item this doc previously flagged as "not dumped." The addressing is
simpler than it first looks: `Entity_SelectAiScriptTableClear/Blocked/Default` each set
`[0x8c77] = tableBase + entity[+0x39]` **directly** — no pointer indirection — so an animation-set's
"script" is not a fixed-length record, it's just **the byte stream starting at that one offset**,
read forward one opcode at a time until an opcode that unconditionally returns is hit (`'n'`, or any
byte outside `n p q r s t`, which the interpreter treats as an implicit stop/no-op — call it `'o'`,
since that's overwhelmingly what the padding bytes spell). Because `'p'`/`'q'`/`'r'` (and some `'s'`/
`'t'` fallback branches) only *conditionally* return — otherwise they fall through to read the *next*
byte in memory — a script can run forward past its own nominal slot into a neighboring animation-set's
bytes; the table was clearly hand-packed with this in mind (short/no-op scripts placed so they don't
interfere with a preceding multi-op script's overrun).

The three 20-byte tables sit contiguously (`0xec68`→`0xec7c`→`0xec90`→`0xeca4`), confirming the
addresses and sizes already documented above. Read as raw characters, indexed by animation-set
(`+0x39`) `0`-`19`:

| animSet | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Clear** (`0xec68`) | n | o | o | o | o | s | p | r | n | o | s | r | n | o | o | t | p | r | n | o |
| **Blocked** (`0xec7c`) | n | o | o | o | o | s | q | n | o | o | s | n | o | o | o | q | n | o | o | o |
| **Default** (`0xec90`) | s | o | o | o | o | s | o | o | o | o | s | o | o | o | o | t | o | o | o | o |

Reading each animation-set's literal script (start at its column, continue right until the next `'o'`
or the interpreter would unconditionally stop):

- **animSet 0** — Clear: `n` (turn around immediately). Blocked: `n` (same). Default: `s` (re-assess
  target/direction). A baseline patroller: plain movement when unobstructed or hard-blocked just
  turns around; the "mixed" case re-senses instead.
- **animSet 5** — `s` in all three tables: this animation-set (used by the sleeper pair and the
  vertical pathfinder, both already documented as "hunting" states) always re-senses the target
  regardless of terrain situation, consistent with a chase-focused enemy that ignores simple
  terrain-based turning.
- **animSet 6/7** (Clear only: `p`,`r`) — a "scan ahead, then single-tile check" pair, only defined
  for the clear-path case (Blocked/Default fall to their own animSet-6/7 slots, which are `q`,`n` and
  `o`,`o` respectively — i.e. this animation-set behaves differently per terrain situation, not just
  "always chase").
- **animSet 10 (`0xa`)** — `s` in Clear/Blocked, `s` in Default: the "prey capture" animation-set
  (already identified via the `'s'` opcode's own special-case branch) re-senses in every terrain
  situation, matching its already-documented "actively hunts the nearest matching entity" behavior.
- **animSet 15 (`0xf`)** — Clear: `t` (approach-and-strike immediately, no scan needed — an aggressive
  type that's already "sure" of its target when the path is clear); Blocked: `q` (scan behind
  instead); Default: `t` again.
- **animSet 16/17** (Clear only: `p`,`r`) — same shape as animSet 6/7, only populated for the
  clear-path table.
- All other animation-sets (`1-4`, `8-9`, `11-14`, `18-19` in every table, plus most of `1-14`/`16-19`
  in Blocked/Default) are bare `'o'` — no special reaction; the entity relies entirely on
  `Entity_ThinkPatrolAI`'s outer terrain-flag branching and the generic move/animate step for its
  behavior. Concretely, this means **most of the 20 animation-set slots are never used as real script
  entry points** — the actual animation-set values assigned to real enemies (per the per-type
  handlers above) cluster around the handful of non-`o` slots (`0`, `5`, `0xa`, `0xf`, and the
  Clear-only `6`/`7`/`16`/`17` pairs); the rest of the table is inert padding that only matters because
  a preceding non-terminating opcode might read into it.

**The `0xeca4` probability-ramp table** (immediately following the three script tables, also read in
the same memory dump — 60 bytes, matching `Entity_RollRandomBehaviorIndex`'s own indexing math):
six 10-byte rows, row `k` (`0`-`5`) holding `(9-k)` zeros followed by `(k+1)` ones — i.e. a **10%,
20%, 30%, 40%, 50%, 60% escalating hit-rate staircase**. `Entity_RollRandomBehaviorIndex` combines
`Rng_NextValue`'s output with the entity's own `+0x38` field (multiplied by 9, folded through two
mod-reductions) to land on one byte in this table — so `+0x38` acts as a **per-entity aggression/
difficulty dial**, selecting which row (and thus which flat probability) that entity's random checks
resolve against, rather than every enemy sharing one fixed chance.

### Gate/switch family — `Entity_ThinkSwingingGate`/`SlidingGate`/`RotatingGate` + `Entity_ThinkGateSwitchAI`

**Confirmed.** Three thin per-type wrappers, one per world (`0x12` world 1, `0x54` world 3, `0x5d`
world 4 — no world-2 gate type found), each just sets a **target X position** (`[0x8c25]`: `0x86`,
`0x2b`, `0x2a` respectively) and calls the shared `Entity_ThinkGateSwitchAI` (`1000:7014`). That
shared function: while state `+0x40==0`, uses `Entity_ComputeDirectionAndDistanceToTarget` +
`Entity_RollRandomBehaviorIndex` gating to decide whether to start moving toward the target X (with
per-kind exact next-state/script constants), then on reaching the target X, rolls a chance to settle
into a "parked" state family (`0xb`/`0xc`/`0xd`) with an animation-frame lookup from a small table at
`0xecfe` keyed by a charge-threshold field (`+0x36`). `Entity_UpdateBehavior`'s class-4 branch
additionally inlines an explicit vertical-motion state machine for states `0xd`/`0xb` (raise/lower on
a counter with per-frame speed field `+0x28`) specifically for type `0x12` — i.e. the world-1 gate has
an extra vertical bob/swing on top of the shared horizontal-target logic. Net behavior: a
gate/platform that patrols toward a fixed X position, randomly settles, and (world 1 only) also
bobs vertically while parked — consistent with a swinging/sliding/rotating obstacle gate.

### Sleeper wake-up — `Entity_ThinkSleeperWakeUp`/`WakeUpQuiet` (world 2, types `0x48`/`0x49`)

**Confirmed.** While asleep (animation-set `+0x39==5`), every frame calls
`Entity_ComputeDirectionAndDistanceToTarget`; if the target is below-and-blocked-direction (bit `2`
of the direction mask, ANDed against the entity's own orientation flags `+0x14`) **and** within both
tile-distance thresholds (`[0x8c1d]` and `[0x8c1b]<3`), rolls a random chance and then wakes: resets
position/hitbox fields, sets state `0x46` ("waking"). `Entity_ThinkSleeperWakeUp` additionally plays
a wake sound effect and sets an animation-frame range (`0x2f`–`0x30`); the "quiet" sibling doesn't. A
subsequent frame where state is already `'F'` (`0x46` continuing) transitions both to attack state
`0x65`. A textbook "sleeping enemy wakes when the player gets close and below" pattern, with a
loud/quiet variant pair.

### Charging hazard — `Entity_ThinkChargingHazard` (world 1, type `0x20`)

**Confirmed.** Builds/decays a **charge counter** (`+0x2a`, clamped `0`–`0xc`, ±2 per frame) based on
a random roll, while delegating to `Entity_ThinkPatrolAI` when idle for its default movement.
Actual X movement is applied via `Entity_MoveXOrResetChargeCounter` (not independently decoded here —
name from a prior pass). After moving, checks two more `[0xef23]`-table tile flags; one branch
kills the entity outright when `[0x8b8b]==6` holds *and* the orientation isn't `4`.

**The `[0x8b8b]==6` anomaly is now resolved — confirmed, not "world 6".** `search_instructions` for
every reference to `[0x8b8b]` across the binary shows it is **not** a second "world number" copy
despite the `if([8b89]==0) x=[8b8b]` fallback idiom used elsewhere (that idiom only ever compares it
against `1`-`4`). Several call sites (`Game_StartAttractDemoAndRunLoop`, `Game_WarpToLevelStageAndRunLoop`,
`Debug_HandleCheatInput`, `Level_InitStateForWorld1Sublevel1`) unconditionally write the literal
constant `1` into it at level/sub-level start, and other readers compare it against `0`, `6`, and `8`
— values that make far more sense as a **sub-level index** than a world number (world 3's HUD code
is already documented elsewhere as branching on "past sub-level 7"). The clinching evidence:
`Level_RunScriptedEventStream` (`1000:c230`) contains the **byte-identical instruction**
`CMP word ptr [0x8b8b],0x6` (opcode bytes `833e8b8b06`) — and `docs/formats/pin-level-script.md`
already independently documented that exact check as "a hardcoded world-1/sub-level-6 cutscene
trigger." `Entity_ThinkChargingHazard`'s kill condition is checking the **same sub-level-6 trigger
point** — i.e. this charging hazard specifically self-destructs at a scripted moment in world 1's
sub-level 6, matching an already-known level event, not an undiscovered fifth/sixth world. Otherwise
just flips orientation flags. Net behavior: an enemy that winds up (charges) and moves faster/further
while charged, existing only in world 1.

### Vertical pathfinder — `Entity_ThinkVerticalPathfinder` (world 3, type `0x4f`)

**Confirmed.** While hunting (animation-set `5`), computes direction/distance to target, and if in
range, checks **4 tiles spaced `0x80` (128) bytes apart** in the map buffer — a scan straight up or
down a full column (direction depends on orientation `+0x14==4`) — requiring all 4 to be "climbable"
(high bit set) before committing to a climb state (`0xdd` up / `0xde` down). When not hunting, rolls
into a default movement state (`0xdc`) with an extra toggle for animation-set `0xf`. Reads as an
enemy that only climbs/descends when it has verified a full clear vertical path first, rather than
committing partway.

### Edge/obstacle-triggered reset — `Entity_ThinkEdgeDetectReset` (world 2, type `0x4b`)

**Confirmed.** Delegates to `Entity_ThinkPatrolAI` normally; while in a specific "triggered" state
(`+0x40=='g'`/`0x67`), re-checks 3 tile flags via the swappable `[0xef23]` table and, on a
clear/matching pattern plus a random roll, **resets to a home position** (state `0`, fixed
X-position/hitbox constants `0x28`/`0x2f`) — otherwise stays in the triggered state, toggling
orientation/collision flags. Reads as an enemy or trap that, once triggered by something (an edge or
obstacle encounter), eventually resets back to its patrol start point.

### Idle fidget — `Entity_ThinkPeriodicIdleFidgetA`/`B` (world 1 type `0x14`, world 2 type `0x4c`)

**Confirmed**, trivial: a per-entity frame counter (`+0x2e`) reaching `10`, gated on a specific
animation-frame value (`entity+0xa == 0xc` for A / `== 10` for B), rolls a chance to switch to a
one-shot idle-fidget state (`0x89` for A, `0x52` for B) — a small "occasionally blink/twitch while
idle" flourish layered on top of the shared patrol logic (delegated to when not fidgeting).

### Generic patrol delegates — `Entity_ThinkPatrolDefaultA`–`H`

**Confirmed** for A, B, C, D, E (spot-checked; F/G/H share the identical `0x2c`-family shape by
construction of the dispatch table and naming pattern, not independently re-verified). Every one is
a **1–2 line pure delegate** to `Entity_ThinkPatrolAI` when idle (`+1==0`, sometimes additionally
gated on `[0x8bc7]==0`) — i.e. these are not 8 different behaviors, they're the *same* patrol
behavior assigned to different `(world, type)` slots in the dispatch table, presumably because each
world's content needed its own named entry point even though the logic is shared. `0x2c`
(`Entity_ThinkPatrolDefaultC`) is the one type reused verbatim across all four worlds' dispatch
tables — likely a common generic hazard/prop rather than a per-world-specific enemy (also the one
type in this whole system whose sprite bank is `6` (`extras`/`extraxN`) rather than `7` (`nastyN`) —
see the sprite cross-reference below).

### Patrol with custom tile table — `Entity_ThinkPatrolWithCustomTileTableA`/`B` (world 3, types `0x50`/`0x51`)

**Confirmed**, and the concrete evidence for the `[0xef23]` swappable-pointer mechanism referenced
throughout: both temporarily overwrite `[0xef23]` from `0xf189` to `0xf27b` around their
`Entity_ThinkPatrolAI` call, then restore it. Variant B additionally has an extra state branch for
animation-set `0xa` that transitions to a distinct state `0xef` — the same "prey capture" animation
set the `'s'` opcode above treats specially — consistent with B being a flying/hovering predator
variant of the same patrol logic.

## Ground-collision per-kind reactions — a related, separate table family

Not the focus of the first pass on this doc, but now decoded to concrete per-world/per-type detail
(a full branch-by-branch pass over `Entity_ApplyGroundStateTransition`, `Entity_ProcessGroundStateByWorldAndKind`,
and `Entity_ApplyGroundStateTransitionByKind`). This is a **separate pipeline from ground/landing
physics's parent, `Entity_ResolveGroundCollision`** (see `docs/engine.md`'s already-documented
breakable-tile mechanic) that reacts to *what a breakable-tile-type entity should do* once ground
contact/collision is detected — parallel to, and keyed by the same `(world, type)` shape as, the two
per-frame tables above, but over a **disjoint range of type values** (roughly `0xa`-`0x44`: breakable
blocks and world-specific attack/break states, never overlapping the patrol/chase enemy types).

**Confirmed pipeline shape**: `Entity_ApplyGroundStateTransition` (`1000:e696`) is the entry point,
gated on two ground-scan-result bytes (`[0x8bca]`/`[0x8bc6]`) that pick between three parallel
per-class (`+4`) dispatch tables (a "no landing yet", "landed cleanly", and "landed hard" variant of
essentially the same class-keyed routing: `Entity_SetIdleAnimFrameByKind`/`SetIdleStateByKind` for
classes 2/5/6, `Entity_SetStateOnWorld4Kind`/`Entity_ProcessGroundStateByWorldAndKind` for class 7,
`Entity_ApplyComplexGroundResponse` for class 3 — i.e. the player). **RESOLVED: the "landed hard"
class-2 entry point, `Entity_ApplyGroundStateTransitionVariant` (`1000:f28d`)**, is not a fourth
distinct mechanism — it's confirmed as `Entity_SnapToGroundBoundaryYAlt()` followed by a
byte-for-byte copy of `Entity_ApplyGroundStateTransition`'s own inlined class-2 idle/settle-state
branch (types `0x14`/`0x20`/`0x2c`/`0x8d`), just reached via the "landed hard" scan-flag path with
an added Y-boundary snap. Class 7 is where the interesting per-world/type breakable-block logic
lives:

- **World 1** (`Entity_ProcessGroundStateByWorldAndKind`): types `0xa`/`0xb`/`0xc`/`0xd` flip a `'<'`
  breakable-tile marker byte in the level-map buffer to negative (the same in-place rewrite mechanic
  `Entity_BreakTileOrBounce` already documented uses), play a sound, and call
  `Entity_SplitOrSpawnChild` — a **four-part breakable block that splits into a child entity when
  broken**. Type `0x10` and world 2's type `0x34` share one transition (state `0x5c`, script
  `0xcac4`) via a common label — the *same reaction*, reused across worlds for whichever type each
  world assigns to it. Types `0x27`/`0x44`/`0x28`/`0x5f` recur in **every** world's branch and fall to
  a shared tail: decay a knockback/charge byte (`+0x26`), and once it drops below `4`, finally call
  `Entity_ApplyGroundStateTransitionByKind` for the actual state assignment (with a sound cue for
  types `0x28`/`0x44`/`0x5f` or any class-7 entity) — these four types are the **cross-world generic
  hazard blocks** (consistent with their shared bank-6 `extras` sprite, confirmed below).
- **World 2**: type `0x3f` calls the dedicated `Entity_BreakTileAndSetState84` leaf; types
  `0x30`-`0x33` are recognized (mark a "first-hit" byte `+0x29=0xff`) and fall to the shared tail
  rather than being killed as unrecognized.
- **World 3**: types `0x35`-`0x38` break a tile directly ahead and/or behind (`Entity_BreakSpecificTileChar`,
  checking the map-buffer byte's own sign bit rather than a fixed `'<'` char) and escalate a per-entity
  hit counter (`+0x29`) against a global threshold (`[0x8c03]`) before calling
  `Entity_SetAttackStateWorld3` — a **multi-hit breakable block** (survives N hits before its final
  state transition). Type `0x39` is a single fixed transition (state `0x2c`, script `0xc726`) —
  **confirmed identical** to `Entity_SelectNextStateByWorldAndKind`'s own type-`0x39`/`0x4e`/`0x4f`
  branches (see above), i.e. this world-3 type's "broken" reaction and its "cleared by the global
  defeat event" reaction are the literal same target state.
- **World 4**: types `0x3a`-`0x3d` require a global flag `[0x8be7]==0` and not-already-settled
  (extended-state `!='e'`), then apply one fixed "just landed" transition (state `0x9f`, script
  `0xd103`, collision flags `|=2`). Type `0x3e` shares world 1/2's `0x10`/`0x34` common transition.

**`Entity_ApplyGroundStateTransitionByKind`'s own final step** confirms the same pattern one level
deeper: for the cross-world generic types (`0x44`/`0x27`/`0x28`/`0x5f`/`0x16`), it writes one
hardcoded `(state, script)` pair each and calls it done; for anything else it defers to
`Entity_SetAttackStateWorld1`-`4` (confirmed, each a **trivial per-type `(state, script)` leaf
setter**, exactly the same shape as the `Entity_HitReactToStateXX` family documented above — e.g.
world 1's `Entity_SetAttackStateWorld1` sets one of four distinct settle states for types
`0xa`/`0xb`/`0xc`/`0xd`, gated on the entity not already being in that state).

### Sprite cross-reference for the ground-collision type range

Same method as the AI-enemy table's cross-reference above, applied to every type value found across
`Entity_ApplyGroundStateTransitionByKind`/`Entity_ProcessGroundStateByWorldAndKind`:

| Types | Bank | File | Role |
|---|---|---|---|
| `0xa`-`0xd`, `0x35`-`0x39`, `0x3b`-`0x3e` (per-world unique breakable blocks) | 3 | `specialN.pak` | per-world special-effect/breakable-block sprites |
| `0x10`, `0x27`, `0x28`, `0x16`, `0x30`, `0x3a`, `0x44`, `0x5f` (cross-world generic hazards) | 6 | `extras`/`extraxN` | shared decorative/hazard-block sprites |
| `0x3f` | 2 | `bitkid`/`kidxN` | the one exception — a world-2-only type drawn from the player-adjacent bank |

This is a clean, **different signature from the AI-enemy think table** (which was exclusively bank 7
`nastyN` + one bank-6 exception) — strong structural confirmation that the ground-collision table
really is a distinct "breakable/hazard block" system (bank 3/6 special-effect and decoration sprites)
rather than an overlap with the patrol/chase "nasty" enemies documented above.

## The player's own ground response — `Entity_ApplyComplexGroundResponse` (`1000:f489`)

**RESOLVED this pass.** This is the class-3 (player) leaf of `Entity_ApplyGroundStateTransition`'s
dispatch (the same entry point the breakable-block tables above hang off). Raw disassembly (not the
decompiler's confused pseudocode, which mislabels the current entity as two unrelated pointers —
see the register note below) shows a clean, confirmed state machine keyed on `[0x8b98]`, the same
global entity-script-VM opcode `0x3C` writes and opcode `0x3F` reads as **"last found/target type"**
(see `docs/entity-script-vm.md`) — i.e. the player's landing response depends on what special
entity was last tracked elsewhere in the frame, not on a fixed "landing flavor" enum as an earlier
pass guessed:

- **`[0x8b98] == 0x21` or `0x41`** — round Y to the next tile boundary and set the "blocked below"
  collision flag; return immediately. `0x41` doubles as the "carried-item type" marker
  `docs/entity-script-vm.md` documents, so a normal landing while that's active still just snaps to
  the tile grid.
- **`[0x8b98] == 3`** — defers entirely to `Entity_ClearStateIfGroundContact`.
- **`[0x8b98] == 0xff`** (no target tracked) — no-op return.
- **Own state `== 0x35`** (checked on the entity's own `+1` field, independent of `[0x8b98]`) — the
  **ground-pound/block-break path**: rounds Y to the tile boundary, calls
  `Entity_BreakBlockChainWorld3` directly (**confirmed: the player, not just enemies, can trigger
  the world-3 breakable-block chain**), clears speed/state, and either plays a sound and resets to a
  fixed idle pose (if world-select bits `[0x8b67]&0xf` are set) or transitions to state `0x16`
  (script `0xc62d`).
- **`[0x8b98] == 0x15`** (the checkpoint-related state value `Entity_ProcessCollisionState15`
  already documents) or **`0x43`** (world 4's boss kind, per the same per-world boss-kind table
  above) — each rounds Y to the boundary, and the `0x43` path additionally triggers a sound,
  calls `Entity_ClampCameraOffset` (confirming this whole function really is player/camera-specific),
  and sets a **per-world-select fall-recovery speed** (`8`/`0xc`/`0x10` depending on which
  `[0x8b67]` bit is set) into the speed field before settling to idle.
- **`[0x8b98] == 1`** (the common case) — a denser sub-dispatch reading the ground-scan-result bytes
  (`[0x8bca]`/`[0x8bc6]`/`[0x8bc9]`/`[0x8bcb]`/`[0x8bcc]`) and a world/state flag `[0x8be7]` to decide
  whether to round to the tile boundary and break the world-3 block chain, matching the same
  "solid landing" shape as the other branches above.
- **Shared tail (all of the above except the two early-return cases)**: triggers a sound, and if the
  "blocked below" collision flag is set, resets speed/state to idle outright; otherwise **decays the
  speed field (`+0x26`) by repeated halving each landing frame until its magnitude drops below 4**
  — the exact same decaying-recoil idiom already documented for enemy knockback
  (`Entity_ApplyGroundStateTransition`'s own tail) and hit reactions — i.e. **player landing recoil
  uses the identical physics idiom as enemy hit-knockback**, just gated by class 3. A final
  unconditional step (reached from every path) nudges X by one tile width (`±0x20`) if the entity's
  collision flags don't already overlap its own orientation/hitbox mask — a horizontal tile-snap
  correction, direction chosen by orientation `==4` vs. otherwise.

**Register note (a real decompiler gotcha, not a two-entity mechanism)**: the decompiled pseudocode
for this function (and `Entity_HandleWorld3SpecialTrigger` below) shows both `in_BX` and
`unaff_SI` accessing entity fields with the *same* offsets (`+1` state, `+0x26` speed, `+0x14`
hitbox, `+0x6` X) that would normally only appear once per entity. Raw disassembly confirms these
are **two register copies of the identical single entity pointer** — `Entity_UpdateAll`'s loop sets
up `SI` as the sole per-entity pointer, and something upstream in `Entity_UpdateBehavior` copies it
into `BX` as well; the compiler then freely alternates between `[BX+disp]` and `[SI+disp]`
addressing forms for the same struct with no functional difference. Worth flagging because it's an
easy trap when reading any function in this cluster's decompiled output cold.

## The world-3 boss-defeat trigger — `Entity_HandleWorld3SpecialTrigger` (`1000:d42c`)

**RESOLVED this pass — no longer a guess.** Called unconditionally from the class-3 (player) branch
of `Entity_UpdateBehavior` every frame world 3 is active (see the class table above). Raw
disassembly (the decompiler's pseudocode is misleading here for the same `BX`/`SI`-aliasing reason
as above, **except** in this function `BX` and `SI` genuinely *do* diverge partway through: `SI`
stays the player entity throughout, while `BX` gets reloaded via repeated
`Entity_FindNextEntityByKind` calls searching for **kind `0x41`**) resolves this as a **four-phase
boss-defeat reward sequence**, driven natively rather than through the entity-script VM:

1. **Watch phase**: every frame, scans for the world-3 boss entity — **kind `0x41`, confirmed as
   world 3's boss kind by an independent source**: `docs/entity-script-vm.md`'s opcode `0x3A`
   (`EntityScriptOp_WaitForBossDefeatThenKillSelf`) has its own hardcoded per-world boss-kind table
   `0x15/0x40/0x41/0x43` for worlds 1–4, and this function's world-3 gate (`[0x8b89]==3`) searching
   for exactly `0x41` lines up perfectly. The search terminates on the same "defeated" sentinel op
   `0x3A` also checks generically: `+0x40 == 0xf6`.
2. **On defeat detected**: freezes the boss's frame to `0xe3`, locks the player into a short
   (`0x36`–`0x38`) victory-animation loop, sets `[0x8b98] = 0x41` (marking the sequence in progress
   — the exact scratch value `Entity_ApplyComplexGroundResponse` above and entity-script opcode
   `0x3F` both react to), clears both entities' state bytes to idle, then scans upward through the
   level-map buffer (up to 5 tile-rows, `0x8bd7`/`0x8bd9`) for the first open row and pushes **two**
   position-events there (`Entity_PushPositionEvent`, event-type constants `0x52` then `0x55`) plus
   a sound — a **reward-item shower falling from above the defeat point**, structurally the same
   concept as (but a separate, hardcoded implementation from) the generic "reward-shower cutscene
   template" `docs/entity-script-vm.md`'s opcode `0x44` walks via script.
3. **Short follow-up window** (`[0x8bea] <= 0x21`, a frame counter reset alongside step 2): re-locks
   the player onto a single frozen frame (`0x4f`) and, the first time through, nudges the boss into
   an explicit settle state (`0xd`, script `0xc5a5`) and re-finds it to set a slightly different
   frame (`0xe4`); once that's applied, flips `[0x8b98]` from `0x41` to `0x1a` — the **same value**
   `docs/entity-script-vm.md`'s opcode `0x3F` documents as "the player-carried-item type", i.e. this
   sequence's tail end plausibly hands off to a carried-item spawn read by whichever other entity's
   script runs that opcode (the opcode-63 caller side wasn't independently identified this pass).
4. **After the window** (`[0x8bea] > 0x21`): clears `[0x8b98]` back to `0`, and once the boss's own
   charge field has gone negative (a falling/dying indicator) and the player isn't already marked
   complete, does the final step — resets both entities to neutral, marks the player's
   sequence-complete state (`0xaa`, script `0xd171`), and awards a bonus item
   (`Entity_ChooseAndSpawnBonusItem`) unless a suppression flag (`[0x8b96]`) is set.

**Relationship to entity-script-VM opcode `0x44` (`EntityScriptOp_RunSpecialInteractionSequence`)**:
**confirmed as two independent mechanisms, not one** — the "strengthened lead" theory from the
previous pass doesn't hold up. No call-graph link exists (`Entity_HandleWorld3SpecialTrigger`'s
only caller is `Entity_UpdateBehavior` via a direct static call; opcode `0x44`'s handler is reached
*only* through the script VM's indirect jump table and has no static callers at all). No shared
mutable state either: opcode `0x44`'s non-type-3 branch reacts to `[0x8c04]`/`[0x8bff]`/`[0x8bb4]`/
`[0x8bee]`/`[0x8c06]` — a completely disjoint set of globals from this function's
`[0x8b98]`/`[0x8bea]`/`[0x8b96]`/`[0x8bd7]`/`[0x8bd9]`. They share a *concept* (boss/special-event
reward shower) and independently converge on the same building blocks
(`Entity_PushPositionEvent`/`Entity_FindNextEntityByKind`/`Snd_TriggerEffect`), but they are
genuinely parallel, separately-triggered systems. The real (if narrower) cross-link this pass found
is the `[0x8b98]` scratch register itself, shared with entity-script opcodes `0x3C`/`0x3F` as
described in phase 3 above.

## Cross-referencing type IDs against sprite identity

Every type value found in the two main dispatch tables resolves in `symbols/entity-shapes.json` to
**bank 7 (`nastyN.pak`, the "nasty" enemy sprite bank) — with exactly one exception**: type `0x2c`
(`Entity_ThinkPatrolDefaultC`, the type shared verbatim across all four worlds) resolves to **bank 6**
(`extras`/`extraxN`) instead. Confirmed by direct lookup:

| Type | descriptor `animStart`–`animEnd` | bank | Handler |
|---|---|---|---|
| `0x12` | 132–135 | 7 (nasty) | `Entity_ThinkSwingingGate` |
| `0x13` | 41 | 7 (nasty) | `Entity_ThinkPatrolDefaultB` |
| `0x14` | 12 | 7 (nasty) | `Entity_ThinkPeriodicIdleFidgetA` |
| `0x20` | 196–203 | 7 (nasty) | `Entity_ThinkChargingHazard` |
| `0x23` | 214 | 7 (nasty) | `Entity_ThinkPatrolDefaultA` |
| `0x2c` | 246 | **6 (extras)** | `Entity_ThinkPatrolDefaultC` |
| `0x42` | 84–85 | 7 (nasty) | `Entity_ThinkPatrolDefaultD` |
| `0x48`/`0x49` | 42–45 / 49–52 | 7 (nasty) | sleeper pair |
| `0x4a`/`0x4b`/`0x4c` | 28 / 40–47 / 10 | 7 (nasty) | patrol/edge-reset/fidget |
| `0x4f`/`0x50`/`0x51`/`0x54` | 20 / 0–4 / 7 / 40–43 | 7 (nasty) | pathfinder/patrol/gate |
| `0x57`–`0x5a`/`0x5d` | 0–7 / 20–27 / 10–17 / 50–55 / 40–45 | 7 (nasty) | world-4 patrol/gate set |

This is a strong structural confirmation that **the AI dispatch tables this doc describes ARE "the
enemy behavior system"**, near-exhaustively (every `nastyN.pak` enemy sprite type maps to exactly one
of these handlers), with `0x2c` as the one cross-world generic hazard/prop drawn from the shared
`extras` bank instead of a per-world enemy bank.

## What remains genuinely open

A second pass resolved most of what the first version of this doc left open (branch-by-branch
`Entity_UpdateBehavior`, the ground-collision per-kind tables, classes 1/5/6/7's roles, the movement
scripts' literal bytes, the `[0x8b8b]==6` anomaly, and class 3/player's dispatch entry point — see
the sections above). What's left, honestly:

- **RESOLVED (separate doc): `Entity_RunScript`'s opcode VM.** What each `+0xc` script pointer's
  bytecode stream actually does — the frame-by-frame content behind every `(state, script-pointer)`
  pair this doc catalogs above — is now decoded. The table is 78 opcodes (not 256), all
  characterized, with two real scripts decoded byte-exact showing decelerating recoil/approach
  animations. See `docs/entity-script-vm.md` for the full writeup (a separate VM from the movement
  AI interpreter documented above — don't conflate the two).
- **RESOLVED: `Entity_HandleWorld3SpecialTrigger`'s narrative role and its relationship to
  entity-script-VM opcode `0x44`.** See the dedicated section above — it's a native, four-phase
  world-3 boss-defeat reward-shower sequence (kind `0x41`, cross-validated as world 3's boss kind
  by opcode `0x3A`'s per-world table), confirmed as a *separate* mechanism from opcode `0x44`
  (no call-graph link, no shared globals beyond the `[0x8b98]` scratch register) — the earlier
  "strengthened lead" guess didn't hold up under an actual xref/decompile check.
- **Class 5's "carried player item" identity** (types `0x1a`/`0x41`) is an informed reading of the
  code (parent must be class-3/player, frame-indexed offset table) but not confirmed against
  gameplay footage — could equally be a companion/pet rather than a carried pocket item.
  `Entity_HandleCollisionOrStateDispatch`'s five state-keyed sub-handlers (`Entity_ProcessCollisionState15`
  etc., already named from a prior pass) and `Entity_SetAttackStateWorld1`-`4`'s exact per-state
  script-pointer targets are similarly not traced past their own one-line leaf bodies.
- **RESOLVED: `Entity_RunMovementAiScript`'s three remaining sub-handler internals.**
  `Entity_AiOpTurnOrRetreat` (`1000:6b13`, the `'n'`-opcode handler): if `[0x8be9]`'s sign bit is
  clear, it just clears the orientation-masked bits out of the collision-flag field (`+0x24 &=
  ~(+0x14)`) — a plain "stop pushing into the wall" turn; if set, it's the hit-react variant —
  animation-sets `5`/`0xf` escalate straight into `Entity_HitReactDispatchByKind` using `+0x36` as
  the hit-react parameter, everything else no-ops. Absent that flag, it dispatches by kind/world:
  kind `0x42` and world `1`'s kind `0x14` (→ `Entity_SetState85`, state `0x85`/script `0xcf07`)
  get bespoke handling, kind `0x2c` calls `Entity_SetOrientationFlagsAndAnimRange`, everything
  else falls through to `Entity_ToggleOrientationFlags` (XORs `+0x14 ^= 0xc`, then ORs the result
  into `+0x24`) — i.e. flip facing and merge the new orientation into the collision mask. Both
  `Entity_ToggleOrientationFlags` and `Entity_SetState85` turned out to already be named,
  fully-decoded one-liners.
  `Entity_FindNextEntityByKind` (`1000:c192`): confirmed as a byte-for-byte analog of
  `Entity_FindEntityByKind`, just starting the linear scan from a caller-supplied record base
  instead of the table start — same `0x42`-byte struct stride, same match field (current-record
  `+0x2`, the "type" field), same `-0x46e8` table-end bound. Lets callers resume a search ("find
  the next match after this one") instead of always restarting from the first entity; used by the
  `'s'`-opcode capture-AI handlers to walk multiple same-type candidates.
  `Entity_RollRandomBehaviorIndex`'s fold arithmetic was, on inspection, already fully decoded and
  tagged `verified` from a prior pass (see the "Movement/behavior AI script system" section above)
  — the "not re-derived" note in an earlier version of this doc was stale.
  `Entity_AiOpChooseAttackVariant` (`1000:6cd4`, reached from type `0x42`'s move dispatch) **is**
  confirmed as a short leaf: within melee range (`[0x8c1b]<2`) it rolls a chance to jump straight to
  a close-range attack state (`0xd7`); otherwise it looks up a `(+0x26,+0x27)` value pair from a
  distance-indexed table (`-0x12e4`+`distance*2`) and transitions to a ranged-attack state (`0xd6`).
- **RESOLVED: `Entity_ApplyComplexGroundResponse`** (the class-3/player branch of the
  ground-collision pipeline) is now decoded — see the dedicated player-physics section above.
