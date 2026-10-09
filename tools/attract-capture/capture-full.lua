-- capture-full.lua: like capture.lua but logs the raw bytes of the globals block and the first
-- entity records for each of the first END_ITER main-loop iterations of the attract demo.
--
-- Row (one dosbox.log line per iteration, same sampling rule as capture.lua):
--   ROW <done> <rec>,<rem> G:<hex of DS:0x8B50..0x8CAF> E:<ptr>=<hex of 66 bytes>;<ptr>=...
-- Entities are the pointers in the array at DS:0x9090 (first 8, stopping at a 0 or 0xFFFF word).
-- Polls cost ~350 Lua instructions each, so the whole run is limited to the first END_ITER
-- iterations to stay under the script's 1,000,000-instruction budget.

local DS = 0x5FD8
local END_ITER = 700
local rb, rw, wf, fmt, byte, mr = dosbox.mem_read_byte, dosbox.mem_read_word, dosbox.wait_frames, string.format, string.byte, dosbox.mem_read
local F66 = ('%02x'):rep(66)
local GLEN = 352
local FG = ('%02x'):rep(GLEN)

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
    local es = {}
    for i = 0, 7 do
      local p = rw(DS, 0x9090 + 2 * i)
      if p == 0 or p == 0xFFFF then break end
      es[#es + 1] = fmt('%04x', p) .. '=' .. fmt(F66, byte(mr(DS, p, 66), 1, -1))
    end
    prev = rr .. ',' .. rem .. ' G:' .. g .. ' E:' .. table.concat(es, ';')
    prevkey, prevdone = key, done
  end
end

if prev then dosbox.log('ROW ' .. prevdone .. ' ' .. prev); nrows = nrows + 1 end
dosbox.output['n'] = nrows
dosbox.output['state'] = 'done'
