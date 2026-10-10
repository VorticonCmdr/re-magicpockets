-- Load through dosbox-mcp script_load (debug:true) ~5 s after GAMEU starts (a fresh process: the driver's INIT does not reset every
-- piece of state, so the capture must start from a driver nothing has played on) and after applying make-patch.mjs's ops.
-- It asks the driver to INIT, then to play cue 0..81 in turn (BL = id % 8, 80 frames apart, so the long ones overlap their
-- successors on purpose), while the attract demo's own sound requests interleave. Frame counts are DOSBox frames (70 Hz).
-- The final dump is the only read of the buffer: resetting it while the game runs races with the logging stubs.
dosbox.mem_write(0x7000, 0, "\0\0")
dosbox.mem_write(0x8000, 0x600, string.char(1, 0, 0, 0, 0x00, 0xFF, 0x00, 0xFA, 0x01, 0x00)) -- INIT: AX=1, log words FF00 FA00
dosbox.wait_frames(40)
for id = 0, 81 do
  local slot = id % 8
  dosbox.mem_write(0x8000, 0x600, string.char(1, 0, slot, 0, id, 0xFE, slot, 0xFB, id, 1)) -- flag, -, BL, -, log FE<id>, log FB<slot>, AX=0x01<id>
  dosbox.wait_frames(80)
end
dosbox.wait_frames(500)
local cntraw = dosbox.mem_read(0x7000, 0, 2)
local n = cntraw:byte(1) + 256 * cntraw:byte(2)
local pos, chunk = 2, {}
while pos < n do
  local len = math.min(400, n - pos)
  local raw = dosbox.mem_read(0x7000, pos, len)
  for i = 1, #raw, 2 do
    local lo, hi = raw:byte(i), raw:byte(i + 1)
    if lo == 255 and hi == 255 then chunk[#chunk + 1] = "T" else chunk[#chunk + 1] = string.format("%02X%02X", hi, lo) end
  end
  pos = pos + len
  if #chunk >= 100 then dosbox.log("TRACE " .. table.concat(chunk, " ")); chunk = {} end
end
if #chunk > 0 then dosbox.log("TRACE " .. table.concat(chunk, " ")) end
dosbox.log("DONE")
-- afterwards: grep -o 'TRACE [^"]*' <lua-debug log> | sed 's/^TRACE //' | tr '\n' ' ' ; cut the tokens after the last T; gzip -> chain.trace.gz
