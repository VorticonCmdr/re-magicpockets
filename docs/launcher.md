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

**Open question**: what makes `game.exe` exit with a non-zero code to trigger a relaunch —
plausibly tied to the world/stage-warp or restart behavior already documented for
`GAMEU.EXE`'s `Game_WarpToLevelStageAndRunLoop`/cheat-menu paths, but not confirmed by
tracing `GAMEU.EXE`'s own exit-code value(s) yet.
