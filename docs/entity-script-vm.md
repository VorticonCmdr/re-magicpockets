# The entity-behavior bytecode VM (`Entity_RunScript`, opcode table at `1000:2383`)

This is the "actual scripting language" `docs/engine.md` flagged as a future-session target, and is
a **separate system from `Entity_RunMovementAiScript`'s 6-opcode movement VM** documented in
`docs/enemies.md` — do not conflate the two. That one drives chase/patrol/flee decisions for a
handful of AI-enemy kinds via per-animation-set tables. This one is the general entity-behavior
scripting language: any entity with a script pointer (`+0xc`) runs it, once per frame, from
`Entity_UpdateAll`. It touches spawning, sound, palette fades, HUD text, and even the hardware
scroll-width register — a much broader surface than movement alone.

Confidence follows this project's convention: **confirmed** (disassembly/decompile-verified) vs
**guess** (structure clear, narrative role inferred).

## The VM loop (`Entity_RunScript`, `1000:22da`) — confirmed

```
if [SI+0xc] == 0:                       # no script yet
    [SI+1] = 0
    [SI+0xc] = table_cd88[state]        # seed from the default-script table (state = [SI+1] = 0 initially)
loop:
    opcode = *(signed char)[SI+0xc]
    if opcode == -1  (0xFF): return                       # stop
    if opcode == -4  (0xFC): tail-jump into "yield" code   # save position, abort this frame (see below)
    if opcode == -0x52 (0xAE): return (via a second, adjacent RET)
    call table_2383[opcode * 2]()       # opcode is 0x00-0x4D -- see "table size" below
    [SI+0xc] += 1                       # advance past the opcode byte; operand bytes are consumed
    goto loop                           #   by the handler itself via INC DI
```

`[SI+0xc]` is a **`6de3`-segment (data-segment) offset**, not a code-segment one — entity scripts
themselves live in the data segment alongside the state tables, distinct from the opcode *handler*
addresses, which are real code in segment `1000`. (First read attempt at `1000:cd88` decoded as
plausible-looking x86 — a red herring; the correct read is `6de3:cd88`.)

## The opcode table: 78 entries, not 256 — confirmed (corrected from the original guess)

`docs/engine.md` originally described a "256-entry function-pointer jump table." That was an
upper bound from the byte range, not the real table size. Tracing where the table's bytes stop
being valid pointers (byte offset `0x9C`/156 from `1000:2383`) lands exactly on
`1000:241f` — the start of `Entity_ResetExtendedFields`'s own code. **The real table is 78 words
(156 bytes), covering opcode values `0x00`–`0x4D`.** The three terminator/special values
(`0xFF`, `0xFC`, `0xAE`) all sit above this range, so the doubled-index arithmetic (`opcode*2 mod
256`) never collides with real table data for legal opcodes.

Every one of the 78 target addresses was **not** a Ghidra-recognized function before this pass —
computed `CALL DX` targets aren't picked up by static analysis. ~30 of the clearest/most
cross-referential ones were promoted to named Ghidra functions this pass (`EntityScriptOp_*`);
the rest are documented here by address only. None collapse onto already-named `Entity_*`
utility functions except opcode `0x13` (`1000:3ce8`), which **is** the entry point of the
already-documented `Entity_HandleCollisionOrStateDispatch` — that function is dual-purpose,
reachable both from `Entity_UpdateBehavior`'s per-kind dispatch *and* directly as a script opcode.

**Follow-up pass correction — opcode numbers 64-68 were off by one in the original table.** The
original transcription of the raw table silently skipped one real word entry (index 64, address
`0x2A4F`) and, as a result, mislabeled words 65-68's addresses as opcodes 64-67, leaving opcode 68
(`0x44`, address `0x2755`) completely undocumented. Re-read directly from `read_memory` at
`1000:2383` (156 bytes, 78 words, byte-exact) to get authoritative addresses — opcodes 0-63 and
69-77 were already correct; the table below fixes 64-68. The genuinely-missing opcode 64 turned
out to be a real, previously-untraced instruction (see below) — not a duplicate or padding.

## Corrections from reading the raw code, 2026-10-09 (`[STATIC]`, disassembled from `GAMEU.EXE`)

- **Opcode 9's pairs are `(horizontal delta, vertical delta)`, not `(dx, tile)`.** `1000:3C9B` reads the pair as the word `[bx+di]`: the SECOND byte, sign-extended, is applied vertically (positive through `1000:D5FD` = move down, negative through `1000:D609` = move up) and the FIRST byte horizontally (`D627` or `D615`, chosen by facing `[+0x14]` 0/8 vs other). So state 2's `00 F8, 00 F8, 00 FA, ...` is a 7-frame **vertical** deceleration, and state 8's `02 EC, 02 F0, ...` is +2 px horizontal per frame with a vertical arc of -20, -16, ... px: a jump arc. The tile-index reading above is wrong. The pair index lives in `[si+0x30]` (`add word [si+0x30],2` each frame), and the opcode parks (`jmp 2663`) until the `0xAE` terminator.
- **The movement helpers are collision-flag gated.** `D5FD` (down) skips if `[+0x24]` bit 1 is set, `D609` (up) if bit 0, `D627` (right) if bit 3, `D615` (left) if bit 2. For kind 3 (`[+4]==3`) the horizontal helpers instead step 4 px at a time (`add word [si+6],4`, `ax/4` iterations) and advance the animation frame `[+0xA]` through `[+0x10]..[+0x12]` once per 4 px: that is the hero's walk cycle, 4 px per frame, matching the captured 4 px per iteration.
- **`Entity_RunScript` seeding.** At `1000:2324` the seed path stores state 0 (`mov dx,0; mov [si+1],dl`) and looks up `0xCD88`, so an entity with `+0xC == 0` starts in state 0's script (`FF` = stop). States are installed by `Entity_SetStateAndScript`, not by this path. The routine is skipped for most types while `[0x8BA1]` is `0x32`/`0x45`/`0x66` or negative; types `0x2D, 8, 3, 1, 0x29, 7, 0x1F, 0xF` bypass part of those gates.
- **Hero states seen in the demo** (`web/..`/capture, `[PROVEN]` consistency): state 18 (`c60a`) = `SetCollFlags(-113); SetAnimFrame(78); WaitFrames(2); SetCollFlags(0); SetAnimFrame(79); Reset`; state 22 (`c62d`) adds `Sound(9)`. The capture shows `e1flags = 0xFF8F` (= -113 sign-extended) during exactly those states, then `0`.

## Full opcode table

`#` = opcode value (decimal / hex). `op` = named function where one was created this pass,
else the raw address. `bytes` = operand bytes consumed from the script stream (approximate for
untraced ones). No-ops (`RET` immediately, 15 of the 78 slots — opcodes 0,4,16,18,20,23,24,27,
32,41,42,44,48,56,72) are collapsed into one row.

| # (dec/hex) | address | name / description | operand bytes | confidence |
|---|---|---|---|---|
| 0,4,16,18,20,23,24,27,32,41,42,44,48,56,72 | `1000:2470` | **no-op** (`RET` immediately) — reserved/padding slots | 0 | confirmed |
| 1 / 0x01 | `EntityScriptOp_SetAnimFrame` (`3c44`) | sets current anim frame `[+0xa]` = operand | 1 | confirmed |
| 2 / 0x02 | `EntityScriptOp_WaitFrames` (`3c69`) | waits until per-entity counter `[+0x3e]` reaches operand N (increments once/frame, retries without advancing until match), then resets counter and advances | 1 | confirmed |
| 3 / 0x03 | `EntityScriptOp_RelativeJumpBack` (`3c7d`) | script pointer -= operand (relative backward jump/loop) | 1 | confirmed |
| 5 / 0x05 | `EntityScriptOp_SetHitboxSizeOrRandomize` (`3c1c`) | operand 0x00–0x11 → `[+0x14]`=operand; operand==0x12 → XOR `[+0x14]`,0xC; operand negative (top bit set) → RNG-pick 4 or 8 | 1 | confirmed |
| 6 / 0x06 | `EntityScriptOp_Kill` (`265d`) | `[+0x40]`=0x19 (dead), abort | 0 | confirmed |
| 7 / 0x07 | `EntityScriptOp_TriggerPaletteFade` (`3bbc`) | operand selects a 16-colour palette bank (world-gated: 7/0x13/0x14/0x15 for worlds 1-4 when operand==7) from the 24-bank table (`docs/memory-map.md`), loads it into the live palette buffer, calls the VGA palette-apply routine (`1000:170b`) | 1 | confirmed |
| 8 / 0x08 | `EntityScriptOp_SetPositionOrDequeueTarget` (`3a32`) | **fully resolved this pass.** operand==0 -> tail-jumps to sibling routine `3af0` (clears a stored target search into this entity's position). operand>0 (top bit clear) -> reads a 2nd byte N, sets position (+6/+8) to a fixed grid coordinate X=-32N,Y=-16N. operand<0 (top bit set) -> the real "dequeue" path: if busy-cache `[0x8c5f]`!=0, tail-jumps to `EntityScriptOp_HandoffToPlayerAndController` (`3b55`, previously undecoded); else pops a 3-word **(X,Y,state)** record — not (type,x,y) as originally guessed — from a queue at `[0x8c63]`, advancing the queue pointer by 6 bytes. If the popped X word==0 (terminator), tail-jumps to `EntityScriptOp_RecenterOnAnchorAndHandoff` (`3b7a`, previously undecoded). Otherwise: teleports self to the popped (X,Y); if the popped state word==0, finds+kills the kind==0x2b entity (the charging hazard, `docs/formats/pin-level-script.md`); else caches self's old position into `[0x8c5f]`/`[0x8c61]` and puts the kind==7 controller entity into the popped state (state byte set directly, script resolved via the `0xd996` negative-state table) | 1–2 | **confirmed end-to-end** (both subroutines decoded — see "Opcode 8's dequeue subsystem, fully resolved" below) |
| 9 / 0x09 | `EntityScriptOp_PlayDirectionalAnimTable` (`3c9b`) | plays an **inline** (dx-delta, tile) byte-pair table embedded right after the opcode, one pair per frame, until a `0xAE` terminator — see worked examples below | variable (embedded, not fixed) | confirmed |
| 10 / 0x0A | `2f8b` | finds another entity by kind (operand 1), waits until its `[+1]`==0, then sets its state/script via operand 2 (with remaps for 0x6b/0x4b) | 2 | confirmed mechanism; guess on narrative ("puppet" another entity) |
| 11 / 0x0B | `EntityScriptOp_CallStateScript` (`39ff`) | **Call**: saves current position in `[+0x2a]`, jumps to state-script(operand) — see "Call/Return" below. Type==0x42 special-case waits on global `[0x8b96]` instead | 1 | confirmed |
| 12 / 0x0C | `EntityScriptOp_Return` (`3a21`) | **Return**: resumes from `[+0x2a]` if set (clears it), else resets the whole script | 0 | confirmed |
| 13 / 0x0D | `EntityScriptOp_SpawnEffectByTypeCode` (`334e`) | rich ~19-way dispatch on a type-code operand, spawning positioned effects/items via `Entity_PushSpawnEvent`/`Entity_PushPositionEvent`/`Fx_PushQueuedPositionEvent4`/`5`. Several type codes (0x11,0x1d,0x1f,0x25,0x2b,0x44,0x53) match the nine special opcode types `docs/formats/pin-level-script.md` already flagged in `Entity_SpawnFromQueuedEvent` | 1+ | confirmed dispatch structure, **including type 0xa (see below, fully resolved this pass)** |
| 14 / 0x0E | `EntityScriptOp_GotoStateScript` (`31d6`) | jumps to state-script(operand) via the same `cd88`/`d996` tables, **no return saved** (a "goto", unlike op 11's "call") | 1 | confirmed |
| 15 / 0x0F | `EntityScriptOp_PlaySound` (`2670`) | operand 0 → `CALL Snd_StopEffect` (`1dae`, confirmed by name — stops the current sound), nonzero → `CALL Snd_TriggerEffect` (`1ccf`, confirmed by name — plays effect `(char)AX+1`) | 1 | confirmed (both call targets are already-named, decompiled functions) |
| 17 / 0x11 | `EntityScriptOp_WaitOrLoopBack` (`3c83`) | like op 2, but on mismatch reads a 2nd operand byte and jumps back by it — a bounded "count to N, else loop by M" | 1–2 | confirmed |
| 19 / 0x13 | `Entity_HandleCollisionOrStateDispatch` (`3ce8`, already named) | the existing collision/state dispatcher, directly reachable as a script opcode too | 0 (from the script's view) | confirmed |
| 21 / 0x15 | `EntityScriptOp_WaitUntilSyncTriple` (`2fca`) | reads 3 operand bytes, waits (retries) until globals `[0x8bb0]`/`[0x8baf]`/`[0x8bae]` all match them | 3 | confirmed |
| 22 / 0x16 | `EntityScriptOp_PokeByteValueThenOffset` (`3341`) | generic: reads (value, offset), writes value into entity+offset | 2 | confirmed |
| 25 / 0x19 | `39bd` | gated on entity X == 0x128 or 8 exactly; sets anim frame `[+0xa]` from a difficulty byte `[0x8c05]` formula | 0 | confirmed mechanism; guess on narrative |
| 26 / 0x1A | `EntityScriptOp_KillLinkedChildQuiet` (`2741`) | kills linked child (`[+0x2c]`), clears both sides' link field, calls `Snd_TriggerEffectRaw` (confirmed by name — raw `(char)AX` sound, no +1 offset) | 0 | confirmed |
| 28 / 0x1C | `32ee` | detaches linked child (clears both sides' `+0x2c`), calls `Snd_TriggerEffectRaw` (`1000:1d4c`, confirmed by name — resolves the previously-unidentified helper call) | 0 | confirmed |
| 29 / 0x1D | `3339` | sets collision flags `[+0x24]` = sign-extended operand | 1 | confirmed |
| 30 / 0x1E | `EntityScriptOp_WaitUnlessAiActive` (`3146`) | waits (retries) while global `[0x8ba1]` (AI-freeze flag) is nonzero | 0 | confirmed — direct cross-ref to `docs/enemies.md`'s AI-freeze finding |
| 31 / 0x1F | `32ce` | sets anim range `[+0x10]`/`[+0x12]`; first operand `0xFF` means "reset current frame to `[+0x10]`" instead | 1–2 | confirmed |
| 33 / 0x21 | `EntityScriptOp_SetSyncTriple` (`32bb`) | writes 3 operand bytes to `[0x8bb0]`/`[0x8baf]`/`[0x8bae]` — setter half of op 21's wait-gate | 3 | confirmed |
| 34 / 0x22 | `EntityScriptOp_SetAnimSetAndChargeFields` (`2c4c`) | writes 4 operand bytes into `[+0x39]`,`[+0x36]`,`[+0x37]`,`[+0x38]` (anim-set selector + the 3 charge-threshold fields `docs/engine.md` already names) | 4 | confirmed |
| 35 / 0x23 | `EntityScriptOp_PokeByteOffsetThenValue` (`32af`) | generic: reads (offset, value) — the argument-order twin of op 22 | 2 | confirmed |
| 36 / 0x24 | `EntityScriptOp_AddToPosition` (`32a0`) | adds two signed operand bytes to X (`+6`) and Y (`+8`) | 2 | confirmed |
| 37 / 0x25 | `31f5` | world-gated: consumes a small variable-length operand sequence, then **abandons the script VM's own call stack** and jumps into `Game_WarpToLevelStageAndRunLoop` (`1000:03ff`) or the main bootstrap (`1000:00ca`) — a scripted level-warp/restart, confirmed by exact address match | variable | confirmed (major finding) |
| 38 / 0x26 | `2474` | writes glyph codes into the HUD text buffer (`0xe70f`, same buffer `Hud_UpdateScoreDisplay` uses) keyed by input-device type `[0x8b5d]` and the keyboard scancode table (`0xedb4`) — looks like a "render control-prompt text" opcode | 0 | confirmed mechanism; guess on narrative |
| 39 / 0x27 | `3151` | waits on counter `[+0x3b]`, then advances current anim frame `[+0xa]` toward `[+0x12]` or wraps to `[+0x10]` — "advance through an anim range with a delay" | 1 | confirmed |
| 40 / 0x28 | `2c65` | sets `[+0x40]` (state/dead byte) = operand — general form of op 6's hardcoded kill | 1 | confirmed |
| 43 / 0x2B | `3031` | reads 2 operand bytes into working coord registers, conditionally calls `Entity_SetupDirectionVector` (`1000:30b3`, already named) if speed (`+0x26`) is unset | 2 | confirmed |
| 45 / 0x2D | `2fef` | finds another entity by kind (operand), then **swaps script pointers** between self and it (and swaps SI/BX so later opcodes in this call act on the other entity) | 1 | confirmed (structure) |
| 46 / 0x2E | `3004` | mirror-image pointer swap of op 45 (opposite XCHG order) | 0 | confirmed mechanism; guess on distinction from op 45 |
| 47 / 0x2F | `2ec0` | reads (dx-cap, dy-cap), computes a clamped move-toward/away step; special-cases type `0x2b` (`Entity_ThinkChargingHazard`'s own type, per `docs/enemies.md`) with a distinct counter `[0x8c6b]` | 2 | confirmed structure; guess on exact easing intent |
| 49 / 0x31 | `EntityScriptOp_SpawnLinkedEntityFromTemplateTable` (`2da7`) | operand!=0 -> directly calls `Entity_InitFromTemplateRecord` (`1000:c8c0`, confirmed by name) as a shortcut; operand==0 -> looks up a template-type byte via `[0x8bff]-0x1116` and spawns a linked companion via the same `Entity_InitFromTemplateRecord` with one of 7 hardcoded per-type-constant (`0x2a/0x22/0x45/0xea/0xe8/0xec/0xe6`) position offsets; the `0xea/0xe8/0xec/0xe6` branches additionally hardcode the new companion's own script pointer to `6de3:c625`/`6de3:ccae` and state byte (`0x15`/`0x74`) — 3-4 near-identical directional variants of the same trailing-particle/companion effect | 1 | confirmed structure (re-verified by full decompile this pass, correcting an earlier partial read); guess on companion identity |
| 50 / 0x32 | `EntityScriptOp_AddSignedByteToScore` (`2d9e`) | `[0x8b75] += (signed char)operand` — a simple signed add into the running distance/score global `docs/engine.md`'s `Hud_UpdateScoreDisplay` reads. (Corrected: the previous pass's description of this address — "operand 0 → CALL c8c0; nonzero → 4-way branch" — was actually describing op49's neighboring code at `2da7`/`2daa`, not this address; raw disassembly confirms op50's real body is this 5-instruction add.) | 1 | confirmed (re-verified via raw disassembly) |
| 51 / 0x33 | `2d8e` | copies a page from video segment `[0x89fc]` into the level-map buffer via the plain-copy helper (`1000:1230`) `docs/engine.md` already documents | 0 | confirmed mechanism; guess on narrative (mid-level map refresh) |
| 52 / 0x34 | `EntityScriptOp_AttractModeTimeoutOrRestart` (`2cea`) | gated on `[0x8b8b]`!=0 (sub-level index). Increments a high-byte counter `[0x8c57]` by `0x80`/call (~512-call period); on wraparound, fades to black and calls `Game_StartAttractDemoAndRunLoop` — an **idle/attract-mode timeout**. Else, if input high-bit `[0x8b5d]`&0x80 (button press) is set: plays a sound, and (gated on `[0x8c0b]`) fades out, force-loads World1, clears all state, and runs a 5th inlined copy of the 14-call main loop directly — the **title/demo screen's "press any button to start" handler** | 0 | confirmed (major finding — the title/attract-mode screen logic) |
| 53 / 0x35 | `2471` | **tail-jumps** to `Debug_CtrlCAbortAndExit` (`1000:19e9`, was `Debug_RestoreStateAfterCheatMenu` — **RESOLVED**, see `docs/launcher.md`: this isn't a "restore state" routine, it's the game's one confirmed `INT 21h AH=4Ch` real process-termination call, exit code always `0`) — so this opcode is a genuine **scripted "exit the game" trigger**, reachable from ordinary entity-script content (e.g. a real ending/completion cutscene), not just the hidden debug console's Ctrl+C path | 0 | confirmed target and narrative — exit-code investigation resolved this |
| 54 / 0x36 | `EntityScriptOp_ResetScript` (`2665`) | clears `[+0xc]`/`[+1]`, aborts — re-seeds from the default-script table next call. Also op 12's no-saved-return fallback target | 0 | confirmed |
| 55 / 0x37 | `EntityScriptOp_DispatchSpeedTickByKind` (`2c6c`) | dispatches on kind (`+4`): 1 → `Entity_TickKind1SpeedDecay` (`dd1a` — moves Y by decaying speed `+0x26`, occasional kind-0x11 special reset after 10-16 ticks, then moves X by `+0x27` gated on hitbox/collision flags); 7 → `Entity_TickKind7SpeedByWorldOrSublevel` (`ddba`, **decoded this pass** — reads `[0x8b89]` (world) or, if 0, `[0x8b8b]` (sub-level) as a 1-4 selector; values 1/3/4 share the generic vertical-bounce-then-horizontal-move shape (same building blocks as kinds 1/2/4); value 2 has an extra special case: when this entity's own type (`+2`)==0x33, gated on global `[0x8c03]`, it fully reinitializes itself as a different entity — hitbox/speed/state cleared, `+1` set to `0xa8`/`0x67`, `+0xc` script pointer force-set to `0xd150`/`0xcbea` — plausibly a boss phase-transform/respawn trigger); 2 → `Entity_TickKind2VerticalBounce` (`dbc2` — vertical bounce via `Entity_MoveVerticalUpByFlags`/`DownByFlags` with sign-toggle at zero-crossing, then horizontal move); 4 → `Entity_TickKind4BounceWithRandomTurn` (`dc1e` — vertical bounce + horizontal move, with a random direction-reversal via `Entity_RollRandomBehaviorIndex` on reaching a symmetric endpoint); generic fallback (no kind match) adjusts speed `[+0x26]` via coordinate helpers. This is a **generic "bouncing/patrol physics tick" family keyed by kind**, distinct from both the `Entity_RunMovementAiScript` chase/flee VM and the per-kind AI-think dispatch in `docs/enemies.md` | 0 | confirmed dispatch shape and all 4 kind handlers (kind 7's type-0x33 transform is guess on exact narrative) |
| 57 / 0x39 | `EntityScriptOp_SetSpriteShapeOverride` (`2c45`) | sets entity `+0x16` = operand — a **previously undocumented struct field**, plausibly a runtime override of the shape descriptor's `frameSourceMode` (`docs/formats/pin-level-script.md`) | 1 | confirmed (new field), guess on exact rendering effect |
| 58 / 0x3A | `EntityScriptOp_WaitForBossDefeatThenKillSelf` (`2ae1`) | per-world boss-kind lookup (0x15/0x40/0x41/0x43 for worlds 1-4, with a kind==0x1a→0x4a override), kills self if not found or if found entity's `+0x40` == `0xf6` (the cross-class tracking sentinel `docs/enemies.md` documents) | 0 | confirmed |
| 59 / 0x3B | `EntityScriptOp_SetScrollWidthRegister` (`2a56`) | writes operand into `[0x8c34]` — the CRTC/scroll-width register `docs/memory-map.md`'s `AltBuild_AdvanceScrollBankState` section documents | 1 | confirmed (major cross-reference) |
| 60 / 0x3C | `2a41` | writes operand into `[0x8b98]` (a "last found/target type" scratch register also read by ops 63/70) | 1 | confirmed mechanism |
| 61 / 0x3D | `EntityScriptOp_SetAiFreezeFlag` (`2a48`) | writes operand into `[0x8ba1]` — the global AI-freeze flag | 1 | confirmed (major cross-reference) |
| 62 / 0x3E | `EntityScriptOp_CheckBonusMarkerAndMaybeSpawn` (`2ac5`) | finds kind-0x18 entity (bonus marker); if its frame == 0x7b, calls into the bonus-spawn subsystem right next to `Entity_ChooseAndSpawnBonusItem` (`docs/engine.md`) and aborts; else decrements the marker and bumps `[0x8bb4]` | 0 | confirmed |
| 63 / 0x3F | `2a75` | operand-gated: sets `[+0x1c]` (new field, seen also from ops 69/70) to one of a few fixed values, cross-referencing `[0x8b98]`==0x1a (the player-carried-item type `docs/enemies.md` documents for class-5) | 1 | confirmed structure; guess on full narrative |
| 64 / 0x40 | `EntityScriptOp_SetPaletteFadeState` (`2a4f`) | `[0x8ba2] = operand` — directly sets the palette-fade transition step counter that `Fx_UpdateTransition`/`Fx_TransitionStep` (`docs/engine.md`) increment once per frame and feed into the 24-bank fade table. Scripts can jump/reset the transition progress directly | 1 | confirmed (major cross-reference — **this opcode was entirely missing from the original table**, see the off-by-one correction note above) |
| 65 / 0x41 | `EntityScriptOp_AddSignedDeltaAtOffset` (`2a61`) | reads (offset, signed delta), adds delta into the word at entity+offset — generic "add" twin of the poke-byte primitives (ops 22/35) | 2 | confirmed |
| 66 / 0x42 | `EntityScriptOp_AdoptEntityStateAndScript` (`3010`) | finds a target entity's array slot (`Entity_FindArraySlotForEntity`, already named), copies that target's array-slot pointer, state byte (`+1`), and script pointer (`+0xc`) onto self, decrements a search-result-stack word at `[0x8b87]-2` — self **"becomes"** the found entity's current behavior state/script | 0 | confirmed (previously guessed; now fully decoded) |
| 67 / 0x43 | `EntityScriptOp_SetAnimLockFlag` (`271f`) | sets `+0x3d` = operand — the same "animation-lock" field `Entity_InitFromTemplateRecord`'s decompile names | 1 | confirmed |
| 68 / 0x44 | `EntityScriptOp_RunSpecialInteractionSequence` (`2755`) | a large (700+ byte) dense dispatcher. If entity type (`+2`)==3: branches on world/sub-level (`[0x8b89]`/`[0x8b8b]`) to hardcoded per-(world,sublevel) cutscene sub-scripts (world1 sublevel6, world2 sublevel7, world3 sublevel>7), each saving the script position (`+0x2a`) and jumping `+0xc` to a fixed data-segment script address (`0xcd03`/`0xcd1b`/`0xcd33`/`0xd2b0`/`0xd381`). Otherwise: finds+kills a `[0x8b98]`-tracked entity, then reacts to a chain of one-shot global flags (`[0x8c04]`,`[0x8bff]`,`[0x8bb4]`,`[0x8bee]`,`[0x8c06]`), each either jumping to another fixed sub-script address (`0xd280`/`0xd298`/`0xd306`/`0xd2cf`/`0xd2ee`/`0xd31f`) or playing a sound. **All 11 destination scripts walked byte-exact this pass — see "The reward-shower cutscene template" below**: every single one is an instance of the same shared spawn/sound/score celebration loop, not bespoke content. Structurally parallel to `docs/engine.md`'s `Entity_InteractionPhaseJumpTable`/`Entity_SetInteractionPhase*` family (still not proven identical) | 1+ | confirmed dispatch structure and all 11 destination scripts; guess on the exact narrative for the non-type-3 trigger flags themselves (what sets `[0x8c04]`/`[0x8bff]`/`[0x8bb4]`/`[0x8c06]`) |
| 69 / 0x45 | `268e` | gated on entity type==0x42 (same type op 11 special-cases); sets `+0x1c`/`+0x20` pairs based on current anim frame | 0 | confirmed mechanism |
| 70 / 0x46 | `3c4b` | sets `+0x1c` based on current anim frame vs 0x77, or hitbox size — another `+0x1c` producer | 0 | confirmed mechanism |
| 71 / 0x47 | `EntityScriptOp_SetGlobalEventTrigger` (`2726`) | writes operand into `[0x8c0c]` — the global-event trigger `docs/enemies.md` documents (8→defeat-table dispatch, 0xe/0x14→particle self-kill) | 1 | confirmed (major cross-reference) |
| 73 / 0x49 | `EntityScriptOp_KillTrackedEntity` (`272d`) | kills the entity pointed to by `[+0x2e]` (dual-use of the documented "anim-set-progress counter" field as an entity pointer here), clears the link, calls `Snd_TriggerEffect` (confirmed by name) | 0 | confirmed |
| 74 / 0x4A | `EntityScriptOp_ApplyGroundStateByKind` (`2685`) | calls `Entity_ApplyGroundStateTransitionByKind` (`1000:ee60` — **corrected: this is real code, not a data-segment address as the previous pass assumed; it's the already-named ground-collision per-kind dispatcher from `docs/enemies.md`**), then `FUN_1000_2663` (a no-op/passthrough). Directly ties this scripting VM into the ground-collision reaction system | 0 | confirmed (corrects a prior misreading) |
| 75 / 0x4B | `EntityScriptOp_AdvanceToNextWorld` (`31ef`) | calls `Game_AdvanceWorldAndRunLoop` (`1000:07eb`, newly named this pass — a **4th physical copy** of the 14-call main loop: increments `[0x8c29]`, loads World1-4 banks by value, clears entities, and either starts the attract demo or runs the inlined main loop directly). **Scripts can trigger a full world transition/restart** — plausibly the end-of-world victory sequence | 0 | confirmed (major finding) |
| 76 / 0x4C | `2a3b` | clears global `[0x8c0e]` | 0 | confirmed |
| 77 / 0x4D | `EntityScriptOp_SpawnRandomizedBonusNearFixedPoint` (`26b1`) | **CORRECTED this pass** — the prior guess ("renders via `1000:c035`") was wrong: `1000:c035` is `Entity_PushSpawnEvent` (already-named) and `1000:11fc` is `Rng_NextValue` (already-named), not a renderer/unknown call. This is a **randomized-position bonus/item spawn primitive**: advances the RNG, reads 1 operand byte as the spawned entity's type (`[0x8c1f]`), uses a fixed base position X=0x90,Y=0x48 with layout-selector `[0x8c29]`=0xf, branches on `[0x8b6b]` (the RNG-consumed behavior-roll global, `docs/enemies.md`) bit 0 to choose between two position-offset variants, and looks up `[0x8b6b]&0xf` in a 16-byte variant-selection table at `0xee36` to pick the spawned effect's variant (`[0x8c21]`), before calling `Entity_PushSpawnEvent` | 1 | confirmed (re-verified via raw disassembly; corrects a wrong guess) |

## Cross-cutting findings

- **A real CALL/RETURN subroutine mechanism** (opcodes 11/12, `EntityScriptOp_CallStateScript` /
  `EntityScriptOp_Return`), using entity field `+0x2a` (documented elsewhere as a "charge/wind-up
  counter") as a repurposed one-level return-address slot. This is a genuine, if shallow (one
  level deep, no stack), subroutine-call feature in the scripting language.
- **Scripts can freeze/unfreeze the entire non-player AI population** (`EntityScriptOp_SetAiFreezeFlag`,
  op 61) and can wait on that same flag (op 30, `EntityScriptOp_WaitUnlessAiActive`) — directly
  ties this VM to the global `[0x8ba1]` mechanism `docs/enemies.md`'s `Entity_UpdateBehavior`
  writeup documents.
- **Scripts can trigger the global-event dispatch** (`EntityScriptOp_SetGlobalEventTrigger`, op 71,
  writing `[0x8c0c]`) that fires `Entity_UpdateBehavior`'s "defeat all enemies" / "particle
  self-kill" special paths.
- **Scripts can trigger palette fades** (op 7) and **directly poke the hardware scroll-width
  register** (op 59) — this VM reaches all the way down into the video subsystem `docs/memory-map.md`
  documents, not just gameplay state. Plausible use: scripted level-transition effects.
- **A rich "spawn a positioned effect/item by type code" opcode** (op 13,
  `EntityScriptOp_SpawnEffectByTypeCode`) whose type codes overlap the nine special opcode types
  `docs/formats/pin-level-script.md` flagged in `Entity_SpawnFromQueuedEvent` — this is very
  likely the runtime-script-side counterpart of that same special-type family, though the exact
  correspondence per type code wasn't cross-verified type-by-type this pass.
- **Two new entity struct fields discovered**: `+0x16` (script-settable, plausibly a runtime
  shape/frame-source override — see `EntityScriptOp_SetSpriteShapeOverride`) and `+0x1c`/`+0x20`
  (written by three different opcodes, 63/69/70, always in the context of anim-frame/hitbox
  checks — likely a "next ground/hit reaction state" pair, not yet given a confident narrative
  name).
- **A generic "poke a byte/word at an arbitrary entity offset" primitive family** (ops 22/35/65) —
  the compiler's escape hatch for setting fields that don't have their own dedicated opcode.
- **Opcode 37 abandons the script VM's own call stack** to jump straight into
  `Game_WarpToLevelStageAndRunLoop` or the main bootstrap dispatcher — confirmed by exact address
  match, not guessed. This is a scripted level-warp/restart control-transfer, structurally unlike
  every other opcode (which return normally).
- **Opcode 75 does the same for a full world transition**: `EntityScriptOp_AdvanceToNextWorld`
  hands off to `Game_AdvanceWorldAndRunLoop` (`1000:07eb`), a **4th physical copy** of the 14-call
  main loop (alongside `entry`, `Game_WarpToLevelStageAndRunLoop`, and
  `Game_StartAttractDemoAndRunLoop` — see `docs/engine.md`'s "at least 3 copies" finding, now 4).
  It increments a world-index counter and loads World1-4 accordingly, or falls back to World1 on
  an out-of-range value. Scripts can drive a full world advance/restart directly.
- **Opcode 52 is the title/attract-mode screen's own logic**: `EntityScriptOp_AttractModeTimeoutOrRestart`
  times out an idle demo/title screen back into `Game_StartAttractDemoAndRunLoop`, or, on a button
  press, force-loads World1 and drops straight into a 5th inlined copy of the main loop — this is
  the "press any button to start" handler for whatever entity's script carries this opcode.
- **Opcode 64 directly drives the palette-fade transition** (`EntityScriptOp_SetPaletteFadeState`,
  writing `[0x8ba2]`, the same counter `Fx_TransitionStep` increments once per frame) — this
  opcode was the one genuinely missing entry from the original 78-opcode table (see the
  "off by one" correction above), not a guess that got upgraded.
- **Opcode 68 (`EntityScriptOp_RunSpecialInteractionSequence`) is the richest single find in this
  investigation**: a 700+ byte dispatcher that, for type-3 entities, jumps into hardcoded per-(world,
  sublevel) cutscene sub-scripts — the actual mechanism behind the world1/sublevel6 cutscene trigger
  `docs/formats/pin-level-script.md` flagged. **RESOLVED (follow-up pass): NOT the same mechanism as
  `Entity_HandleWorld3SpecialTrigger`** — that function (now itself fully decoded, see
  `docs/enemies.md`) is reached only via a direct static call from `Entity_UpdateBehavior` and never
  through this VM's indirect jump table, and the two read/write entirely disjoint globals (this
  opcode: `[0x8c04]`/`[0x8bff]`/`[0x8bb4]`/`[0x8bee]`/`[0x8c06]`; that function:
  `[0x8b98]`/`[0x8bea]`/`[0x8b96]`/`[0x8bd7]`/`[0x8bd9]`) — the earlier "strengthened lead" guess
  didn't survive an actual xref/decompile check. They remain independently-converged-on instances of
  the same "boss/special-event reward shower" concept, not one mechanism. **All 11 destination
  scripts are now walked byte-exact — see "The reward-shower cutscene template" below**: they all
  turn out to be the same shared spawn/sound/score celebration loop, both for the type-3
  world-gated branches and the non-type-3 one-shot-flag branches alike. The latter's fallback path
  (find+kill a tracked entity, then react to a chain of one-shot global flags) still closely
  parallels the already-documented `Entity_InteractionPhaseJumpTable`/`Entity_SetInteractionPhase*`
  family in `docs/engine.md` —
  plausibly the same subsystem, though not proven identical.
- **A generic "bouncing/patrol physics tick" dispatcher keyed by kind** (op 55,
  `EntityScriptOp_DispatchSpeedTickByKind`) — a third, distinct movement mechanism alongside the
  `Entity_RunMovementAiScript` chase/flee VM and the `docs/enemies.md` AI-think dispatch. All 4 kind
  handlers are now decoded (decaying-speed drift, vertical bounce with sign-toggle, vertical bounce
  with random-turn-on-symmetric-endpoint, and kind 7's world/sub-level-gated variant with a
  boss-transform special case — see the opcode table above).
- **Opcode 8's dequeue mechanism is fully resolved** (see the dedicated section below): a
  position/state event queue that teleports the scripting entity to each popped (X,Y) and drives a
  singleton kind==7 "controller" entity through a sequence of states — with a direct, confirmed
  cross-link to opcode 68 via the shared `[0x8bee]` one-shot flag.
- **CORRECTION: only two physical state→script tables exist, not four.** `docs/engine.md`
  previously described `0xcd9c` and `0xcdfe` (used by `Entity_SpawnFromQueuedEvent` for opcodes
  `0x1f`/`0x44`/`0x53`) as a "third and fourth" table alongside `Entity_SetStateAndScript`'s
  `0xcd88`/`0xd996`. Byte-exact `read_memory` comparison disproves this: `0xcd9c` is a literal
  alias 10 entries into `0xcd88` (`0xcd9c - 0xcd88 = 0x14 = 10*2`; 16 consecutive words verified
  identical), and `0xcdfe` is a literal alias 59 entries into `0xcd88` (`0xcdfe - 0xcd88 = 0x76 =
  59*2`; 16 consecutive words verified identical). There is exactly one positive-state table
  (`0xcd88`) and one negative-state table (`0xd996`) in the whole engine.
- **Opcode 77 corrected from a wrong guess to confirmed**: it is not a renderer — it's a
  randomized-position bonus/item spawn primitive built directly on the already-named
  `Entity_PushSpawnEvent`/`Rng_NextValue`. See the opcode table above.

## VM loop internals: yield vs. wait, precisely — confirmed

Raw disassembly of the loop body (`1000:2351`-`2382`) and the three tail stubs it can reach
resolves an ambiguity that matters for every byte-walk in this doc: whether a "wait" opcode's
on-disk footprint is fixed regardless of how many frames it actually waits.

```
2351: DI = [SI+0xc]                  ; reload script cursor
2357: DL = [DI]; INC DI              ; read opcode byte, advance DI past it
235a: if DL == 0xFF: RET             ; terminator
235f: if DL == 0xFC: JMP 2659        ; yield
2367: if DL == 0xAE: JMP 2470        ; stop (same as a no-op opcode)
236f: DL *= 2; DX = word CS:[0x2383+DL]
237b: CALL DX                        ; handler runs with DI already past the opcode byte
237d: [SI+0xc] = DI                  ; write back wherever the handler left DI
2380: JMP 2351
```

Three distinct tail stubs, each reached differently:

- **`2659`** (`[SI+0xc] = DI; RET`) — the **yield** target for opcode `0xFC`. DI at this point is
  already past the `0xFC` byte itself (from the `INC DI` at `2359`), and this stub *does* write it
  back before returning out of `Entity_RunScript` entirely. So a yield always advances exactly 1
  byte then suspends the whole entity for the rest of this frame — next frame resumes right after
  the `0xFC` byte, not on it. Five consecutive `0xFC` bytes (seen throughout the opcode-68 cutscene
  scripts below) is therefore a genuine 5-frame pause, not a stall.
- **`2663`** (`POP AX; RET`) — a **bail without write-back**, reached by `JMP`, not `CALL`, from
  inside a handler (e.g. `EntityScriptOp_WaitFrames`'s "not yet matched" path). Because `[SI+0xc]`
  is never touched, the script pointer is left exactly where it was at the top of this call —
  **parked on the same opcode**, to be re-read next frame. This confirms `EntityScriptOp_WaitFrames`
  (op 2) has a **fixed 1-operand-byte footprint on disk regardless of how many frames it waits**:
  every frame it re-reads the same operand byte and either re-parks (via `2663`) or, on match,
  falls through to a normal `RET` that *does* advance past the operand (confirmed via its own
  disassembly: `INC DI` sits on the matched path only, right before `RET`).
- **`2665`** (`[SI+0xc]=0; [SI+1]=0; ...RET`) — `EntityScriptOp_ResetScript` (op 54) and also op
  12's (`EntityScriptOp_Return`) no-saved-return fallback: a full reset back to "no script yet",
  re-seeded from the default-script table on the next call.

`EntityScriptOp_WaitOrLoopBack` (op 17) was disassembled the same way and also has a **fixed
2-operand-byte footprint regardless of outcome**: on mismatch it reads *both* operand bytes (the
second as a backward-jump distance) and rewinds `DI` by that amount before a normal `RET` (so the
rewind **does** get written back — the next frame resumes from the rewound address, potentially
re-executing earlier instructions, which is the actual "loop" mechanism); on match it just advances
past both bytes. Either way, exactly 2 operand bytes belong to this instruction in the static
byte stream — the byte-walks below rely on this.

## Opcode 8's dequeue subsystem, fully resolved

`EntityScriptOp_SetPositionOrDequeueTarget`'s negative-operand path (the "dequeue" branch) was
previously only understood at a high level. Full raw disassembly of `1000:3a5b`-`3aef` plus its two
subroutines (`3b55`, `3b7a`, now named `EntityScriptOp_HandoffToPlayerAndController` and
`EntityScriptOp_RecenterOnAnchorAndHandoff`) gives the complete mechanism:

- A queue at `[0x8c63]` holds 3-word **(X, Y, state)** records (not "(type, X, Y)" as originally
  guessed — the field order was confirmed by tracing which staged global each word ends up
  assigned to). A busy-cache flag `[0x8c5f]`/`[0x8c61]` tracks whether a record is already "in
  flight".
- **If `[0x8c5f]` is already nonzero** (busy): tail-jumps straight to
  `EntityScriptOp_HandoffToPlayerAndController` — finds the **kind==3 entity** (confirmed: this is
  the player, matching `docs/enemies.md`'s class-3/player identification — `Entity_FindEntityByKind`
  is called with a literal, hardcoded `AX=3`) and sets its state/script to a fixed pair
  (`0x47`/`0xc967`); sets the one-shot global `[0x8bee]=0xff`; then finds the **kind==7 entity** (a
  per-level singleton "controller/actor" entity — identity still a guess, but its role as a
  script-driven state machine is now concrete) and sets its state/script to `0xf9`/`0xd922`.
- **Otherwise, pops the next record.** If its X word is 0 (terminator, queue now empty):
  tail-jumps to `EntityScriptOp_RecenterOnAnchorAndHandoff` — finds the **kind==0x1c entity** (an
  anchor/recenter reference point, identity not established); if found, repositions self so
  `self.pos -= (anchor.pos - (0x90,0x50))` (recenters relative to the anchor with a fixed
  `(144,80)` offset), zeroes the busy-cache, then finds the kind==7 controller entity and sets its
  state/script to `0xf9`/`0xd922` (same target as the sibling routine above) and sets
  `[0x8bee]=1` (vs. `0xff`) — a distinct "queue fully drained" completion marker.
- **Otherwise (a real popped record)**: teleports self directly to the popped `(X, Y)` — the
  scripting entity itself is the thing that moves. If the state word is 0: finds and kills the
  **kind==0x2b entity** (the charging hazard, already confirmed in
  `docs/formats/pin-level-script.md`) — a "clear the hazard" special case. If nonzero: caches self's
  pre-teleport position into `[0x8c5f]`/`[0x8c61]` (arming the busy flag for next call), then puts
  the kind==7 controller entity directly into the popped state, resolving its script pointer via
  the *same* `0xd996` negative-state table `Entity_SetStateAndScript` uses elsewhere.

**Direct cross-link to opcode 68**: `[0x8bee]` — the flag this subsystem sets to `0xff` or `1` — is
literally one of the one-shot trigger flags `EntityScriptOp_RunSpecialInteractionSequence` (opcode
68) reads in its non-type-3 fallback chain. Opcode 8's dequeue-completion state feeds directly into
opcode 68's cutscene dispatch.

## The reward-shower cutscene template (opcode 68's 11 destination scripts) — confirmed

All 11 fixed destination addresses `EntityScriptOp_RunSpecialInteractionSequence` can jump `+0xc`
to (`0xcd03`, `0xcd1b`, `0xcd33` for the world1/sublevel6 type-3 branch; `0xd2b0` for world2/
sublevel7; `0xd381` for world3/sublevel>7; `0xd280`, `0xd298`, `0xd306`, `0xd2cf`, `0xd2ee`,
`0xd31f` for the six non-type-3 one-shot-flag branches) were read byte-exact via `read_memory` and
walked opcode-by-opcode against the now-complete table above. **Every single one is an instance of
the same shared template**, not bespoke per-branch content:

```
FC FC FC FC FC                              -- a fixed 5-frame pause (every sample, no exceptions)
[repeat, 1-2 times per destination:]
  0D <typecode=0x2D> <arg1> <arg2> <arg3> <arg4>   SpawnEffectByTypeCode(0x2D, ...)  -- a positioned spawn
  0F <n>                                            PlaySound(n)
  32 <n>                                            AddSignedByteToScore(+n)
  4D <n>                                            SpawnRandomizedBonusNearFixedPoint(type=n)
  FC [FC]                                            yield (1 or 2 frames)
  11 <target> <loopback>                            WaitOrLoopBack(target, loopback)
[optional epilogue, seen on several destinations:]
  2D <kind>          find entity by kind, swap script pointers (self <-> other)
  01 <frame>         SetAnimFrame(frame)              -- executes on the OTHER entity, post-swap
  2E                 swap back
  02 <n>             WaitFrames(n)
  0C                 Return
```

The `SpawnEffectByTypeCode` call's 3rd argument (the position/slot byte) runs across a **contiguous
range 27-37** over the 11 destinations, strongly suggesting one shared "reward slot index" rather
than 11 independently-authored effects. `docs/formats/pin-level-script.md`'s nine special opcode
types do **not** include `0x2D` — this particular type code is specific to the script VM's own
reward-shower use, not the static level-script spawn family.

**`0xcd03`/`0xcd1b`/`0xcd33` (world1/sublevel6's 3-step sequence) are not three independent
scripts** — they are overlapping tail entry points into **one continuous physical byte stream**:
`0xcd1b == 0xcd03 + 24` and `0xcd33 == 0xcd1b + 16`, confirmed by the fact that `0xcd1b`'s first 24
bytes are byte-for-byte identical to `0xcd03`'s bytes 24-47. This is the exact same
"overlapping-entry-point" pattern `docs/formats/pin-level-script.md` already documented for level
sub-level headers, now confirmed inside the scripting VM's own data too. The three steps are driven
by an external counter `[0x8c2f]` (0/1/2 → `cd03`/`cd1b`/`cd33`) that something else increments
between calls — not traced this pass.

**World3's version (`0xd381`) is richer**: it follows the identical opening template, then
continues into an extra epilogue not seen in the world1/world2 samples — three consecutive
`WaitFrames(250)` calls, a swap to a **kind==1** entity to set its collision flags negative, swap
back, a sound cue, then a `CallStateScript` subroutine call — consistent with world3/sublevel>7
being the final, most elaborate version of this reward sequence (plausibly the game's ending).

Given this, the earlier "boss-defeat cutscene" framing for opcode 68 undersold it: the shared
mechanism looks much more like a generic **"spawn a batch of bonus/reward items with sound and
score feedback"** celebration, reused for the world-gated sub-level-completion triggers *and* the
one-shot interaction-flag triggers alike, rather than bespoke narrative content per trigger.

## Opcode 13's type-code `0xa` branch, fully resolved — the break-fragment spawn family

The one previously-open call-target gap in the whole opcode table. Type-code `0xa`'s branch
inside `EntityScriptOp_SpawnEffectByTypeCode` is gated on `[0x8b89]`/`[0x8b8b]` (world/sub-level)
and, per world, reads a **second, secondary type code** from `[0x8c69]` and dispatches on its
value to one of four generic position-offset functions — now named
`Entity_SpawnBreakFragmentOffset0`..`3` (`1000:3943`/`3964`/`3985`/`39a6`):

- Each offset function nudges the entity's own position by a small, fixed 2D delta (decreasing
  X-magnitude across the four: `+8`,`+4`,`+2`,`+0`), with an orientation-gated (`+0x14==4`)
  Y-offset flip, then pushes a 5-field `Fx_PushQueuedPositionEvent5` whose type tag is the
  *original* secondary type code — i.e. the fragment reuses the parent block's own entity type,
  just spawned at a nearby offset position.
- **The secondary type-code ranges are byte-for-byte the same per-world breakable-block type IDs
  `docs/enemies.md`'s ground-collision section already catalogs**: world1 `0xa`-`0xd` (the
  four-part split block), world2 `0x30`-`0x33` (first-hit blocks), world3 `0x36`-`0x38` (world3's
  `0x35` is logically identical but compiled inline instead of calling out — see below), world4
  fully re-inlines the same 4 offsets rather than calling these functions at all (see next point).
  This **confirms** the type-0xa branch is the script-VM-side fragment/debris-spawn effect for
  those exact blocks breaking, not a separate/unrelated mechanism.
- World3's `0x35` value and world4's whole `0x3a`-`0x3d` set don't call these functions — the
  compiler inlined an identical copy of the same offset arithmetic directly in those branches
  instead (confirmed by comparing the inlined bytes to the named functions' bodies — byte-identical
  logic). World4 additionally has an extra pre-pass, **`Entity_SpawnMirroredBreakFragmentWorld4`**
  (`1000:3926`), called once when global `[0x8c03]` is nonzero: it saves the current X/Y, pushes an
  *extra* position event at the current (un-modified) position, then the caller restores the saved
  X/Y and bumps the effect-variant field `[0x8c21]` by one before falling through to the real
  dispatch — net effect: world4's breakable blocks spawn a second, mirrored/variant fragment
  alongside the primary one when `[0x8c03]` is set.

## Struct-field and global-register findings from a follow-up pass

A dedicated pass targeting the doc's own previously-listed open items (`+0x1c`/`+0x20`, `[0x8b98]`,
the kind==7/0x1c entity identities, the VM hand-off question, and the interaction-phase family
relationship) resolved all of them to a real answer — some confirming, some **correcting** earlier
guesses:

- **`entity+4` (`kind`) is confirmed to be a direct spawn-time copy of the shape descriptor's own
  `+0x18` field** (`docs/formats/pak.md`'s "kind" field), via `Entity_InitFromTemplateRecord`
  (`1000:c8c0`, fully decompiled this pass): `entity+4 = descriptor+0x18`. This unifies two
  previously-separate "kind" concepts into one: the descriptor-table field used for
  `frameSourceMode==0` indirect tile addressing (`docs/formats/pin-level-script.md`) **is** the
  same value that becomes the runtime entity's AI/collision-dispatch "kind" tag throughout this
  doc and `docs/enemies.md`.
- **`entity+0x18`..`+0x22` is a 6-word hitbox-extent block, also set by `Entity_InitFromTemplateRecord`**,
  copied from a per-shape-class template table addressed *indirectly* through the shape
  descriptor's own `+0x1a` field (used as a pointer, offset by a fixed `-0xc51`/`-0xc4f`/.../`-0xc47`
  step of 6 consecutive words) — this **resolves `docs/formats/pak.md`'s own long-open
  "`+0x1a` (hitbox index) remain untraced/unused by rendering" item**: it's used, just at
  spawn-time hitbox initialization, not by `Gfx_DrawObject`.
- **CORRECTION: entity `+0x1c`/`+0x20` are two of these six hitbox-extent words** (index 2 and 4 of
  the block), not a "next ground/hit reaction state" pair as this doc previously guessed. This
  makes much better sense of the three script opcodes that write them: op 63 (`0x3F`), op 69
  (`0x45`, gated on type `0x42`, "sets `+0x1c`/`+0x20` pairs based on current anim frame"), and op
  70 (`0x46`, "sets `+0x1c` based on current anim frame vs `0x77`, or hitbox size") are all
  **runtime, animation-frame-keyed hitbox-size adjustments** — e.g. a boss extending its hitbox
  during a lunge/attack frame, then shrinking it back — not a hidden state-machine field.
- **`entity+0x16` is confirmed to be a spawn-time copy of shape descriptor `+8`** (the "shape-type
  dispatch value" `docs/formats/pak.md` names, which selects `Gfx_DrawObject`'s masked-bitmap blit
  variant), **not** a copy of descriptor `+0x16` (`frameSourceMode`) as this doc previously guessed
  by analogy from the matching hex digit — those are two different structs' offsets that happen to
  share a hex value. `EntityScriptOp_SetSpriteShapeOverride` (op 57) letting scripts poke this field
  at runtime is therefore a **live render-dispatch/shape-variant override** (e.g. swapping which
  blit routine or tile-size class an entity uses mid-game — plausibly the kind-7 boss
  phase-transform already found in opcode 55's kind-7 handler), refining rather than confirming the
  earlier "frameSourceMode override" framing.
- **`kind==7` is not a single "controller" character — it's a shared category tag used by dozens of
  breakable/hazard-block shape descriptors across all four worlds.** Grepping
  `symbols/entity-shapes.json`'s descriptors for `kind===7` returns 24 of the 96 entries, spanning
  banks 2/3/6, including **descriptor ids `10`-`13` — the exact same `0xa`-`0xd` world1 four-part
  breakable-block type IDs** `docs/enemies.md`'s ground-collision section already documents. Given
  `entity+4==descriptor+0x18` is confirmed exact, this means the opcode-8 dequeue subsystem's "find
  the kind==7 entity" call (`Entity_FindEntityByKind(7)`) finds *whichever* breakable/hazard-block
  entity happens to be alive and matches — not a dedicated hidden "controller" actor as previously
  framed. The "controller" framing in the section below is kept as the best available label for the
  *mechanism* (a state-driven entity the dequeue subsystem steers), but its *identity* is now
  understood to be an ordinary hazard-block entity, reused for this purpose.
- **`kind==0x1c` (28) appears in zero of the 96 shape descriptors** — confirmed by the same grep.
  The "anchor" entity `EntityScriptOp_RecenterOnAnchorAndHandoff` (opcode 8's dequeue subsystem)
  searches for is therefore **never spawned through the standard template path** with that kind
  pre-assigned; its kind field must be poked directly at runtime (e.g. via the generic
  poke-byte-at-offset opcodes, or a bespoke spawn-opcode branch not yet identified) rather than
  coming from a shape descriptor default. An honest negative result, not yet resolved further.
- **`[0x8b98]`'s full role, confirmed via `Entity_HandleSpecialInteraction` (`1000:3e15`,
  `docs/engine.md`'s "Bonus/checkpoint/score-popup subsystem"), decompiled in full this pass**: it's
  a general-purpose "which special-interaction branch is active" scratch register, written with at
  least four distinct tag values (`1`, `0x1a`, `0x43`, `'A'`/`'C'` compared, plus `0xf6` written to
  a *different* field, the tracking sentinel) across that function's own dense branch set, in
  addition to the already-documented reads from script opcodes `0x3C`/`0x3F` and
  `Entity_ApplyComplexGroundResponse`. It is a genuinely shared mailbox between the native
  interaction-effect dispatcher and this scripting VM, not specific to either.
- **VM hand-off, resolved cleanly via `get_function_callers`**: `Entity_RunScript` has exactly one
  caller, `Entity_UpdateAll` (confirmed single call site — this *is* the general per-entity
  behavior-script layer, run every frame per `docs/enemies.md`'s correction). `Entity_RunMovementAiScript`
  has **no caller from `Entity_UpdateAll` at all** — its only callers are `Entity_SelectAiScriptTableBlocked`/
  `Clear`/`Default` (from `Entity_ThinkPatrolAI`) and several `Entity_AiOp*`/`Entity_HitReactDispatchByKind*`
  functions, all reached deep inside `Entity_UpdateBehavior`'s per-kind AI-enemy dispatch
  (`docs/enemies.md`). **These are not alternate VMs gated by a per-entity/per-kind choice — they
  are two always-coexisting layers**: `Entity_RunScript` runs unconditionally for any entity with an
  active script, while `Entity_RunMovementAiScript` is a movement-decision *helper function*, called
  as an ordinary subroutine from deep within the separate AI-enemy think path, on the same entity in
  the same frame. The earlier "exact hand-off between which VM runs when" framing assumed a
  gated choice that doesn't exist in the code.
- **`EntityScriptOp_RunSpecialInteractionSequence`'s relationship to `Entity_InteractionPhaseJumpTable`/
  `Entity_SetInteractionPhase*` (`docs/engine.md`), checked properly this time — CONFIRMED linked**
  (unlike the `Entity_HandleWorld3SpecialTrigger` case in `docs/enemies.md`, which checked out as
  *not* linked to this same opcode — both conclusions came from actually tracing xrefs/globals, not
  assumption). `Entity_HandleSpecialInteraction` (the interaction-phase family's native-code hub,
  called from `Entity_HandleCollisionOrStateDispatch`) **directly writes `[0x8c04] = 0x40` (`'@'`)**
  in its own decompiled body — the exact value/address opcode 68 polls as one of its one-shot
  trigger flags — plus `0x45`(`'E'`), `0x27`(`'\''`), and `0x1d`, and clears it to 0 on several
  paths. `Entity_SetInteractionPhase1B` additionally clears `[0x8c04]` and writes
  `[0x8bf7]`/`[0x8bf9]`/`[0x8c69]` — the **same three globals** `EntityScriptOp_SpawnEffectByTypeCode`'s
  type-`0xe`/`0x1b` branch reads. **Conclusion: the native interaction-phase dispatcher and this
  scripting VM's opcode 68/13 are two ends of one shared producer/consumer pipeline**, communicating
  through a small mailbox of globals (`[0x8c04]`, `[0x8b98]`, `[0x8bf7]`, `[0x8bf9]`, `[0x8c69]`),
  not two independent systems that merely look alike.
- **`[0x8bff]` and `[0x8bb4]`'s setters — RESOLVED.** Both are incrementing step-counters, not
  constant-value mailboxes, which is exactly why the previous pass's byte-pattern search (constant
  `MOV`/register-store forms only) missed them — the real writes are `ADD` instructions.
  **`[0x8bb4]`**: `EntityScriptOp_CheckBonusMarkerAndMaybeSpawn` (opcode 62/0x3E, `1000:2ac5`) does
  `ADD byte ptr [0x8bb4],1` (`1000:2adb`) once per call, whenever the kind-`0x18` bonus-marker
  entity it tracks hasn't yet reached its trigger frame (`0x7b`). **`[0x8bff]`**: a newly-bounded
  function, `Entity_InteractionPhaseType1bHandler` (`1000:5bad`, see below), does
  `ADD word ptr [0x8bff],1` (`1000:5c40`) once per call until it reaches `6`. Both counters are
  consumed by `EntityScriptOp_RunSpecialInteractionSequence` itself: `[0x8bff]` via the plain
  `if (*(int*)0x8bff != 0)` branch (any of 1-6 reads nonzero), `[0x8bb4]` via a signed high-bit
  check (`< 0`, i.e. `>= 0x80`) that only its own final `MOV byte ptr [0x8bb4],0xFF` (`1000:2a20`)
  satisfies — the intermediate 1-0x7f range the decompile shows a branch for appears to never
  actually get read as a *trigger* condition (only written by the incrementer above), so that
  branch may be effectively dead in practice, not disproven but not reachable via any write site
  found. `EntityScriptOp_SpawnLinkedEntityFromTemplateTable` (op 49) separately reads `[0x8bff]` as
  a byte-table index into `0xeeea` and clears it to 0 (`1000:2dbd`-`2dc1`, already documented) — a
  second, unrelated consumer of the same counter. **`[0x8c06]`'s setter was already resolved by the
  previous pass** (`EntityScriptOp_RunSpecialInteractionSequence` lazily self-initializes it to
  `100` at `1000:2992` the first time its own wait-countdown branch runs and finds no target
  entity) — restated here for completeness since it turned out to follow the identical
  self-contained countdown idiom as its siblings.
  Method used to find these: `search_byte_patterns` for the literal opcode+address bytes of every
  direct-addressing store form (`MOV` imm8/imm16/reg8/reg16 in all 8 register encodings, `INC`,
  string-store setup) came up empty except for genuine zero-inits/clears — the actual writes turned
  out to be `ADD reg/mem, imm8` (opcode `80 /0` and `83 /0`), a form not tried in the first attempt.
- **`[0x8c2f]`'s driver — RESOLVED.** The `MOV AX,[0x8c2d]; MOV [0x8c2f],AX` copy at
  `1000:58ad`-`58b0` sits inside a now-bounded function, `Entity_PairWithType1cPropAndArmCutscene`
  (`1000:5851`-`58d4`). The previous pass's raw-disassembly read of this region was itself
  misaligned by one byte (a truncated `JMP rel16` at the true function's tail was split into a
  bogus `JNZ`+`HLT`, and later bytes were misread as `INC SP`/`OR AL,imm8`/`LEAVE` where the real
  instructions are `MOV word ptr [SI+0xc],0xc967` — a script-pointer reassignment); re-disassembling
  from verified byte boundaries (`read_memory`, decoded by hand) fixed this. The real function:
  requires the calling entity to be idle and at the same Y as a paired entity `BX` of
  type/shape-class `0x1c` (`entity-shapes.json` descriptor 28 — bank 6/`extras`, a small 2-frame
  decorative prop), scans 5 candidate X-offsets (±0/4/8, with the −4/−8 pair gated on
  `[0x8b98]==0x15`, the world-1 boss-kind sentinel), and on a match reassigns the caller's script,
  sets `[0x8c2f]=[0x8c2d]`, plays two sounds, and kills `BX`. Reads as: touching a specific world-1
  decorative prop near the boss arms the sublevel6 cutscene counter and consumes the prop.
  `[0x8c2d]`'s own origin is still untraced. **Bonus find**: this function turned out to be one of
  three newly-bounded entries (alongside `Entity_DispatchInteractionByOtherEntityType`, `1000:57d6`,
  and `Entity_InteractionPhaseStateSetters`, `1000:57a2`/`57a3`) in **`Entity_InteractionPhaseJumpTable`**
  — `docs/engine.md`'s "unrecoverable computed jump table". Its table (base `1000:4604`, `CX*2`-indexed)
  was read directly via `read_memory`: 20 confirmed word entries (`4604,4639,5e18,5e1d,4f27,4c01,`
  `4610,57d6,4614,4616,57a2,57a3,462c,461e,57a2,5761,4624,4626,4628,462a`), with real code resuming
  immediately after entry 19 — confirming the table is exactly these 20 words (entry 0 points back
  at the table dispatcher itself, likely a deliberate trap for an unused phase index). Entry 15
  (`0x5761`) reuses the already-named `Entity_SyncViewportOrGetKind` as a phase handler.

## The interaction-phase table, fully accounted for — confirmed

A follow-up pass traced every remaining entry. The caller chain was found first and reframes the
whole table: `Entity_InteractionPhaseJumpTable` (`1000:45f8`, `(*(code*)*(u16*)(CX*2+0x4604))()`)
is called from exactly one site, `Entity_CheckAabbOverlapOrBroadcast` (`1000:dfac`) — the AABB
hitbox-overlap test between two entities (confirmed: it reads the `+0x1c`/`+0x1e`/`+0x20`/`+0x22`
hitbox-extent fields this doc's struct-field findings already resolved), falling through to this
20-phase table **only on full 4-axis overlap**. That function is itself the per-target callback
`Entity_BroadcastEventToVisibleByKindFlag` (`1000:df5a`, `Entity_UpdateBehavior`'s only caller)
invokes while walking the visible-entity list. So: **`CX` (the phase index) is the broadcast/event
code the top-level `Entity_UpdateBehavior` call site supplies**, and this whole table is the
generic "two entities' hitboxes now overlap — what happens?" resolver, keyed by *why* the overlap
check was run, not by either entity's own type alone.

Reading all 20 raw bytes directly (`read_memory`, not decompiler pseudocode) settles every slot:

- **9 of 20 are self-referential trap/unused slots** — index N's own value equals its own slot
  address (indices `0,6,8,9,13,16,17,18,19` → `4604,4610,4614,4616,461e,4624,4626,4628,462a`).
  Jumping to any of these would execute the table's own raw data bytes as garbage instructions;
  none of the 9 disassemble as sensible code. These are dead/reserved phase-index slots, not
  content to trace — the original "14 entries not traced" estimate over-counted these as
  real work.
- **5 indices were already named from the prior pass** (4 distinct addresses, since two indices
  share one): `7`→`Entity_DispatchInteractionByOtherEntityType` (`57d6`), `10`&`14`→
  `Entity_InteractionPhaseStateSetters` (`57a2`/`57a3`), `15`→the already-named
  `Entity_SyncViewportOrGetKind` (`5761`).
- **The remaining 6 indices (`1,2,3,4,5,12`) resolve to 5 distinct functions, all newly named this
  pass**:
  - **Indices `12` and `1`** (`462c`/`4639`) are **the same function entered at two different
    offsets** — `4639` is 13 bytes into `462c`'s body, skipping its opening "if BX's type != 0x25,
    kill it" guard. Named **`Entity_InteractionPhaseResolveHitAndPairing`**: dispatches on the
    paired entity BX's type (`0x2c`, `0x2b`→`Entity_ArmChargingHazardInteraction`), on global
    `[0x8c04]=='@'` (a boss-hit sub-branch assigning hardcoded state/script pairs, one path calling
    the newly-named `Entity_SpawnLinkedTemplateEntity`), then a big `[0x8b98]`-keyed dispatch
    (`0x15`=world-1 boss sentinel, `'C'`=ground-transition-or-reward-burst, `-1`=no-op, `'!'`/`'A'`→
    `Entity_ChooseAndSpawnBonusItem`, `1`/`3`→generic hit via `Entity_ResolveInteractionRewardAndBonusMarker`,
    `0x1a`→scans the entity list for a transform-state match). Its default fallback (both self and
    BX idle) is a **generic two-entity "start an interaction" pairing sequence** — assigns BX
    state `0x44`/script `0xc92c` and self state `0x45`/script `0xc94d`, sets `[0x8b96]=0x3c`
    (wait-countdown) and `[0x8b98]=3` — **the exact same constants already documented on
    `Entity_PairWithType1cPropAndArmCutscene`**, confirming this is the *general* mechanism that
    specific function is a specialized front-end for.
  - **Index `2`** (`5e18`) — trivial: `Entity_KillSelfInteractionPhase`, `self.state=0x19`.
  - **Index `3`** (`5e1d`) — trivial: `Entity_KillOtherInteractionPhase`, `BX.state=0x19` (the
    "kill the other party" counterpart).
  - **Index `4`** (`4f27`) — **`Entity_InteractionPhaseResolveBreakOrHazard`**: a dense (~650-byte)
    per-world hit/break dispatcher over BX's type against per-world breakable/hazard states
    (mirroring `docs/enemies.md`'s ground-collision type catalog), plus a `Entity_ThinkChargingHazard`
    (type `0x2b`) special case that resets it to state `0x29`/script `0xc6ea`, awards score, and
    triggers the newly-named `Entity_SpawnBreakBurstEffect`. Structure and key constants confirmed;
    not every per-world branch narratively pinned down (same density/confidence tier as
    `Entity_UpdateBehavior`'s own class dispatch).
  - **Index `5`** (`4c01`) — **`Entity_InteractionPhaseResolveByWorldAndType`**: per-world dispatch
    over the **same breakable-block type ranges** `docs/enemies.md` already catalogs (world1
    `0xd`/`0x10`, world2 `0x33`/`0x34`, world3 `0x38`/`0x39`, world4 `0x3a`-`0x3e`) into a shared
    "break and reward" epilogue. World2 type `0x33` is distinct: gated on `[0x8b98]` (`0`/`1`/`0x1a`
    — the player-carried-item type `docs/enemies.md` documents for entity class 5), it does a
    distance check against a found entity and either sets a new one-shot flag `[0x8beb]=0xff`
    (setter of `[0x8beb]` itself, i.e. what reads it downstream, not traced further) or repositions/
    reinitializes it. World4 types `0x3a`-`0x3d` run a ground-contact-response chain reusing
    `Entity_MoveHorizontalByFlags`/`Entity_ApplyGroundStateTransitionByKind`.
- **Two shared helper primitives found and named along the way**:
  `Entity_ResolveInteractionRewardAndBonusMarker` (`549c`, called from both indices above) is the
  canonical "a hazard/breakable block was just destroyed" resolver — HUD counters, self+linked-child
  reset to the already-documented "state 1 = kill" script, two sound cues, a position-event push
  keyed by which special-tag field is set, then `Entity_SpawnBreakBurstEffect` (`572a`, a 4-particle
  burst spawn via 4x `Fx_PushQueuedPositionEvent5`) and a call into the already-named
  `Entity_ChooseAndPlaceBonusMarker`.

Net picture: this table isn't 14 independent, unrelated behaviors — it's a small dead-slot-padded
dispatch over **one AABB-collision-reaction system**, and every live slot funnels into machinery
this project has already named elsewhere (the pairing-cutscene mechanism, the breakable-block
reward path, the bonus-item chooser).

## Worked examples: real scripts decoded byte-exact

Read directly from the default-script tables (`6de3:cd88` positive-state, `6de3:d996`
negative-state), which begin:

```
cd88 table (positive state index -> script pointer):
  state 0 -> c45a
  state 1 -> c45b
  state 2 -> c45c
  state 3 -> c46f
  state 4 -> c470
  state 5 -> c489
  state 6 -> c4cb
  ...
d996 table (negative state, AND 0x7f):
  index 0 -> ce88
  ...
```

**State 0** (`c45a`): byte `0xFF` — empty script, immediate stop. The "no active behavior script"
default.

**State 1** (`c45b`): byte `0x06` — a single `EntityScriptOp_Kill`. "Die immediately" as a state.

**State 2** (`c45c`), fully decoded:
```
02 46          WaitFrames(0x46 = 70)              -- stall 70 frames via counter [+0x3e]
09             PlayDirectionalAnimTable            -- inline table follows:
  00 F8  00 F8  00 FA  00 FC  00 FD  00 FE  00 FF   -- deltas: -8,-8,-6,-4,-3,-2,-1 (7 frames)
  AE 36                                             -- terminator; resumes script at offset+1
36             ResetScript                          -- clear script, stop
```
A 70-frame delay, then a 7-frame **decelerating recoil** (knockback slowing to a stop), then
reset. This is a complete, sensible real behavior — most plausibly a hit-reaction/knockback state.

**Negative-state index 0** (`ce88`), fully decoded:
```
09             PlayDirectionalAnimTable            -- inline table follows:
  00 0E  00 0C  00 0A  00 08  00 06  00 04  00 02  00 00   -- deltas: +14,+12,+10,+8,+6,+4,+2,+0 (8 frames)
  AE 0C                                             -- terminator
0C             Return                              -- resume saved position, or terminate
```
An 8-frame **decelerating approach** (the mirror image of state 2's recoil, opposite sign, one
extra step down to 0), ending in a `Return` rather than a hard reset — consistent with this being
a *called* subroutine script (via op 11) rather than a top-level state script.

These two examples independently confirm `EntityScriptOp_PlayDirectionalAnimTable`'s pair format,
terminator behavior, and post-terminator script-pointer arithmetic against real content, not just
code structure.

**State 3** (`c46f`): byte `0xFF` — empty script, immediate stop (same as state 0). Notably, the
table entry for state 4 (`c470`) is exactly **one byte past** state 3's — the two scripts are
laid out back-to-back in the same byte stream, confirming the table's pointers are genuine
independent offsets into a shared, densely-packed script blob, not per-state fixed-size records.

**State 6** (`c4cb`), fully decoded — a clean victory/boss-defeat sequence:
```
0F 05          PlaySound(5)
47 08          SetGlobalEventTrigger(8)     -- fires Entity_UpdateBehavior's "defeat all enemies"
                                             --   dispatch (docs/enemies.md)
01 D5          SetAnimFrame(0xD5)
07 07          TriggerPaletteFade(7)        -- world-gated fully-lit target palette
FC             yield (abort this frame, resume next frame)
```
Sound cue, then the global "clear all enemies" trigger, a frame change, a palette fade to the
level's bright target palette, then yield — a textbook **boss-defeated victory transition**,
independently confirming both `EntityScriptOp_SetGlobalEventTrigger`'s cross-reference to
`docs/enemies.md`'s `[0x8c0c]` finding and `EntityScriptOp_TriggerPaletteFade`'s operand semantics
against real content.

**State 7** (`c404`) — an anomaly, reported honestly rather than forced into a narrative: its first
byte is `0xE6` (signed `-26`), which matches none of the three VM terminators (`-1`/`-4`/`-0x52`)
and so would dispatch as a real opcode — doubling to `0xCC` and indexing `0x2383+0xCC = 0x244F`,
well past the real 78-entry table's end (`0x2383`-`0x23FD`), landing on unrelated code/data. If
this pointer were ever actually executed it would call garbage. The surrounding bytes
(`0xBEE6, 0xBF02, 0xBF1E, ...`, each exactly `0x1C`=28 apart — the same size as the 28-byte
shape-descriptor records in `symbols/entity-shapes.json`) look like an unrelated near-pointer array
that happens to sit at this address, not script bytecode at all. Most likely explanation: state 7
is simply never assigned to any entity at runtime (every spawn/state-transition site seen so far
uses small, specific state constants — 0, 1, 2, 3, 6, 0x15, 0x47, 0x67, 0xa8, 0xf9, etc. — and 7
isn't among them), making this table slot inert leftover data rather than a reachable bug.

**State 8** (`c508`) — partially walked: opens with a valid `EntityScriptOp_PlayDirectionalAnimTable`
(`09`) whose inline table reads `02 EC, 02 F0, 02 F4, 02 F6, 02 F8, 02 FA, 02 FC, 02 FD, 02 FE,
02 FF, 02 00, ...` — a **constant `+2` per-frame horizontal delta** paired with a **steadily
incrementing tile index** (`0xEC` up through `0xFF` wrapping to `0x00`) — a walk-cycle animation
synced to constant forward motion, not a decelerating recoil like states 2/negative-0. The `0xAE`
terminator falls outside the 24-byte window read this pass, so the exact frame count isn't
confirmed, but the pattern (steady motion + cycling walk frames) is unambiguous.

**`0xcd9c` and `0xcdfe` are aliases into `cd88`, not independent tables** (see "Cross-cutting
findings" above) — confirmed directly from this same table dump: `cd9c`'s first 16 words are
byte-for-byte identical to `cd88`'s words 10-25, and `cdfe`'s first 16 words are byte-for-byte
identical to `cd88`'s words 59-74.

**States 4 and 5**: identified but not fully walked byte-exact. State 4 (`c470`) opens with
`SetAiFreezeFlag(0x66)` then immediately hits `EntityScriptOp_RunSpecialInteractionSequence`
(opcode `0x44`), whose operand-byte consumption is **state/branch-dependent, not a fixed count**
(its decompile shows operand reads nested deep inside specific world/sub-level branches) — a
static byte-walk past this point would be guessing, not decoding, so it was deliberately left
incomplete rather than asserting a wrong byte boundary. State 5 (`c489`) opens with
`WaitForBossDefeatThenKillSelf` then a `PlayDirectionalAnimTable` with at least 11 pairs
(deltas -16,-12,-10,-8,-6,-4,-3,-2,-1,0,0, a longer decelerating-approach shape than state 2's
7-pair recoil) — the terminator byte fell outside the memory window read this pass, so the exact
frame count isn't confirmed.

## Full script-table coverage: both tables walked structurally, all 219 entries

A mechanical byte-exact walker (opcode table above, with the three real terminators and the
known variable-length opcodes 9/13/37/68 handled specially) was run over **every** entry in both
tables, not just the ~8 samples from the prior pass:

- **Positive table (`0xcd88`), 119 states walked**: 103 structurally-distinct opcode sequences, 101
  byte-exact-distinct (18 are literal byte-for-byte duplicates — mostly the same
  "overlapping-tail" pattern already documented for `cd03`/`cd1b`/`cd33`, e.g. states 104/105 share
  one physical byte range). 36 of the 119 terminate at opcode 9/13/37/68's variable-length body,
  i.e. hit the boundary of what a static walker can resolve without also re-deriving that opcode's
  own runtime branching — consistent with, not contradicting, this doc's existing full
  characterization of those four opcodes.
- **Negative table (`0xd996`), 100 entries walked**: 90 byte-distinct, 10 exact duplicates, 50 stop
  at a variable opcode. **Independent cross-validation of the reward-shower template**: this
  mechanical walk, run without reference to the opcode-68 destination addresses, independently
  landed on **`0xd280`, `0xd298`, `0xd2b0`, `0xd2cf`, `0xd2ee`, `0xd306`, `0xd31f`, `0xd381`** as
  byte-identical "five yields, then a variable spawn opcode" scripts — the exact same addresses
  already catalogued as opcode 68's 11 destination scripts above, reached completely independently
  through the negative-state table rather than through opcode 68's own jump targets. This is strong
  confirmation both that the reward-shower template finding is real and that the negative-state
  table and opcode 68's hardcoded destinations are the same underlying data, addressed two
  different ways.
- **A reusable subroutine found via the CALL/RETURN mechanism**: negative-table index 1 (`0xce9b`)
  is `TriggerPaletteFade` called 8 times in a row (an 8-step palette-fade flicker), and is the
  `CALL(state=1)` target of at least 7 other negative-state entries (indices 21, 45-50, 65) —
  confirming op 11/12's "genuine, shallow subroutine-call feature" finding with a real, identified,
  reused callee rather than only the mechanism.
- **The state-7 anomaly (already documented above) is one instance of a broader, now-confirmed
  pattern, not a one-off.** Several more positive-table states (5-10, 17, 20, 34-39, 81, 87-88)
  terminate their walk on a byte value (`0xF9`/`0xFA`/`0xFE`, i.e. signed `-7`/`-6`/`-2`) that
  matches none of the three real VM terminators and isn't a valid 0-77 opcode either — per the VM
  loop's own documented arithmetic (`opcode*2` indexes `table_2383`), a negative non-terminator
  opcode byte would double to a *negative* table offset and genuinely dispatch to whatever code sits
  immediately *before* `1000:2383` (the mirror-image case of state 7's byte overrunning the table's
  *end*). All of these occur at the tail of **overlapping-entry-point states** (the same
  "densely-packed, no fixed-size records" pattern already established) — consistent with these tail
  bytes simply never being reached at runtime because some other mechanism (a shorter, real
  terminator earlier in whichever *specific* entry point is actually used) ends execution first, the
  same explanation already accepted for state 7 itself.

## What's still genuinely open

Resolved this pass (previously listed here as open): opcode 55's kind-7 handler, all 11 of opcode
68's destination scripts, opcode 8's two queue-continuation subroutines, opcode 77's wrong
"renderer" guess, the VM loop's exact yield/wait/reset semantics, and the "four state→script
tables" miscount (really two). What remains:

Resolved this pass (previously listed here as open): opcode 13's type-`0xa` branch (all four call
targets, now named `Entity_SpawnBreakFragmentOffset0`-`3` plus the world4 mirrored variant), both
default-script tables walked structurally in full (119/119 positive, 100/100 negative — see
"Full script-table coverage" above), the `+0x1c`/`+0x20` field identity (corrected to hitbox
extents), `[0x8b98]`'s full role, the kind==7/kind==0x1c entity-identity questions, the VM
hand-off question, and `EntityScriptOp_RunSpecialInteractionSequence`'s relationship to
`Entity_InteractionPhaseJumpTable`/`Entity_SetInteractionPhase*` (confirmed linked). What remains:

Resolved this pass (previously listed here as open): `[0x8bff]`/`[0x8bb4]`'s setters (both
incrementing counters, found once the byte-pattern search was widened from constant-store forms to
`ADD reg/mem,imm8`), and `[0x8c2f]`'s driver's containing function (now bounded, named, and shown
to be one of three recovered entries in `Entity_InteractionPhaseJumpTable` — see "What was found
this pass" above for both). What remains:

- **RESOLVED: all 20 of `Entity_InteractionPhaseJumpTable`'s entries are now accounted for** (see
  "The interaction-phase table, fully accounted for" below) — the "14 entries not traced" framing
  overstated the remaining work: 9 of the 20 are self-referential trap/unused slots (never real
  code), and the other 5 collapse to 4 distinct newly-named functions (one of which is entered at
  two different offsets by two different table slots).
- **`Entity_DispatchInteractionByOtherEntityType`'s other internal jump targets**
  (`1000:58d5`/`59a9`/`5b26`/`5b70`/`5b8b`, reached when the paired entity's type is `0xe`/`6`/`0x26`/
  `0x56`/`0x2e`) and **`Entity_InteractionPhaseType1bHandler`'s** own further sub-dispatch
  (`5d73`/`5d84`/`5d9c`/`5c96`/`5d5e`) weren't traced — both are newly-bounded functions this pass
  created purely to answer the `[0x8c2f]`/`[0x8bff]` leads, not fully characterized themselves.
- **`Entity_InteractionPhaseStateSetters`'s (`1000:57a3`) own three state-setting branches**
  (hitbox-flag toggle, dead-mark, the `0xf6` "tracks another entity" link) are structurally read but
  not tied to a specific narrative purpose.
- **`[0x8bb4]`'s decompiled 1-0x7f intermediate-range branch appears to be dead code in practice** —
  no write site puts a value in that range (only the `+1` increment from 0, and the terminal `0xFF`
  set), so either it's reachable only via an addressing mode outside this pass's search (indirect/
  pointer-relative writes are undetectable by static byte-pattern search), or the branch is genuinely
  never taken. Not resolved either way.
- **`[0x8c2d]`'s own origin** (the value copied into `[0x8c2f]`) wasn't traced.
- **The literal contents of the ~36/119 (positive) and ~50/100 (negative) table entries whose walk
  stops at opcode 9/13/37/68's own variable-length body** weren't expanded past that point — doing
  so means re-deriving each of those opcodes' own runtime branch choices per specific script, which
  this doc's per-opcode sections already characterize at the semantic level; expanding every
  individual occurrence is unbounded, low-marginal-value repetition rather than a discovery gap.
- Op 43's exact operand semantics in the handful of overlapping-tail states that terminate on an
  off-the-end byte (see "Full script-table coverage" above) — plausible but unconfirmed explanation
  given, not independently proven via a runtime trace.
