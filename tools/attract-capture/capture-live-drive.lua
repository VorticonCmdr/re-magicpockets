-- capture-live-drive.lua: capture-live.lua plus a seeded random "player" driving the keyboard from
-- inside the script (dosbox.key), so one run is reproducible and needs no outside input tool.
--
-- Start it at the DOS prompt after mounting, then type GAMEU. It presses Enter on the world map until
-- the level has started (flag [8BAA] == 0xFF and the RNG seeded), then logs one row per main-loop
-- iteration (RNG word change, see capture-live.lua) while holding random key combinations.
-- Tune SEED and END_ITER below.

local SEED, END_ITER = 20261010, 4000
local GOD = false   -- keep the hurt timer [8B96] topped up: the hero is never hurt, so the run gets further (the writes show up
                    -- as [8B96] differences in the captured rows; treat [8B96] as scratch when replaying such a capture)
local ENTER_AFTER = nil -- after this many logged rows, also tap Enter now and then (to leave the end-of-level code screen)
local RIGHT = 45    -- percent of segments that hold Right (the rest: left 17, down 8, idle)
local DS = 0x5FD8
local rb, rw, wf, fmt, byte, mr = dosbox.mem_read_byte, dosbox.mem_read_word, dosbox.wait_frames, string.format, string.byte, dosbox.mem_read
local GLEN = 352
local FG = ('%02x'):rep(GLEN)
local FP = ('%02x'):rep(302)
local FL = ('%02x'):rep(48)
local FQ = ('%02x'):rep(300)
local BLEN = 66 * 145
local FB = ('%02x'):rep(BLEN)

local state = SEED
local function rnd(n) -- small LCG, independent of the host's math.random
  state = (state * 1103515245 + 12345) % 2147483648
  return (state // 65536) % n
end

local n_rows = 0
local held = {}
local function setkeys(want)
  for _, k in ipairs({ 'KBD_right', 'KBD_left', 'KBD_up', 'KBD_down', 'KBD_leftctrl', 'KBD_space', 'KBD_enter' }) do
    local w = want[k] or false
    if (held[k] or false) ~= w then dosbox.key(k, w); held[k] = w end
  end
end
local function pick()
  local r = rnd(100)
  local want = {}
  if r < RIGHT then want['KBD_right'] = true
  elseif r < RIGHT + 17 then want['KBD_left'] = true
  elseif r < RIGHT + 25 then want['KBD_down'] = true end
  if rnd(100) < 30 then want['KBD_up'] = true end
  if rnd(100) < 25 then want['KBD_leftctrl'] = true end
  if rnd(100) < 15 then want['KBD_space'] = true end
  if ENTER_AFTER and n_rows >= ENTER_AFTER and rnd(100) < 40 then want['KBD_enter'] = true end
  return want, 4 + rnd(40) -- hold for 4..43 frames
end

dosbox.output['state'] = 'menu'
while not (rb(DS, 0x8BAA) == 0xFF and rw(DS, 0x8B71) ~= 0) do
  wf(1)
end
dosbox.output['state'] = 'run'
local n, lastrng, left = 0, -1, 0
local want
while n < END_ITER do
  wf(1)
  -- the API writes a string's bytes (a number would be written as its decimal digits)
  if GOD then dosbox.mem_write(DS, 0x8B96, string.char(0x32)) end
  if rb(DS, 0x8BA1) == 0 or (ENTER_AFTER and n_rows >= ENTER_AFTER) then -- the player is in control (not frozen by READY / a fade)
    if left <= 0 then want, left = pick(); setkeys(want) end
    left = left - 1
  else
    setkeys({})
  end
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
    n_rows = n
    if n % 100 == 0 then dosbox.output['n'] = n end
  end
end
setkeys({})
dosbox.output['n'] = n
dosbox.output['state'] = 'done'
