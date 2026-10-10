// Prints the dosbox-mcp `batch_execute` ops that instrument a RUNNING GAMEU.EXE (pockets.ini line 1 = "Adlib") so every
// command it sends to the sound driver and every OPL2 register the driver writes lands in a ring buffer in free DOS memory:
//   node tools/adlib-capture/make-patch.mjs > ops.json     (then: debug_pause, batch_execute ops, debug_continue, script_load drive.lua)
// Addresses (live, `[PROVEN]` with DOS memory map PSP 0x1E5): GAMEU code segment 0x1F5 (Ghidra 1000), driver (player.pin) segment
// 0x2AAC = 0x28B7 + 0x1F5 (read from [1F5:202B]), bank (adlib.pin) segment 0x259E. Free memory used: 7000:0000 = ring buffer (word
// count at offset 0, then 16-bit entries; 64 KB), 8000:xxxx = the stubs, 8000:0600 = request mailbox for drive.lua.
// Entries: 0xFFFF = driver tick, 0xFE<id> 0xFB<slot> = 1CCF play, 0xFD<id> = 1D4C stop, 0xFC<xx> = 1DAE stop all, 0xFF00 0xFA00 =
// init request, anything else = OPL2 write 0xRRVV.
// The game's own call sites are patched so that the log order is the order the driver saw: the play/stop calls run with interrupts
// off (cli/sti) so the timer ISR cannot slip a tick between the log entry and the command.
const H = (s) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));
const b64 = (a) => Buffer.from(a).toString('base64');
const PLAYER = 0x2aac, GAME = 0x1f5, STUB = 0x8000, BUF = 0x7000;
const pre = '9C FA 1E 53 BB 00 70 8E DB 8B 1E 00 00', post = '83 C3 02 89 1E 00 00 5B 1F 9D'; // pushf cli push ds,bx; ds=7000; bx=count ... store, count+=2; pop; popf
// A: player:22E3 (Opl2_WriteRegister, AH=reg AL=value): log AX, then redo the first instructions the 5-byte far jump replaced and resume at 22E9
const A = H(pre + ' 89 87 02 00 ' + post + ' 8B 16 66 14 86 E0 EA E9 22 AC 2A');
// B: player:0048 (`call 0206`, the tick command): log 0xFFFF, push the return address 00AC, jump to 0206
const B = H(pre + ' C7 87 02 00 FF FF ' + post + ' 68 AC 00 EA 06 02 AC 2A');
// B2: player:009E (the deferred tick after a command, [0C9D] set by a tick that found the driver busy): same marker, clears [0C9D], returns to 00A7
const B2 = H('9C FA 1E 53 BB 00 70 8E DB 8B 1E 00 00 C7 87 02 00 FF FF 83 C3 02 89 1E 00 00 5B 1F 9D B8 AC 2A 8E C0 26 C6 06 9D 0C 00 68 A7 00 EA 06 02 AC 2A');
// C2/D2/E2: GAMEU 1D3C / 1D9F / 1E18 (`call far [cs:2029]` in 1CCF / 1D4C / 1DAE): log, then cli; call far player:0000; sti; continue after the call
const logId = (hi) => `1E 06 50 53 57 52 BA 00 70 8E C2 26 8B 3E 00 00 26 88 85 02 00 26 C6 85 03 00 ${hi}`;
const logSlot = '26 88 9D 04 00 26 C6 85 05 00 FB 83 C7 04';
const tail = '26 89 3E 00 00 5A 5F 5B 58 07 1F';
const C2 = H(`FA ${logId('FE')} ${logSlot} ${tail} 9A 00 00 AC 2A FB EA 41 1D F5 01`);
const D2 = H(`FA ${logId('FD')} 83 C7 02 ${tail} 9A 00 00 AC 2A FB EA A4 1D F5 01`);
const E2 = H(`FA ${logId('FC')} 83 C7 02 ${tail} 9A 00 00 AC 2A FB EA 1D 1E F5 01`);
// F: GAMEU 20DA (the timer ISR's `mov ah,2; call far [cs:2029]`): if drive.lua left a request in the mailbox 8000:0600 (byte flag,
// byte BL at +2, log words at +4/+6, AX of the command at +8) and the driver is idle, send it (DX=bank segment, CX=0 for init), then tick.
const F = H(`1E 06 50 53 57 B8 00 80 8E D8 A0 00 06 0A C0 74 46
B8 AC 2A 8E C0 26 80 3E 9C 0C 00 75 39
C6 06 00 06 00 8A 1E 02 06 B8 00 70 8E C0 26 8B 3E 00 00 A1 04 06 26 89 85 02 00 A1 06 06 26 89 85 04 00 83 C7 04 26 89 3E 00 00 A1 08 06 BA 9E 25 B9 00 00 9A 00 00 AC 2A
5F 5B 58 07 1F B4 02 9A 00 00 AC 2A EA E1 20 F5 01`);
const far = (off, extra = []) => [0xea, off & 255, off >> 8, 0, 0x80, ...extra];
const w = (segment, offset, bytes) => ({ op: 'mem_write', segment, offset, data: b64(bytes) });
const ops = [w(BUF, 0, [0, 0, 0, 0])];
for (const [s, o] of [[A, 0], [B, 0x100], [C2, 0x200], [D2, 0x300], [E2, 0x400], [F, 0x500], [B2, 0x700]]) ops.push(w(STUB, o, s));
ops.push(w(STUB, 0x600, new Array(16).fill(0)));
ops.push(w(PLAYER, 0x22e3, far(0)), w(PLAYER, 0x48, far(0x100)), w(PLAYER, 0x9e, far(0x700)));
ops.push(w(GAME, 0x1d3c, far(0x200)), w(GAME, 0x1d9f, far(0x300)), w(GAME, 0x1e18, far(0x400)), w(GAME, 0x20da, far(0x500, [0x90, 0x90])));
console.log(JSON.stringify(ops));
