# The AdLib sound driver: `player.pin`, `adlib.pin`, the command interface and the OPL2 register stream

Evidence tags as in CLAUDE.md: `[PROVEN]` = executed or traced live, `[STATIC]` = read from the disassembly only, `[UNKNOWN]` = not established.

This supersedes the "driver is undecoded" parts of `docs/formats/pin.md` for the **AdLib** path (`pockets.ini` line 1 = `Adlib`). The other drivers (`beeper.pin`, `tandy.pin`, `roland*.pin`, `soundbnk.pin`, `sblaster.pin`) are not looked at here.

## What was done, in one paragraph

`data/player.pin` is the sound driver's **code** (a 12 KB real-mode far-call module, entered at offset 0); `data/adlib.pin` is its **cue bank**. Both are depacked and loaded by `Config_ParseIniAndLoadSoundDriver` (`1000:1AF6`). The driver runs a Standard-MIDI-File sequencer (with its own meta event for OPL2 timbres) and writes OPL2 registers straight to ports `0x388/0x389`. `web/audio/x86-lite.js` runs those original bytes (a small 8086 interpreter), `web/audio/pin-driver.js` drives them exactly like GAMEU does, and the register stream it produces is **identical, token for token, to a DOSBox-X capture** of the real game (21678 stream tokens: INIT, all 82 cues, and the game's own commands during the attract demo; `npm run verify`, group `checkAdlibDriver`). `web/audio/opl2-chip.js` turns the stream into sound (an approximation, see below) and `demo.html?game&sound` plays it.

## Loading and the command interface

* `[PROVEN]` (live read of `[1F5:2029]`) With `Adlib` in `pockets.ini`, `player.pin` sits at segment `0x28B7 + 0x1F5 = 0x2AAC`, `adlib.pin` at `0x23A9 + 0x1F5 = 0x259E`, and `[cs:2029]` = `2AAC:0000`, the driver's far entry.
* `[STATIC]` `1000:1C92`: AL = 1 and DX = bank segment, CX = 0 go to command 0. Sound Blaster (`S`) takes the same `adlib.pin` path (`1C17` jumps to `1C92`); Roland, Beeper and Tandy load other files.
* The entry is `AH` = command (table of 14 near pointers at `player.pin:00D8`, `[STATIC]`). GAMEU uses four:

| AH | caller | meaning |
|---|---|---|
| 0 | `1CB0` (boot) | init: `AX=1`, `DX` = bank segment, `CX` = bank offset. Probes the OPL2 (timer-1 handshake on port `0x388`), writes the reset burst (436 register writes `[PROVEN]`), loads the cue table pointer. **Not a full reset**: some per-channel state (pitch words) survives a second init, so a trace must start from a driver nothing has played on `[PROVEN]`. |
| 1 | `1CCF` (`Snd_TriggerEffect`) | play cue `AL` (bit 7 = loop flag, `[STATIC]`; no GAMEU call site sets it). `1CCF` forces `AH=1` itself, so the caller's `AH` is irrelevant: **there is no priority argument**. `BL` = a round-robin counter `cs:1D4B` (0..7). |
| 2 | timer ISR `20DA` and the page-flip routine `1615` | one sequencer **tick**. |
| 3 | `1DAE` | stop all. |
| 4 | `1D4C` (`AX` = id) | stop cue `AL`. (Named `Snd_TriggerEffectRaw` in the Ghidra project; that name is wrong for AdLib.) |

* `[PROVEN]` `BL` matters: the same cue played with another `BL` writes different registers. `[STATIC]` (`0EB2`) it is added to the MIDI channel number to give the OPL channel (`channel + BL`, ignored if >= 11), so overlapping sounds land on different voices.
* `[STATIC]` The `+1` that `pin.md` quotes exists only on the Beeper/Tandy path (`1D09`: it stores `AL+1` into the driver's data segment). Opcode 15 of the entity script VM (`2670`) passes its operand unchanged to `1CCF` for AdLib; operand 0 calls `1DAE` (stop all) instead. `[PROVEN]` by the capture: the demo's `0F 04`-style scripts reach the driver as cue 4 etc.
* **Tick rate.** `[STATIC]` GAMEU reprograms PIT channel 0 with `0x5CEC` (`1000:2047-2051`); its INT 8 handler `2087` adds `0x5CEC` to a 16-bit accumulator and chains the BIOS handler on carry, so it fires at `1193181.8 / 0x5CEC` = **50.159 Hz** and issues command 2 once per interrupt (when the page-flip routine is waiting it issues the tick itself at `1615` instead, so exactly one per IRQ). Measured: the 5080 ticks of the capture span the 7100 DOSBox frames of the capture script (70.09 frames/s), 50.16 Hz `[PROVEN]`. The driver itself counts in units of `0x5D38` PIT counts (= 20 ms, i.e. it assumes 50.000 Hz), so music-time runs 0.3 % fast.
* **Re-entrancy.** `[PROVEN]` The driver has a lock byte `[0C9C]`; a tick that finds it set sets `[0C9D]` and the tick runs at the end of the busy command (`player.pin:009E`) with no entry through `0048`. A trace that logs ticks only at `0048` loses them (found the hard way).

## `adlib.pin`

`[PROVEN]` (verify) 82 cues. `u16` count, then per cue a 4-byte little-endian entry (the first two bytes are an offset; the driver reads all four as a 32-bit offset (`1371`), the upper bytes are 0). Cue N = table entry N; that is the id `1CCF` receives.

* 78 cues are plain SMFs (`MThd`, format 0/1, division `0x01A4`, `MTrk` chunks) **without** an end-of-track meta event; the cue ends when the sequencer runs off the declared track length.
* Ids **11, 52, 59, 69** start with a flag byte `0x63` (`'c'`; id 69: `0x43` `'C'`) instead. `[PROVEN]` (decoded in verify) The rest is `256 x u16` digram dictionary followed by one index byte per pair of output bytes; output byte `i` = byte `i & 1` of `dict[index[i >> 1]]`. For `'c'` the SMF starts at output byte 1, for `'C'` at byte 0 (`1408`: `AL = 1` for `0x63`). `pin.md`'s guess that these four are OPL2 reset sequences is wrong (⚠️ kept there): they are the longest cues (1.1-2 KB packed).
* `[STATIC]` Events (`0EA1`): status nibble 0 note off, 1 note on (velocity 0 = off), 2 and 5 (`0xA0`/`0xD0`) a volume update (`1B6D`), 6 pitch bend (`1B16`); controllers and program changes are skipped (instruments come from the meta event below). Sysex (`F0/F7`) is skipped, `FF 2F` ends the track, `FF 51` sets the tempo (default 500000 us per quarter, `10ED`).
* `[STATIC]` **Timbre meta event** `FF 7F <len> 00 00 3F <type:u16 BE> <arg> ...` (`0DFA`-`0E4F`): type 1 = define an OPL2 voice (`arg` = voice number, then 28 bytes of timbre, `len` = 34); types 2 and 3 = one-argument commands (`1D13`, `1EEA`). Voice definitions are sent with the first events of each cue, which is why the same cue can write a full patch load (`BD00 0800 4022 C000 ...`) or only a volume change depending on the driver's earlier state.
* `[STATIC]` Delays: a delta `d` (MIDI ticks) waits `d * T / 0x5D38` driver ticks with `T = tempo_us * 1.194 / division` (`10A1`, `0D1D`), the remainder carried in a 32-bit accumulator (`[bp+74]`/`[bp+76]`, `1FAE`). The slot state is 0x90 bytes, 9 slots (pointer table at `player.pin:0606`); a cue that finds no free slot is dropped (`139E`).

## What `player.pin` is not

`pin.md` credits the "Adlib-family path" to `231F`/`2384` (a `<0x20`-opcode stream interpreter). `[STATIC]` ⚠️ That is backend bit 1; `AX=1` in command 0 selects backend **bit 0** (`1113`, `1348`, tick `0CB0`), the SMF sequencer above. The `231F` code is not reached on the AdLib path.

## The DOSBox capture (the proof)

`tools/adlib-capture/make-patch.mjs` prints the `batch_execute` ops that patch a running GAMEU: far jumps into stubs in free memory (`8000:xxxx`) log into a ring buffer (`7000:0000`) every driver tick, every command GAMEU sends (`1D3C`/`1D9F`/`1E18`, run with interrupts off) and every OPL2 write (`player:22E3`), and a mailbox that the timer ISR serves lets `tools/adlib-capture/drive.lua` inject INIT and cues 0..81 (`BL = id % 8`) through the real driver. `chain.trace.gz` is the result of one run from a fresh GAMEU (`pockets.ini` = `Adlib`, restored afterwards): INIT, 82 cues, the attract demo's own commands, 5080 ticks, 16431 register writes.

`web/audio/trace-replay.js` feeds the capture's commands and tick count to `PinDriver` and compares the writes: **first mismatch none over 21678 tokens**. Lessons that cost runs: resetting the buffer while the game runs races with the stubs; the ISR can slip a tick between a log entry and its command unless the command runs with interrupts off; a tick can run from `009E` without passing `0048`.

## Which cue is played when

* `[PROVEN]` (engine vs capture, verify) In the captured demo window (68 commands, ticks >= 3700) the ported engine's `ctx.sound` requests equal the real ones, command for command: cue 1 (jump/script `0F 01`), `stop 4, stop 0x45, cue 0x46/0x47/0x48/6` (death, chosen by `[8B6B] & 3`), 9 (landing, `F5B2`), 3 (bounce, `E75F`/`ED5C`), 0x4E (`F53D`), 8 (`3DD3`), 0x25 (`52C4`), 0x1B (`5DB6`, power-up pickup: frame + 7), 0x26/0x4B/0x4C/0x4D (pickup, `4E24`), 0x2F, ...
* `[STATIC]` Other ids from the call sites (`grep "call 0x1ccf"`): 0x2B (opcode 73, `273D`; `6AD5`), 0x32 (`4569`), 0x35 (spawn bursts, `529A`/`5579`), 0x3B (clock at zero, `2A05`), 0x13 (`298F`, extra life `0C72`), 0x3C (`0BEC`, continues), 0x52 (`47BF`), 0x4A (`48B6`/`493F`), 4 (hit spark, `5260`), 2 (a block breaks), 0x14 (time bonus, `5B8F`), 0x43 (`D1C5`), 0x39/0x50 (`DA35`/`DA50`), 0x45 (`6F8E`, a long jingle: stopped again by death), 0xB (the world-4 ending, `07E5`), 0x16 (`037D`..`03FB`), and `ax + 0x28` at `596F`.
* **Music.** `[STATIC]` The AdLib GAMEU has **no background music**: no `1CCF` call site passes the loop flag (bit 7 of AL), and the four long cues (11, 52, 59, 69) are jingles that end by themselves (the oracle plays them 212 / 412 / 51 / 125 ticks and then they stop). `[PROVEN]` for the captured run (boot, world intro, the first 70 s of the demo): only one-shot cues. Cue 52 was requested once, right after a stop-all, by script opcode 15 (`267E`) at tick 1466 of the capture, i.e. during the lead-in to the attract demo; what 59 (`0x3B`) and 69 (`0x45`) accompany is `[STATIC]` from the call sites above.
* `adlib2.pin` / `adlib3.pin` are one-cue banks (`'c'` flag, a ~64 s song each when the oracle plays them, 11421 writes, no loop). GAMEU's loader never selects them (their name strings at `DS:8CDD`/`8CED` are not referenced) `[STATIC]`; `INTROU.EXE` carries the same name table. Which program plays them, and when, is `[UNKNOWN]` (`docs/open-questions-history.md`, `UNKNOWN_adlib_music_owner`).
* The world-intro screen's own sounds (cue 16 / cue 4 / stop 4 five times, then stop-all + cue 52) come from entity-script `PlaySound` ops (`267E`) while the intro loads `[PROVEN]` in the trace (ticks 426-1466) but are **not** wired in the page: their timing relative to the intro's video states is `[UNKNOWN]`.

## The chip model (`web/audio/opl2-chip.js`)

`[STATIC]` A register-level YM3812 written from the datasheet: 9 two-operator channels, the four waveforms, feedback, additive/FM connection, tremolo, vibrato, key-scale level and rate, an exponential attack and a datasheet-timed linear decay. Pitch is checked (A4: fnum 580, block 4 renders 439 Hz). Not modelled: rhythm mode (the cues write `BD = 0`), the composite sine, timers. It has not been compared sample-for-sample with real hardware or DOSBox audio; the register stream it consumes is the verified part.

## Using it

* Node: `new AdlibPlayer(playerBytes, bankBytes, 44100)` (`web/audio/opl-player.js`), `trigger(id)`, `stop(id)`, `stopAll()`, `render(out, n)`; `sink(id, kind)` is the `ctx.sound` hook.
* Page: `/demo.html?game&sound` (or `?sound` with the plain demo). Audio starts after the first key press or click.
* Engine hook: `stepIteration`/`stepIterationAfterRng` copy `ctx.sound` to `m.sound`; ported sites call `m.sound?.(id)`, `m.sound?.(id, 'stop')`, `m.sound?.(0, 'stopAll')`. Absent = no-op; it touches no data-segment byte, so every `[PROVEN]` engine ratchet is unchanged.
