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
5. **EXECs `intro.exe`** (no arguments) — the captions / close-ups / MAGIC POCKETS title sequence (see "What the two programs show" below). ⚠️ `[PROVEN]` 2026-10-10 by DOSBox video: `klogopok.exe` shows the Konami / Renegade copyright screen, NOT a Bitmap Brothers logo (older wording corrected); "A BITMAP BROTHERS GAME" is a caption inside `intro.exe`.
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

## What the two programs show (`[PROVEN]` against DOSBox video unless tagged)

Ported as `web/engine/klogo.js` and `web/engine/intro.js`; `npm run verify` group `checkPrelude` compares every video frame by hash with
`tools/front-capture/prelude.capture.json.gz` (made by `tools/front-capture/import-prelude.mjs`; procedure in its header). In the page: `demo.html?game&intro`.

**`klogopok.exe /m1 /t5 0`** (`KLOGOPOU.EXE`, MZ header 0x30 bytes). Mode digit 1 = video driver `C`. The picture is the resource `LOGO1.HUF` of an `EJWLIB`
archive appended to the EXE (offset 15228 = MZ image size; 10-byte header = entry count, key word, "EJWLIB"; 22-byte entries XORed with a running key,
`key += key >> 8` per byte, the key continuing across entries: `LOGO1.HUF` 6455 bytes at 76, `LOGO2_4.HUF` 4155 at 6531, `LOGO3.HUF` 3092 at 10686 for the other video
modes). Streams are LZHUF (`web/core/lzhuf.js`; ring buffer 4096 prefilled 0x20, start 4036, match length `c - 253`, 4-byte size first); LOGO1 unpacks to
32000 bytes = 200 rows x (4 planes x 40 bytes), copied to VRAM in 8 interlaced passes. Target colours: 48 six-bit DAC bytes at DS:04A6 (DS = file 0x30 + 0x3660).
Fade in = 32 steps of +2 per component (clamped to the target), hold 50 x t ticks (any key ends it), fade out 32 steps of -2. The clock is the PIT-0 interrupt
at divisor 0x5D2E = 50.02 Hz, NOT vsync, so a tick is 1.401 video frames, and a palette write lands mid-frame: 47 of 440 video frames are torn (rows above the beam show
the previous step). 43 frames in, 352 hold, 45 out.

**`intro.exe`** (`INTROU.EXE`, MZ header 0x90, DS = file 0x90 + 0x2FD0, mode `C` = EGA 0x0D, page 352 px wide). Pictures `intro0..5.pip` are Degas PI1 (see
`formats/pip.md`), 320 x 200, uploaded to off-screen VRAM slots A400..AE00; the page is composed with latch-copy blits (`13E5`). Colours come only from a table of
16-word banks at DS:BC9E (32 bytes each, banks 0x00..0x3B real); bank AL is applied by `0571`. Everything that moves is a bank switch plus a few blits:
`064A` banks 0 -> 0x11 -> 7 at 1 vsync each (the white hold of 8 frames = banks 0xE..0x11 and back), `06A7` / `07C8` fades at 2 vsyncs per bank, `0596` the title's star twinkle
(banks 0x22..0x26, 5 vsyncs each, script word - 1 steps), `086C` 16 invisible vsyncs. **Every wait (`0F57` and `0596`) ignores the AX the caller passes** and reads the next word of a
per-sound-driver script at DS:[BAEF] (Beeper `B`: BAF3, 41 words 448, 240, 165, 208, 148, 176, 40, 80, 5 x 4, ...; A BB45, R BBE9, S BB97, T BC3B; the exit path resets to BAF1 = 80). Order: black wait, RENEGADE,
PRESENTS, A BITMAP BROTHERS GAME (captions from `intro5.pip`, 64 rows only), four 96 x 96 close-ups (shoe, belly, jacket, face: `intro2`, `intro3`, `intro4`, `intro1`, six frames
each), the title (`intro0`) fading in and twinkling for 198 x 5 ticks, then LOADING (exit code 2; the abort path exits with 3). 431 successive screens equal the video; durations equal vsync counts
(the capture runs 0.3% long). Between the KLOGO fade-out and the first intro screen DOSBox shows 613 black frames = the 448-tick first wait + about 165 ticks of loading (disk time, a stand-in).
`[STATIC]` (not captured): any bound key (arrow, fire; `1FF3` ORs the ISR's key masks) during an `0F57` wait runs `0F83` (clear, LOADING, 80 ticks) and exits with code 3; the title twinkle (`0596`) and the
fades do not poll keys.
