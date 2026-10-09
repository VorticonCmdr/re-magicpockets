-- capture.lua: log the attract demo, one row per main-loop iteration (tape cursor value).
-- Load it through the dosbox-mcp `script_load` tool with debug:true; every row is written with
-- dosbox.log(), so the whole demo lands in the host-side debug log file (path in script_status's
-- log_path), which `tools/attract-capture/import-log.mjs` turns into autoplay.raw.json. The
-- script waits for the demo to start by itself (flag [8BAA]==1, cursor at the first record).
--
-- Sampling rule: a row is the LAST poll made while the tape cursor (record index, remaining count)
-- stayed unchanged. That poll falls after call #8 (Entity_UpdateAll) and before the next
-- iteration's call #7 (Demo_PlaybackInput), so entity state is the state after iteration `done`.
--
-- Row: ROW rec,rem,e0x,e0y,e1x,e1y,e1state,e1flags,e1kind,rng,score,camx,camy (unsigned words;
-- the reader reinterprets as signed). Slots are the first two entries of the pointer array
-- DS:0x9090. DS is hard-coded to the segment seen in this setup (0x5FD8); the dosbox API takes
-- (segment, offset). Camera columns duplicate slot 0 (verified over the first 200 rows).

local DS = 0x5FD8

-- Scripts have a hard cumulative budget of 1,000,000 Lua instructions, so polling is sparse (every
-- 2 frames while running, 4 while waiting) and reads go straight to the API functions.
local rb, rw, wf, fmt = dosbox.mem_read_byte, dosbox.mem_read_word, dosbox.wait_frames, string.format
local function B(o) return rb(DS, o) end
local function W(o) return rw(DS, o) end

local state = 'wait'
local prev, prevkey, prevdone = nil, nil, nil
local rec, prefix, lastcount = 0, 0, 0
local nrows = 0

local function emit(row, done)
  dosbox.log('ROW ' .. done .. ' ' .. row)
  nrows = nrows + 1
end

dosbox.output['state'] = 'wait'
while true do
  wf(state == 'wait' and 4 or 2)
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
    if prev and key ~= prevkey then
      emit(prev, prevdone)
      if nrows % 100 == 0 then dosbox.output['n'] = nrows end
    end
    local p0, p1 = W(0x9090), W(0x9092)
    prev = fmt('%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d',
      rr, rem, W(p0 + 6), W(p0 + 8), W(p1 + 6), W(p1 + 8), B(p1 + 1), W(p1 + 0x24), W(p1 + 4),
      W(0x8B71), W(0x8B75), W(0x8BBB), W(0x8BBD))
    prevkey, prevdone = key, done
  end
end

if prev then emit(prev, prevdone) end
dosbox.output['n'] = nrows
dosbox.output['state'] = 'done'
