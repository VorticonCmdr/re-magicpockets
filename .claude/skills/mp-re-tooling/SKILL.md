---
name: mp-re-tooling
description: Tooling gotchas for the Magic Pockets port - DOSBox bridge recipes (restart, launch, warp, video + memory capture), the live-capture pipeline, disassembly, verify. Read before touching DOSBox or adding a capture.
---

# Magic Pockets RE tooling (all `[PROVEN]` unless noted, 2026-10-10)

## DOSBox (mcp__dosbox__*)
- Restart: `bridge_stop`, `bridge_start`, `drive_mount C /Users/valentin.pletzer/Downloads/dosgames/magicpockets/build/dosbox-c`, then type `C:\n`, then `G`, then `AMEU\n` (one `input_type` call drops letters). GAMEU exits to DOS when the attract tape ends or the level-end screen is confirmed: after that a second launch in the same emulator crashes, so restart again.
- Scripts run on the emulation thread: while paused they do not run. Lua budget is 1,000,000 instructions per script; a plain frame loop costs ~25/frame, a logged row ~40 (use `fmt(('%02x'):rep(n), byte(mr(DS, off, n), 1, -1))`). `script_status` shows `instruction limit exceeded` when it runs out. `dosbox.log` lines land in the debug log on disk (`script_log` or the `logs/` path in `script_status`), the only way to get bulk memory into files (`mem_read` output exists only in the chat).
- DS segment is 0x5FD8 live (linear 0x5FD80), CS 0x1F5. Key names are `KBD_*`; hold keys >= 6 frames; F2 + four digits within ~20 iterations warps (codes in docs/dosbox-debugging.md). Lua `mem_write` takes a string (`string.char(...)`).
- Frame-exact comparison recipe: `video_capture_start`, run a Lua script that logs `ROW ... G/L/B` hex dumps every few frames, `video_capture_stop`, `ffmpeg -i video000N.avi -pix_fmt rgb24 -f rawvideo v.rgb` (320x200), then `node tools/sprite-video-compare.mjs <world> dump.log v.rgb`. The video frame index of a dump is unknown, so the tool searches all frames for the best match.
- Execute breakpoints with a memory `condition` work (`debug_breakpoint_add`; pause first, they arm on `debug_continue`; `once:true` for one-shots). A paused emulator shows the previous frame on screen.
- `bridge_stop` was once denied by the permission classifier; the user later approved restarts in chat, then it worked.

## Live capture pipeline
- `tools/attract-capture/capture-live-chain.lua` (random driven play + level-code warps; set `SEED`, `PER`, `CODES`, `GOD=false` for non-god) -> debug log -> `node tools/attract-capture/import-entities.mjs log out.json` -> `gzip -9` into `tools/attract-capture/liveNN-*.capture.json.gz` -> add a segment `[sub, fromRow, toRow, minMatched, loadStart]` to the ratchet list in `web/verify/checks.js` (`loadStart` true starts from the first captured row instead of a boot from files).
- A warp that does not take (wrong timing) leaves the hero in the old level: the segment keys printed by the free-run tool show which warps happened. After GAMEU's own end-of-demo the capture rows are not a level.

## Static work
- `build/analysis/dis.sh <hex CS offset> <lines>` (adds 0x340 itself); DS offset 0 = file 0x5E170. Transliterate, keep the `1000:` address in a comment, send unread branches to `ctx.unported`.
- `node $SCRATCH/fuzz.mjs` style engine-only fuzzing finds reachable unported branches; the ports it leads to are `[STATIC]` until a capture reaches them.

## Verify
- `npm run verify` prints its own totals; quote them, never copy a count from a doc. Checks compare against literals or shipped bytes (lint rejects tautologies). Commit only explicit file names; the working tree holds the user's uncommitted edits.
