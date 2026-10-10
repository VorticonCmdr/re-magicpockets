# Dynamic tracing with `dosbox-mcp`

A working recipe for when static disassembly hits its limit and you need to watch the real game
execute — e.g. resolving the `adlib.pin` sound-11 mystery in `docs/formats/pin.md`. Written up
after a session that got there, but only after a lot of avoidable friction.

## Setup

- `.mcp.json` declares a `dosbox` MCP server (`uvx dosbox-mcp`). If its tools (`mcp__dosbox__*`)
  aren't showing up, the session hasn't connected to it yet — restarting/reconnecting the session
  usually fixes this.
- **Start the emulator with `bridge_start`** (spawns a managed, debugger-capable instance and
  attaches in one call). Confirm with `bridge_status` / `dosbox_status` that the attached engine
  reports the debugger capability before relying on breakpoints. Per the maintainer, `bridge_start`
  works now. `[PROVEN]` 2026-10-09: `bridge_start` spawned an instance without the old 30 s
  timeout. ⚠️ **But it did not attach to it:** three `dosbox_with_debugger` processes were
  listening on `127.0.0.1:8386` at once (the new one, plus two older ones from other projects),
  and `bridge_status`/`dosbox_status` talked to a stale 3-day-old instance running another game
  (`TIMU.EXE`, `C:` mounted on `dosgames/tim/game/`). The tell is `bridge_status.managed_instance.pid`
  differing from the engine pid in `bridge_start`'s result. Before every session run
  `lsof -nP -iTCP:8386 -sTCP:LISTEN` and make sure exactly one DOSBox owns the port (and that it
  is the one you spawned) before reading any memory; otherwise you are tracing the wrong game.
  `[PROVEN]` 2026-10-09: after `pkill -f dosbox_with_debugger` cleared the stale instances,
  `bridge_start` spawned pid 24766, the engine reported that same pid with `uptime_ms` 40, and
  `lsof` showed it as the sole listener on 8386 — the clean case. `bridge_stop` only stops an
  instance the bridge itself spawned, so it errors ("no managed instance") after the process has
  been killed from outside; that is harmless, just call `bridge_start`.
  ⚠️ **Superseded earlier advice:** this document used to say `bridge_start` was unreliable here
  (it repeatedly timed out with "engine produced no token within 30.0s" and self-exited) and that
  the only reliable path was asking the user to launch DOSBox-X by hand, mounting the project
  directory as `C:`, stopping at the `C:\>` prompt and calling `bridge_connect`. Keep that manual
  route only as a fallback if `bridge_start` regresses.
- `dosbox_status` and `dos_memory_map` are good first checks — `dos_memory_map` in particular
  shows the real MCB segment layout, which is deterministic across runs of the same setup (in
  this session, `GAME.EXE`'s PSP consistently landed at segment `0x1E5`, code at `0x1F5`).

## Anchoring the Ghidra ↔ live address mapping

Ghidra imports `GAMEU.EXE` assuming a static segment (`1000` in this project's addresses, e.g.
`1000:03ff`). The real DOS-assigned segment at runtime is different (e.g. `0x1F5`) — but the
**offset** portion is identical between the two, since only the segment base is relocated, not
in-segment offsets. That makes `debug_map_set_base` a one-time, whole-session anchor:

1. `debug_pause`, then `cpu_read_registers` to get live `cs`/`eip`.
2. Sanity-check before trusting it: `mem_read` at physical `cs*16+eip`, and compare against
   `codegraph`/Ghidra's `read_memory` at the *assumed* corresponding static address
   (`0x10000 * ghidra_segment + ghidra_offset`, i.e. `1000:eip` → `0x10000000 + eip` as the
   `ghidra_address` integer). Bytes should match exactly.
3. `debug_map_set_base(ghidra_address, live_segment, live_offset)` once. After that,
   `debug_map_to_live`/`debug_map_to_ghidra` do the translation for you.

**This anchor is CS-only.** It translates *code* addresses correctly (same offset, corrected
segment) but does **not** apply to data. Near-pointer data references in the decompile (e.g.
`*(char *)0xfc2b`) are relative to `DS`, and live `DS` is a *completely different* segment from
live `CS` (e.g. `DS=0x5FD8` vs `CS=0x1F5` in this session) — there is no simple offset
relationship between them. For a global at Ghidra-doc address `0xNNNN` (the bare-hex style this
project's docs use for globals, e.g. `[0x8b89]`), the live physical address is
`live_DS * 16 + 0xNNNN`, using whatever `DS` currently reads from `cpu_read_registers` — **not**
the CS-based mapping. Verify the same way (compare bytes/known-value at a global you can predict,
e.g. a table with an expected pattern) before trusting a data read.

Different loaded modules (e.g. `player.pin`, loaded into its own segment at runtime, imported
into Ghidra separately as `player.pin.raw` with its own `0000:xxxx` addressing) need their own
independent anchor — the GAMEU.EXE mapping doesn't apply to them.

## Breakpoints: the gotcha that wasted the most time

> Breakpoints only arm on an actual **paused → `debug_continue`** transition. Adding a breakpoint
> while already running, or calling `debug_continue` when nothing was paused, leaves it inert —
> `debug_breakpoint_list` will keep reporting `"active": false"` and it will never fire, no matter
> how much the game code actually executes past that address.

The correct sequence, every time:
```
debug_pause            # even if you believe it's already paused — cheap, and idempotent
debug_breakpoint_add(type="execute", segment=..., offset=...)
debug_continue         # THIS is what arms it
```
Confirm with `debug_breakpoint_list` (`"active": true`) before trusting it'll fire. Also: a stray
`debug_pause`/`debug_continue` issued back-to-back with no real pause in between can leave the
emulator's CPU genuinely frozen (registers stop changing across calls, `debug_continue` returns
inconsistent `debugging`/`status` combinations). If registers look identical across repeated
`cpu_read_registers` calls despite time passing, the instance is stuck — don't keep prodding it;
`dosbox_shutdown` and get a fresh one from the user.

## Catching a specific event

Breakpointing a shared entry point (e.g. `Snd_TriggerEffect`) catches *every* call through it —
cheap to filter after the fact by reading the relevant register (`AX` in that case) at each hit
and `debug_continue`-ing past the ones that don't match. This is far more reliable than trying to
land a breakpoint on one specific call site's exact address and hoping that path is the only way
to reach the behavior you're after (it frequently isn't — see below).

## In-game debug/cheat console (this project specifically)

Confirmed procedure (h/t user testing this live): during gameplay, **press `F2` first** to open
the password/cheat prompt — typing digits directly during normal play does *not* register in the
cheat-code buffer (`0xe03b`-`0xe03e` near `DS:0`, confirmed sitting at the reset sentinel `0xBB`
after failed attempts). Only after `F2` does digit input actually populate the on-screen
`PASSWORD: NNNN?` prompt; confirm with Enter. `Debug_HandleCheatInput` (`1000:088d`) validates the
4-digit code against a table at `0xfc2b` (`DS`-relative) mapping code → `(world, sub-level)` byte
pairs at `0xfca4` — both readable live via `mem_read` to get the exact valid codes rather than
guessing (guessing worked poorly here: the table isn't obviously derivable from the digits alone).
Automated `input_key`/`input_type` calls to enter these digits were unreliable in this session even
after finding the `F2` step — direct user input on their own keyboard was what actually got a
warp to register (confirmed by reading `[0x8b89]`/`[0x8b8b]` live and seeing the world value
change). If automating this again, budget for it not working and having a human do the keypresses
while you watch via an armed breakpoint.

### Automating the level-code warp (`[PROVEN]` 2026-10-10: it works from a Lua script)

⚠️ The "unreliable" remark above is superseded: a Lua script that presses keys with `dosbox.key` on a frame schedule warps reliably.

- **F2 opens a prompt that expires after about 20 iterations** (an invisible class-0x2D entity; `Debug_HandleCheatInput` ignores digits while none exists). Type all four digits inside that window.
- Hold every key **at least 6 frames** (the keyboard ISR clears `[8B60]` on key-up and the handler reads it once per iteration; a 3-frame press can be missed). Leave about 14 frames between F2 and the first digit, then 6 frames down + 6 up per digit. Verify with `[E03B..E03E]` (each stored digit is `0xBC + digit`, empty is `0xBB`).
- The codes (read live from `DS:FC2B`, targets from `DS:FCA4`; not in the file image): world 1 sub 1-6 `1053 3425 8282 4476 7766 1467`; world 2 sub 1-7 `6245 5284 4757 2818 1960 6331 8712`; world 3 sub 1-8 `3505 0692 1786 9877 7962 4125 2219 3123`; world 4 sub 1-8 `8498 4370 3541 2823 1286 6067 5139 4400`; a 30th code `2456`.
- **Do not detect the warp by the first change of `[8B89]/[8B8B]`**: the loader writes `[8B8B] = 1` first and the real sub-level a moment later. Wait about 25 rows after the first change before treating the level words as final.
- After `GAMEU` starts, the intro may wait for **Enter** (`input_key KBD_enter`) before the level begins and the script's `[8BAA] == 0xFF` wait ends.
- The Lua instruction budget (1,000,000, cumulative over the script's lifetime, spent per frame polled) allows about 12,000 frames or 2,000+ logged rows; for long jobs split the work over several scripts (`bridge_stop` / `bridge_start` / remount between them).
- A warp keeps the game state (score, hearts, **and the generator `[8B71]`**); only the level is reloaded. Rows between starting to type and the warp contain the prompt entity, which the port does not model, so end each comparison segment where the next code starts being typed.

## Don't trust a single call site — read the whole function

The session's biggest wrong turn: finding *one* call to a function of interest
(`Snd_TriggerEffect(AL=11)`) inside `Game_WarpToLevelStageAndRunLoop` and assuming it fires on
every call to that function. The full decompile showed it was gated deep inside one specific
`(stage, sub-stage)` branch (the World-4-stage-10 ending sequence) — unreachable from an ordinary
level warp. Live tracing correctly showed the sound never fired during a World-2 warp, which is
what finally forced re-reading the *entire* function rather than the fragment first found. When a
live trace disagrees with a static read, re-check whether the static read covered the whole
function, not just the interesting-looking part.

## Capturing long traces with the Lua script API (`[PROVEN]` 2026-10-09)

`script_load` works now (the old `post_text` bridge error is gone). What it can and cannot do, as
used by `tools/attract-capture/capture.lua`:

- API: `dosbox.mem_read_byte(segment, offset)`, `mem_read_word`, `wait_frames(n)`, `log`, `output`.
  Memory calls take **(segment, offset)**, not a linear address. No registers, no debugger.
- A script has a hard **1,000,000 Lua instruction budget for its whole run** (the run dies with
  "instruction limit exceeded"), so poll sparsely (`wait_frames(2)`) and keep per-poll work small.
- `dosbox.output` is capped at 64 KB in total. For long captures call `dosbox.log(...)` per row
  with `debug:true`: the host-side log file (path in `script_status.log_path`, under
  `/var/folders/.../dosbox-automation/logs/`) is not capped and can be copied out with `cp`.
- `wait_for` accepts `for: script_done | frames (needs count) | memory | text | ...`; at most 4
  concurrent waits. Do not poll with `sleep`; watch the log file from a background shell loop.
- The memory **write breakpoint is a value poll**: it reports a stop some instructions after the
  store, so its CS:IP is not the writer. Trace with execute breakpoints instead.
- `dosbox_status.frame` keeps counting while the debugger is paused; time with the BIOS tick
  dword at `0040:006C`.
- After the demo's tape ends the original exits to DOS, and launching `GAMEU` again in the same
  emulator crashes (CPU at `0000:0005`). Restart with `bridge_stop` + `bridge_start` + remount.
- Reaching the attract demo: launch `GAMEU`, let the level start, press Esc, let "GAME OVER /
  CONTINUE?" time out; the title cycle then starts the demo by itself (about 2 minutes).

## Live-play capture notes (`[PROVEN]` 2026-10-10)

- Bridge key names are `KBD_*` (`KBD_enter`, `KBD_up`, `KBD_leftctrl`, `KBD_space`); `input_key` rejects `enter`, `space`.
- Lua scripts can drive the keyboard themselves: `dosbox.key('KBD_right', true/false)`. `dosbox.mem_write(seg, off, v)` writes the bytes of a **string**; a number is written as its decimal digits (`0x32` wrote "50" = `0x35 0x30`, which also clobbered the next byte). Use `string.char(n)`.
- `GAMEU` launched from the prompt starts world 1, level 1 directly ("THE CAVE / READY!", `[8BAA] == 0xFF`); the attract demo (`[8BAA] == 1`) only comes later from the title cycle. Typing `GAMEU` in one `input_type` call sometimes drops letters; typing `G` and then `AMEU\n` is reliable.
- One row per main-loop iteration is possible by polling every frame and logging when the RNG word `[8B71]` changes; a poll landing between call #8 and call #13 gives a mid-iteration row (detect it from the RNG carry sequence, see `runLiveConformance`).
- The script instruction budget is spent per frame polled, not per byte read: block reads with `mem_read` are cheap, so 3000+ rows fit.

## Tools that didn't work this session

- `script_run` (Lua scripting), original session — hit an internal bridge error (`'Connection' object has no
  attribute 'post_text'`) on every attempt, including a trivial one-line script. Worth retrying in
  a fresh session/bridge version, since frame-accurate scripted input (rather than manually
  interleaving `input_key`/`debug_continue`/`debug_status` calls) would have avoided most of the
  timing friction above.
- `bridge_start` — it failed in the original session (see the ⚠️ note in Setup); it is now
  reported to work.
