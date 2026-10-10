-- capture-live.lua: log one row per main-loop iteration of REAL play (not the attract demo).
--
-- Same row format as capture-full.lua (import-entities.mjs reads both), but there is no demo tape to
-- key on: an iteration is detected by the RNG state word [8B71], which Rng_NextValue (call #13)
-- changes once per iteration. The row header is `ROW <n> 0,0`; the keyboard words [8B67]/[8B68] are
-- inside the G block, so a replay can feed the captured input to the engine row by row.
-- Polls every frame; only the cheap RNG-word read runs on idle polls (1M Lua instruction budget).

local DS = 0x5FD8
local END_ITER = 1800
local rb, rw, wf, fmt, byte, mr = dosbox.mem_read_byte, dosbox.mem_read_word, dosbox.wait_frames, string.format, string.byte, dosbox.mem_read
local GLEN = 352
local FG = ('%02x'):rep(GLEN)
local FP = ('%02x'):rep(302) -- pointer array 0x9090..0x91BD incl. the front list and its terminator
local FL = ('%02x'):rep(48)
local FQ = ('%02x'):rep(300)
local BLEN = 66 * 145 -- the whole entity block 0x9398..0xB918
local FB = ('%02x'):rep(BLEN)

local n, lastrng = 0, -1
dosbox.output['state'] = 'wait'
while true do
  wf(1)
  if rb(DS, 0x8BAA) == 0xFF and rw(DS, 0x8B71) ~= 0 then break end
end
dosbox.output['state'] = 'run'
while n < END_ITER do
  wf(1)
  local rng = rw(DS, 0x8B71)
  if rng ~= lastrng then
    lastrng = rng
    local g = fmt(FG, byte(mr(DS, 0x8B50, GLEN), 1, -1))
    local bl = fmt(FB, byte(mr(DS, 0x9398, BLEN), 1, -1))
    local pa = fmt(FP, byte(mr(DS, 0x9090, 302), 1, -1))
    local vl = fmt(FL, byte(mr(DS, 0x91BE, 48), 1, -1))
    local qu = fmt(FQ, byte(mr(DS, 0x9270, 300), 1, -1))
    dosbox.log('ROW ' .. n .. ' 0,0 G:' .. g .. ' P:' .. pa .. ' L:' .. vl .. ' Q:' .. qu .. ' B:' .. bl)
    n = n + 1
    if n % 100 == 0 then dosbox.output['n'] = n end
  end
end
dosbox.output['n'] = n
dosbox.output['state'] = 'done'
