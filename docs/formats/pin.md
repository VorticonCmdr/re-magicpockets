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

**Non-MIDI table entries** (confirmed present, not yet decoded byte-for-byte):

| File | Non-MIDI entries (sound_id -> file offset) |
|---|---|
| `adlib.pin` | 11 -> 2747, 52 -> 9591, 59 -> 12296, 69 -> 15536 |
| `roland.pin` | 19 -> 2065 |

Each begins with a small count byte (`0x63`/99 or `0x43`/67) followed by that many byte pairs —
consistent with an OPL2 register-reset sequence (write `0x00` to a run of OPL2 registers to
silence all channels) rather than a sequence the MIDI-cue player would ever be asked to play back
as a tune. Not yet traced against the actual OPL2 register-write code to confirm the pair
semantics.

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
- The non-MIDI table entries' exact byte-pair semantics (see above) — plausible as an OPL2
  register-reset sequence but not confirmed against the OPL2 register-write code.
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
