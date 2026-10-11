Magic Pockets – ModdingWiki article drafts
Prepared from the local repository on 2026-10-11.

Each article is UTF-8 MediaWiki source. The filename without .txt is its
proposed wiki page title. Paste the contents into that page's source editor.
README.txt is a handoff manifest, not an article.

Reference conventions:
https://moddingwiki.shikadi.net/wiki/Gods
and its linked Image, Tileset, Sprite, Map, Music, Demo and Configuration pages.
The overview follows Tools -> File formats -> Notes -> External links, ending
in Category:Game Intro Page. Format pages use the corresponding Game, Image,
Tileset, Map and Music infobox templates, then File format, any format-specific
sections, Source code and Credits. Formats without a suitable infobox in the
reference use the prose-first Demo/Configuration layout. Credits retain the
linked contributor and courtesy-credit paragraph style.

Scope:
- All 61 files in data/: 60 RNC-packed binary assets plus install.txt.
- game/pockets.ini, the executable configuration.
- EJWLIB directory and all three embedded HUF resources in KLOGOPOU.EXE.
- Sound driver modules are distinguished from sound data.
- sblaster.pin and extra_2.pin have explicit partial-format pages.
- Executable packing and unrelated .exe/.com programs are not asset formats.

Evidence and limitations:
- All 60 binary resources were decoded using web/core/rnc.js and their decoded
  CRC-16/ARC values matched the original headers in this run.
- Local original-file reads checked bank offsets, count, padding, compressed
  IDs, one-track format-0 MIDI headers, demo totals and logo entry sizes.
- The six music banks contain 168 MIDI sequences: 161 plain and 7 dictionary
  entries. Current basic viewer support remains limited to the plain entries.
- Original runtime details are sourced from the docs and parser comments.
  Static disassembly is not represented as fresh live testing in this task.
- The 2026-10-10 PIP DEGAS correction supersedes the early unexplained-header
  notes. The newer pin-sound.md supersedes the early OPL-reset/raw-stream guesses.
- Unknown INI lines, installer grammar, archive metadata, alternate logo pixel
  layouts, trailing soundbnk data and the two unclassified PIN payloads remain
  explicitly unresolved. No speculative layouts were added.
- Source links target repository main and describe the local checkout. Newly
  added/uncommitted source files may need publishing before those links work.
- Infobox edit capabilities are partial. A decoder/exporter is not an editor.

Articles:
- Magic Pockets.txt
- Magic Pockets Configuration Format.txt
- Magic Pockets Demo Format.txt
- Magic Pockets Extra Data Format.txt
- Magic Pockets Image Format.txt
- Magic Pockets Installer Script Format.txt
- Magic Pockets Level Script Format.txt
- Magic Pockets Logo Image Format.txt
- Magic Pockets Map Format.txt
- Magic Pockets Music Format.txt
- Magic Pockets RNC Compression.txt
- Magic Pockets Resource Archive Format.txt
- Magic Pockets Sound Blaster Data Format.txt
- Magic Pockets Sound Driver Format.txt
- Magic Pockets Sprite Format.txt
- Magic Pockets Tileset Format.txt

Per-file coverage:
- data/adlib.pin -> Magic Pockets Music Format
- data/adlib2.pin -> Magic Pockets Music Format
- data/adlib3.pin -> Magic Pockets Music Format
- data/ape.pak -> Magic Pockets Sprite Format
- data/autoplay.pin -> Magic Pockets Demo Format
- data/beeper.pin -> Magic Pockets Sound Driver Format
- data/bitkid.pak -> Magic Pockets Sprite Format
- data/blocks1.pak -> Magic Pockets Tileset Format
- data/blocks2.pak -> Magic Pockets Tileset Format
- data/blocks3.pak -> Magic Pockets Tileset Format
- data/blocks4.pak -> Magic Pockets Tileset Format
- data/endscrn.pip -> Magic Pockets Image Format
- data/extra_2.pin -> Magic Pockets Extra Data Format
- data/extras.pak -> Magic Pockets Sprite Format
- data/extrax1.pak -> Magic Pockets Sprite Format
- data/extrax2.pak -> Magic Pockets Sprite Format
- data/extrax3.pak -> Magic Pockets Sprite Format
- data/extrax4.pak -> Magic Pockets Sprite Format
- data/install.txt -> Magic Pockets Installer Script Format
- data/intro0.pip -> Magic Pockets Image Format
- data/intro1.pip -> Magic Pockets Image Format
- data/intro2.pip -> Magic Pockets Image Format
- data/intro3.pip -> Magic Pockets Image Format
- data/intro4.pip -> Magic Pockets Image Format
- data/intro5.pip -> Magic Pockets Image Format
- data/kidx1.pak -> Magic Pockets Sprite Format
- data/kidx2.pak -> Magic Pockets Sprite Format
- data/kidx3.pak -> Magic Pockets Sprite Format
- data/kidx4.pak -> Magic Pockets Sprite Format
- data/level0.pin -> Magic Pockets Level Script Format
- data/level1a.pap -> Magic Pockets Map Format
- data/level1b.pap -> Magic Pockets Map Format
- data/level2.pin -> Magic Pockets Level Script Format
- data/level2a.pap -> Magic Pockets Map Format
- data/level2b.pap -> Magic Pockets Map Format
- data/level3a.pap -> Magic Pockets Map Format
- data/level3a.pin -> Magic Pockets Level Script Format
- data/level3b.pap -> Magic Pockets Map Format
- data/level3b.pin -> Magic Pockets Level Script Format
- data/level3c.pin -> Magic Pockets Level Script Format
- data/level4.pin -> Magic Pockets Level Script Format
- data/level4a.pap -> Magic Pockets Map Format
- data/level4b.pap -> Magic Pockets Map Format
- data/nasty1.pak -> Magic Pockets Sprite Format
- data/nasty2.pak -> Magic Pockets Sprite Format
- data/nasty3.pak -> Magic Pockets Sprite Format
- data/nasty4.pak -> Magic Pockets Sprite Format
- data/new.pip -> Magic Pockets Image Format
- data/new1.pin -> Magic Pockets Level Script Format
- data/pcmap.pap -> Magic Pockets Map Format
- data/player.pin -> Magic Pockets Sound Driver Format
- data/roland.pin -> Magic Pockets Music Format
- data/roland2.pin -> Magic Pockets Music Format
- data/sblaster.pin -> Magic Pockets Sound Blaster Data Format
- data/sea.pap -> Magic Pockets Map Format
- data/soundbnk.pin -> Magic Pockets Music Format
- data/special1.pak -> Magic Pockets Sprite Format
- data/special2.pak -> Magic Pockets Sprite Format
- data/special3.pak -> Magic Pockets Sprite Format
- data/special4.pak -> Magic Pockets Sprite Format
- data/tandy.pin -> Magic Pockets Sound Driver Format
- game/pockets.ini -> Magic Pockets Configuration Format
- game/KLOGOPOU.EXE appended EJWLIB -> Magic Pockets Resource Archive Format
- embedded LOGO1.HUF -> Magic Pockets Logo Image Format
- embedded LOGO2_4.HUF -> Magic Pockets Logo Image Format
- embedded LOGO3.HUF -> Magic Pockets Logo Image Format
