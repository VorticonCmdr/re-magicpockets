# `.pin` sound-driver / music / sound-effect files

Loaded and invoked as described in `docs/memory-map.md`'s "`pockets.ini` parsing and
sound-driver loading" section: `Config_ParseIniAndLoadSoundDriver` (`1000:1af6`) reads the
driver-selector char from `pockets.ini` (`'A'`=Adlib, `'R'`=Roland, `'S'`=SoundBlaster,
`'B'`=Beeper, `'T'`=Tandy), depacks the matching `data\*.pin` file into segment `38b7`/`33a9`,
and — for the hardware-driver files — **invokes the loaded bytes directly as code** via a
computed far call (`CALLF [0x2029]`/`CALLF [0x202d]`). `Snd_TriggerEffect`/`Snd_TriggerEffectRaw`
(`1000:1ccf`/`1d4c`) are the runtime "play sound N" entry points that far-call back into whichever
driver got loaded.

This document covers what a byte-level scan of the 18 depacked `.pin` files (`build/raw/*.pin.raw`)
found, plus (see "Resource-offset table" below) a Ghidra disassembly of `player.pin`'s own driver
code that cross-verifies the table structure and how sound IDs index into it. The OPL/MT-32
driver's actual synthesis/interpretation loop is still not decoded — consistent with the project
plan's explicit deprioritization of sound ("least critical for a first playable port; do it
last") — only the resource container format has been traced.

## Headline finding: several `.pin` files are (or contain) genuine Standard MIDI Files

Scanning every depacked `.pin` file for the SMF chunk magic `"MThd"` and walking real,
self-describing MIDI chunk lengths from each occurrence (`tools/extract-pin.js`) finds valid,
complete embedded MIDI data in 4 of the 18 files — confirmed independently by macOS's `file(1)`
utility identifying the extracted `.mid` files as "Standard MIDI data" with no help from this
project's own code:

| File | Embedded MIDI | Role |
|---|---|---|
| `roland2.pin` | 1 song, offset 8, 17193 bytes, format 0, 96 PPQN, fills the entire file | A full music track for the Roland MT-32 driver. |
| `soundbnk.pin` | 1 tiny 49-byte placeholder track ("Track 1", one near-silent note, `format 0`, 192 PPQN) at offset 12, followed by **17259 bytes of unidentified trailing data** | Despite the name ("sound bank"), the MIDI portion here is a stub — the bulk of the file is something else entirely, not yet decoded. |
| `adlib.pin` | An 82-entry resource table; 78 entries are MIDI cues, 4 are not (see below) | A **sound-effect bank** for the Adlib driver — each cue is one short effect (jump, coin, hit, etc.), not a song. |
| `roland.pin` | Same 82-entry table shape; 81 entries are MIDI cues, 1 is not | Same sound-effect-bank structure as `adlib.pin`, for the Roland driver. |

`node tools/extract-pin.js <file.pin.raw> [out_dir]` extracts every embedded cue as a playable
`.mid` file (`<name>.mid` for a single song, `<name>.NNN.mid` per cue for a bank, `NNN` == the
cue's table index — see below). Run against all 18 files, this recovers **161 real, listenable
MIDI files** with zero further reverse-engineering of the OPL/MT-32 driver bytecode required — a
complete, verified audio-asset win for the eventual JS port (playable via any JS MIDI synth, no
need to emulate period sound hardware for these specific files).

## Resource-offset table: confirmed structure and indexing (via Ghidra disassembly of `player.pin`)

`adlib.pin` and `roland.pin` (and, as a degenerate one-entry case, `roland2.pin`/`soundbnk.pin`)
share one container shape: a 2-byte entry count, followed by that many 4-byte little-endian file
offsets — one per entry, entry `i`'s offset living at file offset `2 + 4*i`. Most offsets point at
a standalone MIDI cue (`MThd` + its `MTrk` chunks); a handful point instead at a short non-MIDI
byte sequence (see below).

This was cross-verified, not just inferred from file bytes, by disassembling `player.pin.raw`
directly in Ghidra (imported as a raw `x86:LE:16:Real Mode` blob — it's the shared driver code
module every hardware backend loads into segment `38b7`). `GAMEU.EXE`'s `Snd_TriggerEffect`
(`1000:1ccf`) far-calls into it with `AH=1` (command), `AL=sound_id`. Command `1`'s handler
(`player.pin` offset `0x01c6`) reaches the per-backend cue-trigger routine (offset `0x231f` for
the Adlib-family path; structurally identical for Roland) which:

1. Bounds-checks `AL` (the sound ID) against a count byte at the table's start.
2. Computes the entry address with a **fixed 4-byte stride, indexed directly by `sound_id`** —
   `table_base + 4*(sound_id+1)` — no compaction and no skipping of non-MIDI slots.

In other words: **table entry N *is* sound ID N**, always — including the entries that aren't
MIDI cues. This confirmed a real bug in the original version of `tools/extract-pin.js`: it found
cues by scanning the whole file for `"MThd"` and numbered them sequentially (0, 1, 2, ...), so
every ID after a non-MIDI table entry was off by however many non-MIDI entries preceded it. The
extractor now reads the offset table directly and names each output file by its **table index**,
leaving a gap at non-MIDI entries instead of shifting later IDs down.

**Follow-up pass, refines the entry layout**: `player.pin`'s own `Snd_SelectCueForPlayback`
(`0x231f`, renamed from `FUN_0000_231f`) reveals each 4-byte entry isn't really one 32-bit
offset — it's **`[2-byte file offset][1 flag byte][1 tempo-scale byte]`**, read and stored as
three separate fields: the 2-byte offset feeds the playback cursor; the 3rd byte is copied to
`[0xb88]`, a per-cue playback-type flag the `AH=1` command dispatcher checks immediately after
cue selection; the 4th byte is copied to `[0x2976]`, folded into the tick-interval computation
inside `FUN_0000_268d` (a per-cue tempo/pitch-scale fine-tune, added to a global base constant
before scaling the tempo value). Checked against every entry in every shipped resource table
(`adlib.pin`, `roland.pin`, `roland2.pin`, `soundbnk.pin`): **both extra bytes are `0` in every
single entry**, in every file — real, driver-supported per-cue fields that this game's own
content simply never uses. This means `tools/extract-pin.js`'s simpler "read 4 bytes as one
little-endian offset" always happens to give the right answer for this game's actual files, even
though the driver code treats the field as three separate values, not one.

**Non-MIDI table entries** (confirmed present, not yet decoded byte-for-byte):

| File | Non-MIDI entries (sound_id -> file offset) |
|---|---|
| `adlib.pin` | 11 -> 2747, 52 -> 9591, 59 -> 12296, 69 -> 15536 |
| `roland.pin` | 19 -> 2065 |

Each begins with a small count byte (`0x63`/99 or `0x43`/67) followed by that many byte pairs —
consistent with an OPL2 register-reset sequence (write `0x00` to a run of OPL2 registers to
silence all channels) rather than a sequence the MIDI-cue player would ever be asked to play back
as a tune.

**Follow-up pass — confirmed these entries are real, live content and found the general
byte-stream interpreter, but that interpreter's own reading actually complicates the original
"OPL2 register-reset sequence" guess rather than confirming it. Left genuinely open, with a
concrete recommendation for how to finish it (dynamic tracing).**

- **Confirmed live, not dead data**: `GAMEU.EXE`'s `Game_WarpToLevelStageAndRunLoop` (the
  level-start routine, `1000:03ff`) calls `Snd_TriggerEffect(sound_id=11)` directly
  (`MOV AH,1; MOV AL,0xb; CALL Snd_TriggerEffect`, `1000:07e1`-`07e5`) — `adlib.pin`'s first
  non-MIDI table entry. So this isn't leftover/unused resource-file padding; it's genuinely
  played at a specific game moment (level warp/start), through the *exact same* `AH=1`
  trigger-effect path as any ordinary MIDI cue, including the same `Snd_SelectCueForPlayback`
  setup other cues go through.
- **Found the real per-tick byte-stream interpreter** (entry around `0x23ec`, reached once per
  timer tick via `Snd_ServiceTick` → `FUN_0000_2384` → the per-running-status dispatch table,
  whenever `[0x2992]` is nonzero — which `Snd_SelectCueForPlayback` sets for *every* selected cue,
  MIDI or not). It reads one byte at the cursor (`LODSB` from `[0x297e]`) and splits on value:
  bytes `< 0x20` dispatch through a 16-entry control-code jump table at `0x23c2` (read via
  `read_memory`); bytes `>= 0x20` fall to a **note-on handler at `0x256b`** that computes
  `note = byte - 0x20`, looks it up in a frequency table at `0x29b8`, and calls
  `FUN_0000_268d` (the tempo/PIT function from the "Resource-offset table" section above) —
  i.e. a completely ordinary "play this note" path, not a register-write path.
  **Problem**: `adlib.pin` entry 11's own first byte is `0x63` (99, `>= 0x20`) — feeding it
  through this exact interpreter reads as *note-on, note `0x43`(67)*, not as a pair count. That
  doesn't fit a "zero every register" reading at all, which undercuts the original count-byte
  hypothesis rather than confirming it — the earlier "byte pairs = (register, value)" read (this
  doc, previous pass) was a plausible-looking coincidence in the raw bytes, not something that
  survives tracing through the actual code that would run when this cue plays.
- **`Opl2_WriteRegister`** (`0x22e3`, renamed from `FUN_0000_22e3`, see above) remains confirmed
  as the real OPL2 write primitive on its own terms (write-timing exactly matches the documented
  hardware spec) — that part of the previous pass's finding stands. What's now in doubt is only
  whether *this specific* byte stream is what feeds it.
- **Static disassembly has hit its limit here.** Reading the driver's control-flow by hand no
  longer distinguishes between "there's a special-cased reset path this pass didn't find" and
  "the count-byte reading was simply wrong." Settling it needs **dynamic tracing** — running the
  game in DOSBox with a debugger, breaking on `Opl2_WriteRegister` (or on `Snd_TriggerEffect`
  with `AL=11`), and watching what actually executes when `Game_WarpToLevelStageAndRunLoop` fires
  this cue at a real level warp. A `dosbox-mcp` server is configured for this project
  (`.mcp.json`) but wasn't available in this session — a natural next step for whoever picks this
  back up.

## RESOLVED — `level0/new1/level2/level3a-c/level4.pin` are level-scripting bytecode, not music

An earlier pass here classified these by header-shape similarity and guessed "per-level music/
cue-sequence data... but the internal structure is not decoded". That guess was wrong: these
seven files are **entity/object placement scripts** (enemy, item, and trigger spawn records with
type + X/Y position), consumed by `Level_RunScriptedEventStream`/`Entity_SpawnFromQueuedEvent`,
not by any sound driver. Traced from the actual load site (`World*_LoadBanks` loads each straight
into the main data segment at its own exact unpacked size — a different pattern from every sound
`.pin`, which load into the shared `38b7`/`33a9` driver-code segments) and confirmed by decoding
the full record format and overlaying the extracted positions on rendered levels. Full writeup:
`docs/formats/pin-level-script.md`. `tools/extract-level-script.js` does the extraction; wired
into `tools/build-all.js`.

## The other 12 `.pin` files — not yet decoded, tentatively classified by header shape

No `"MThd"` was found anywhere in these; classification below is a first-pass guess from the
leading bytes only, **not decoded**:

- **`adlib2.pin` / `adlib3.pin`** (10328 bytes each, byte-identical header
  `01 00 08 00 00 00 80 00 ...`) — share the exact same small-header shape as `roland2.pin`
  (`01 00 <offset:2> 00 00 80 00`, offset word = `0x0008` here too) but nothing resembling MIDI
  sits at that offset. Best guess: these are the **Adlib-hardware equivalent of `roland2.pin`'s
  song** — i.e. the same music re-encoded as a raw OPL register-command stream instead of MIDI,
  using an identical container wrapper. Not decoded.
- **`beeper.pin` / `tandy.pin`** — begin with `E8 xx xx CB` repeated twice (`CALL rel16; RETF`
  ×2): two tiny code trampolines, consistent with the simplest drivers (PC speaker / Tandy
  3-voice have no music-resource format to speak of, just tone-generation code). Code, not data.
- **`player.pin`** — begins with a genuine multi-register push prologue
  (`1E 06 50 51 52 53 55 56 57 9C FC ...` = `push ds,es,ax,cx,dx,bx,bp,si,di; pushf; cld`), the
  shape of a real interrupt-service routine, not a data blob. Matches the original project-plan
  note that "`player.pin` starts with real x86 prologue bytes once depacked". Role unconfirmed —
  possibly a shared low-level sound-service routine loaded regardless of which hardware driver is
  selected, given the generic name.
- **`sblaster.pin`** (59699 bytes, by far the largest) — header shape differs from the
  `adlib2`-style wrapper (`01 00 7a 00 08 00 ff 78 ...`). Not decoded.
  Given `data\*.pin`'s file-size the largest by a wide margin, likely contains the most complete
  driver code and/or the richest sound-effect/music resource of any file here.
- **`autoplay.pin`, `extra_2.pin`** — each a distinct, unclassified header shape. Not decoded.
  (`level0/new1/level2/level3a-c/level4.pin`, previously listed here, are RESOLVED — see above.)

## Open questions

- The `adlib2.pin`/`adlib3.pin`/`sblaster.pin` payload format (presumably raw OPL2/OPL3 register
  command streams) is undecoded — would need tracing the Adlib/SoundBlaster driver's own
  interpretation loop, not just the container header.
- `soundbnk.pin`'s 17259 bytes of post-MIDI trailing data.
- **Reopened, harder than it looked**: the non-MIDI table entries are confirmed *live* content
  (`GAMEU.EXE`'s `Game_WarpToLevelStageAndRunLoop` triggers `adlib.pin` sound ID 11 directly at
  level start, through the same `AH=1` path as any MIDI cue), and the real per-tick byte-stream
  interpreter that would consume them is now found (`player.pin` `0x23ec` onward) — but tracing
  entry 11's own first byte (`0x63`) through that interpreter reads as a "note-on" event, not a
  pair-count, which undermines rather than confirms the original "OPL2 register-reset sequence"
  guess. See "Resource-offset table" above for the full trail. Static disassembly alone couldn't
  settle this in the end; it needs dynamic tracing (DOSBox debugger, breakpoint on
  `Opl2_WriteRegister` or on `Snd_TriggerEffect(AL=11)` at a real level warp) to find out what
  actually executes.
- `adlib.pin`'s MIDI cues embed OPL2 timbre parameters as `FF 7F` (SeqSpec) meta events; a
  standard SMF player (and this project's `tools/midi-player.html`, which just uses Web Audio
  oscillators) ignores them, so playback timbre doesn't match the original AdLib sound. Would
  need an OPL2-synthesis backend to render correctly.
- Several `roland.pin` cues (IDs 0, 17, 18, 79) set CC7 volume to 0 with velocity 1, making them
  effectively silent in a standard MIDI player — plausibly intentional "stop"/silence signals for
  the MT-32 driver rather than extraction bugs, but not confirmed.
- `roland.pin` entries 11 and 51 are full multi-instrument music loops (77-78 notes, div=96 PPQ)
  embedded in what's otherwise a sound-effect bank, rather than short effects — entry 11 begins
  identically to `roland2.pin`'s song. Role/purpose not confirmed.
