-- capture-full.lua: like capture.lua but logs the raw bytes of the globals block and the first
-- entity records for each of the first END_ITER main-loop iterations of the attract demo.
--
-- Row (one dosbox.log line per iteration, same sampling rule as capture.lua):
--   ROW <done> <rec>,<rem> G:<hex of DS:0x8B50..0x8CAF> E:<ptr>=<hex of 66 bytes>;<ptr>=...
-- P: is the whole pointer array at DS:0x9090, L: the visible list at 0x91BE, Q: the spawn queue
-- 0x9270..0x939B, B: the first 120 entity records (0x9398 + 66*i). The importer rebuilds the entity
-- list by following the pointers in P (one Lua instruction per poll instead of per entity).
-- Polls cost ~350 Lua instructions each, so the whole run is limited to the first END_ITER
-- iterations to stay under the script's 1,000,000-instruction budget.

local DS = 0x5FD8
local END_ITER = 700
local rb, rw, wf, fmt, byte, mr = dosbox.mem_read_byte, dosbox.mem_read_word, dosbox.wait_frames, string.format, string.byte, dosbox.mem_read
local F66 = ('%02x'):rep(66)
local GLEN = 352
local FG = ('%02x'):rep(GLEN)
local FP = ('%02x'):rep(280) -- pointer array 0x9090..0x91A7
local FL = ('%02x'):rep(48)  -- visible list 0x91BE..
local FQ = ('%02x'):rep(300) -- spawn queue 0x9270..0x939B
local BLEN = 66 * 120        -- the first 120 entity records of the block at 0x9398
local FB = ('%02x'):rep(BLEN)

local state = 'wait'
local prev, prevkey, prevdone = nil, nil, nil
local rec, prefix, lastcount = 0, 0, 0
local nrows = 0

dosbox.output['state'] = 'wait'
while true do
  wf(state == 'wait' and 4 or 2)
  local flag = rb(DS, 0x8BAA)
  local ptr = rw(DS, 0x8BA6)
  local rem = rb(DS, 0x8BA8)

  if state == 'wait' then
    if flag == 1 and ptr == 0x8200 and rem == rb(DS, 0x8200) then
      state = 'run'
      rec, prefix, lastcount = 0, 0, rb(DS, 0x8200)
      dosbox.output['state'] = 'run'
    end
  end

  if state == 'run' then
    if flag ~= 1 then break end
    local rr = (ptr - 0x8200) // 2
    if rr ~= rec then
      prefix = prefix + lastcount
      rec = rr
      lastcount = rb(DS, 0x8200 + 2 * rr)
    end
    local key = rr * 256 + rem
    local done = prefix + lastcount - rem
    if prev and key ~= prevkey then
      dosbox.log('ROW ' .. prevdone .. ' ' .. prev)
      nrows = nrows + 1
      if nrows % 100 == 0 then dosbox.output['n'] = nrows end
    end
    if done >= END_ITER then prev = nil; break end
    local g = fmt(FG, byte(mr(DS, 0x8B50, GLEN), 1, -1))
    local bl = fmt(FB, byte(mr(DS, 0x9398, BLEN), 1, -1))
    local pa = fmt(FP, byte(mr(DS, 0x9090, 280), 1, -1))
    local vl = fmt(FL, byte(mr(DS, 0x91BE, 48), 1, -1))
    local qu = fmt(FQ, byte(mr(DS, 0x9270, 300), 1, -1))
    prev = rr .. ',' .. rem .. ' G:' .. g .. ' P:' .. pa .. ' L:' .. vl .. ' Q:' .. qu .. ' B:' .. bl
    prevkey, prevdone = key, done
  end
end

if prev then dosbox.log('ROW ' .. prevdone .. ' ' .. prev); nrows = nrows + 1 end
dosbox.output['n'] = nrows
dosbox.output['state'] = 'done'
