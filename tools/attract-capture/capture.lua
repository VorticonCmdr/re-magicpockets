-- capture.lua: log the attract demo, one row per main-loop iteration (tape cursor value).
-- Run through the dosbox-mcp script API. drive.md documents how; START/END below are replaced
-- by the driver (iterations [START, END) of the 2342-iteration demo).
--
-- Sampling rule: a row is the LAST poll made while the tape cursor (record index, remaining count)
-- stayed unchanged. That poll falls after call #8 (Entity_UpdateAll) and before the next
-- iteration's call #7 (Demo_PlaybackInput), so the entity state is the state after iteration
-- `done`. Camera globals are read too but change in call #1, so they are NOT a stable sample.
--
-- Row: rec,rem,e0x,e0y,e1x,e1y,e1state,e1flags,e1kind,rng,score,camx,camy  (all unsigned words;
-- the reader reinterprets as signed). Slots are the first two entries of the pointer array
-- DS:0x9090. DS is hard-coded to the segment seen in this session (0x5FD8); the dosbox API takes (segment, offset).

local DS = 0x5FD8
local START, END = __START__, __END__

local function B(o) return dosbox.mem_read_byte(DS, o) end
local function W(o) return dosbox.mem_read_word(DS, o) end

local rows = {}
local state = 'wait'
local prev, prevkey = nil, nil
local rec, prefix, lastcount = 0, 0, 0
local prevdone = nil

local function flush()
  dosbox.output['rows'] = table.concat(rows, ';')
  dosbox.output['n'] = #rows
end

dosbox.output['state'] = 'wait'
while true do
  dosbox.wait_frames(1)
  local flag = B(0x8BAA)
  local ptr = W(0x8BA6)
  local rem = B(0x8BA8)

  if state == 'wait' then
    if flag == 1 and ptr == 0x8200 and rem == B(0x8200) then
      state = 'run'
      rec, prefix, lastcount = 0, 0, B(0x8200)
      dosbox.output['state'] = 'run'
    end
  end

  if state == 'run' then
    if flag ~= 1 then break end
    local rr = (ptr - 0x8200) // 2
    if rr ~= rec then
      prefix = prefix + lastcount
      rec = rr
      lastcount = B(0x8200 + 2 * rr)
    end
    local key = rr * 256 + rem
    local done = prefix + lastcount - rem
    if prev and key ~= prevkey and prevdone >= START and prevdone < END then
      rows[#rows + 1] = prev
      if #rows % 100 == 0 then flush() end
    end
    if key ~= prevkey and done >= END then prev = nil; break end
    local p0, p1 = W(0x9090), W(0x9092)
    prev = string.format('%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d',
      rr, rem, W(p0 + 6), W(p0 + 8), W(p1 + 6), W(p1 + 8), B(p1 + 1), W(p1 + 0x24), W(p1 + 4),
      W(0x8B71), W(0x8B75), W(0x8BBB), W(0x8BBD))
    prevkey, prevdone = key, done
  end
end

if prev and prevdone >= START and prevdone < END then rows[#rows + 1] = prev end
flush()
dosbox.output['state'] = 'done'
