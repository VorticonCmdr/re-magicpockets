# The launch chain: `pockets.com` -> `pockets.exe` -> `klogopok.exe` -> `intro.exe` -> `game.exe`

This is the full picture of how the shipped game actually starts, reverse-engineered from
`pockets.com`/`pockets.exe` directly (both are tiny hand-written stubs -- no UNP-unpacking
needed, no functions beyond `entry` for either).

## `pockets.com` — third-party copy-protection loader (NOT Renegade/Bitmap Brothers code)

The file DOS actually runs. Confirmed via embedded strings to be a licensed, third-party
protection product, not part of the game's own codebase:

```
RawCopy PC TSR Patch.
Copyright (c) 1992-93
Micro Systems International
1143 Monroe Street
Carleton, MI 48117-9301
Tech (313)-654-8402
Fax (313)-654-0729
```

Sequence (see `entry`'s plate comment in Ghidra for the full trace):

1. Runs a startup check, `Copy_ScanMemoryForSignature` -- scans real-mode memory segments
   (from a configured start point up to segment `0xa000`, in 4KB/`0x1000`-paragraph steps)
   for a marker byte via `REPNE SCASB`, then verifies a following string via
   `Copy_AppendMatchedString`. No floppy or `INT 13h` access appears anywhere in this
   routine — this is **not** a disk-based check; it looks like an anti-debugger/anti-monitor
   scan for a resident tool's signature.
2. On failure, shows `Copy_ShowVendorNoticeScreen` — a BIOS-text-mode box (auto-detects
   MDA vs color card, centers text, loads the ROM 8x16 font first via
   `Video_SetRomFont8x16`) displaying the vendor strings above.
3. On success, `Sys_HookInt21hAndRunGame`: saves the original `INT 21h` vector, installs
   `Int21_ProtectionHook` as the new handler, resizes its own memory block, and **EXECs
   `pockets.exe`** with an empty command tail.
4. The hook stays resident for the **entire session** — through `pockets.exe` and every
   program it EXECs in turn. It only acts on `AH=3Dh` (DOS "open file") calls, re-runs the
   same signature check once per session (flag-gated), and **always chains through to the
   original handler regardless of outcome** — it doesn't appear to block file opens on
   failure, only the initial startup check gates anything.
5. After `pockets.exe` returns, restores the original `INT 21h` vector and terminates.

Not fully traced to the instruction level: the exact signature bytes/strings being searched
for, and what triggers the vendor-notice path at runtime (a genuine debugger/monitor
detection vs. some other failure mode). Low priority — this is bolt-on third-party code with
no bearing on the game engine itself or the JS reimplementation.

## `pockets.exe` — the real game launcher

Everything the actual game needs to run, confirmed via embedded strings (`entry`'s full
trace is in its own plate comment):

1. Shrinks its own memory allocation (`INT21 AH=4Ah`) to free RAM for the child chain.
2. Saves the current video mode (`INT10 AH=0Fh`).
3. Opens `pockets.ini`, reads its **2nd line** (the video-driver selector char — same
   `'E'`/`'C'`/`'T'`/`'4'`/`'0'`/`'M'` scheme documented in `docs/memory-map.md` for
   `GAMEU.EXE`), and maps it to a single mode digit: `M`->`'0'`, `C`->`'1'`, `E`->`'2'`,
   `T`->`'4'`, anything else->`'3'`.
4. **EXECs `klogopok.exe`** with command tail `" /m<X> /t5 0"` (`X` = the mapped digit) —
   confirms `KLOGOPOK.EXE`'s own `/m`/`/t` switches (see `symbols/klogopou.json`,
   `Config_ParseCommandLineSwitches`) are driven directly by `pockets.ini`'s video-driver
   line. `/t5` -> `5*50` frames, matching `App_LoadAndDisplayLogoForMode`'s duration
   multiplier there.
5. **EXECs `intro.exe`** (no arguments) — the Bitmap Brothers logo/animation sequence.
6. **EXECs `game.exe`** in a loop: checks the exit code via `INT21 AH=4Dh` after each run,
   and if non-zero, patches the code into the next command-tail (as an ASCII digit) and
   EXECs `game.exe` again rather than exiting. A zero exit code breaks the loop.
7. Restores the original video mode and terminates cleanly (`INT21 AH=4Ch`).
8. Error path (any `EXEC`/open/read failing): restores video mode and prints
   `"SORRY, THERE IS A DISK ERROR CANNOT CONTINUE"` via `INT21 AH=09h`, then exits.

**RESOLVED: `game.exe` (== the already-depacked `GAMEU.EXE`, per this project's `U`-suffix
convention — `game.exe`/`GAMEU.EXE`, `intro.exe`/`INTROU.EXE`, `klogopok.exe`/`KLOGOPOU.EXE` are
each the same code before/after `UNP.EXE`) has exactly **one** genuine `INT 21h AH=4Ch` call
site in its entire code segment — found by a whole-binary `search_byte_patterns` for `b0 4c` and
confirmed by full decompile, not just a fragment:

- It sits inside the function Ghidra bounds as `Debug_CtrlCAbortAndExit` (`1000:19e9`, renamed
  from `Debug_RestoreStateAfterCheatMenu` — the earlier name/framing was wrong, see below),
  reached via a direct `JMP` (not `CALL`) from **two** places, not one:
  1. `Debug_HandleCheatInput`'s hidden **`p`-key single-step/pause console**, specifically when
     `[0x8c89] == 0x2E` — the `'C'` scancode latched by `Input_KeyboardIsr` only while **Ctrl is
     held** (`1000:0964`-`096b`). In other words: press `p` to enter the game's undocumented
     debug-pause mode, then press `Ctrl+C`.
  2. **`EntityScriptOp` opcode `53`/`0x35`** (`1000:2471`, `docs/entity-script-vm.md`) — a
     genuine **scripted "exit the game" trigger**, reachable from ordinary entity-script content
     (most plausibly a real ending/completion cutscene script), not just the hidden debug hotkey.
  Either way, execution jumps straight into a real, unconditional `MOV AH,4Ch; MOV AL,0; INT 21h`
  — genuine process termination, always with exit code **`0`**.
- The bytes immediately following that first exit call (`1000:19fa`-`1a25`) contain three more
  near-identical `INT 21h AH=4Ch` sequences with `AL=0`, `AL=1`, `AL=2`, `AL=3` respectively — but
  none of them has any incoming reference (`get_xrefs_to` found nothing pointing at any of
  `0x19fa`/`0x1a05`/`0x1a0e`/`0x1a17`/`0x1a20` individually). Since the very first `INT 21h`
  unconditionally terminates the process, none of these later blocks can ever execute — they're
  dead code (Ghidra's decompiler mis-threads them into one linear "function" because it doesn't
  model `INT 21h AH=4Ch` as non-returning, which is also why this whole region reads, misleadingly,
  as a function that "returns" to its caller in the raw decompile).
- The other candidate exit path, `App_ExitOrReset` (`1000:1987` — reached from
  `Load_PackedFile`'s fatal-disk-error handler and `World_Dispatch`'s default branch, and driven
  by the same "last raw scancode" byte for an `'A'`(bort)/`'R'`(esume) prompt), does its cleanup
  and explicitly **returns** to its caller on `'A'` rather than calling `INT 21h AH=4Ch` — it does
  not terminate the process either.

**Conclusion**: `game.exe` has no code path that produces a **non-zero** exit code at all — the
sole confirmed termination call always exits `0`, whether reached via the hidden `p`→`Ctrl+C`
developer hotkey or via a genuine scripted end-of-game event (opcode `0x35`). `pockets.exe`'s
"patch the non-zero code into the next command tail
and relaunch" loop (item 6 above) is therefore very likely **dead/defensive code for this shipped
build** — plausibly a leftover from an earlier development version where `game.exe` used the
`AL=1`/`2`/`3` exit codes to signal something to the launcher (a `World2`/`3`/`4` restart
selection would fit the values, given `entry()` already reads a single command-tail digit into
`DAT_1000_0140` and treats `'1'` specially — but current `entry()` only distinguishes `'1'` from
"anything else," it doesn't branch on `2`/`3`/`4` distinctly, consistent with that mechanism
having been retired). Not independently confirmed by tracing an actual `game.exe`→relaunch cycle
live (would require reproducing the `p`→`Ctrl+C` sequence in DOSBox and confirming `pockets.exe`'s
loop reads code `0` and exits cleanly, which the static evidence already makes the only plausible
outcome) — a small, low-priority follow-up for whoever wants full closure.
