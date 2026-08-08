// Entity_RunScript (1000:22da) equivalent -- the general 78-opcode entity-behavior bytecode VM
// documented in docs/entity-script-vm.md. This is a structural port of the VM LOOP itself (opcode
// dispatch, the CALL/RETURN subroutine mechanism, and the precise yield-vs-wait semantics that
// doc's "VM loop internals" section nails down byte-exact) plus real handlers for the subset of
// opcodes this port can act on today.
//
// NOT wired to real game content: the original's default-script tables (0xcd88 positive-state,
// 0xd996 negative-state) and the actual per-entity script bytecode they point at live in the data
// segment and haven't been dumped anywhere upstream -- docs/entity-script-vm.md's "full opcode
// table" section documents every opcode's ROLE (many cross-reference deep, not-yet-ported engine
// subsystems: palette fades, world/level warps, HUD text, boss-defeat tables, the sound driver),
// not their scripts' actual byte content. So there is no real script to run yet. This module is
// exercised against a small synthetic test script instead (see the parity/sanity check this was
// verified with) to prove the interpreter mechanics -- opcode advance, operand consumption,
// CALL/RETURN, yield-across-frames, wait-until-match, kill -- work correctly. Swap in real script
// data once 0xcd88/0xd996 are dumped; this loop shouldn't need to change.
//
// Opcodes implemented for real (see docs/entity-script-vm.md's opcode table for the source row):
//   0x01 SetAnimFrame, 0x02 WaitFrames, 0x03 RelativeJumpBack, 0x06 Kill, 0x0B Call, 0x0C Return,
//   0x0E Goto (offset within the SAME script buffer -- see note below), 0x11 WaitOrLoopBack,
//   0x1E WaitUnlessAiActive, 0x24 AddToPosition, 0x36 ResetScript, plus the 15 documented no-op
//   slots and the three terminator/yield special values. Everything else in the 78-entry table is
//   a documented no-op stub (consumes 0 operand bytes, logs once) -- not a guess at behavior, an
//   explicit "not ported yet, see docs/entity-script-vm.md opcode N" placeholder.
//
// One deliberate simplification: opcode 0x0E (EntityScriptOp_GotoStateScript) and opcodes 0x0B/
// 0x0C's "state-script" lookups are documented as indexing the real 0xcd88/0xd996 tables by state
// value. Without those tables, this port treats the operand as a direct byte OFFSET into the
// entity's own current script buffer instead -- enough to demonstrate a working jump/call
// mechanism, not a port of the real state-resolution indirection.

'use strict';

const OPCODE_STOP = -1 & 0xff; // 0xFF
const OPCODE_YIELD = -4 & 0xff; // 0xFC
const OPCODE_STOP_ALT = -0x52 & 0xff; // 0xAE

const NOOP_OPCODES = new Set([0, 4, 16, 18, 20, 23, 24, 27, 32, 41, 42, 44, 48, 56, 72]);

const warnedOnce = new Set();
function warnUnimplemented(opcode) {
  if (warnedOnce.has(opcode)) return;
  warnedOnce.add(opcode);
  console.warn(
    `EntityScriptVM: opcode ${opcode} (0x${opcode.toString(16)}) is a documented-but-unported ` +
      `stub -- see docs/entity-script-vm.md's opcode table. Treating as a 0-operand no-op.`
  );
}

/**
 * Runs one entity's script by one opcode this call (matching the original: Entity_RunScript is
 * called once per frame per scripted entity, executing opcodes until a yield/stop). `entity` needs
 * { script: Uint8Array, pc: number, callReturn: number|null, x, y, frame, dead, waitCounter }.
 * `globals` is { aiFrozen: boolean } (stands in for [0x8ba1]). Returns when the entity yields
 * (0xFC), stops (0xFF/0xAE), or the script runs out.
 */
export function runEntityScript(entity, globals) {
  if (!entity.script) return;
  let guard = 0;
  while (guard++ < 1000) {
    // guard: a runaway synthetic script shouldn't hang the frame
    const opcode = entity.script[entity.pc];
    if (opcode === undefined || opcode === OPCODE_STOP || opcode === OPCODE_STOP_ALT) return;
    if (opcode === OPCODE_YIELD) {
      entity.pc += 1;
      return;
    }

    const startPc = entity.pc;
    const result = execOpcode(opcode, entity, globals);
    if (result === 'wait') return; // parked on the same opcode, re-read next call (next frame)
    if (result === 'jump') continue; // handler already set entity.pc directly -- don't touch it
    entity.pc = startPc + 1 + result; // 1 opcode byte + however many operand bytes were consumed
  }
}

/**
 * Returns one of: a number (operand bytes consumed, pc advances normally past them), 'wait' (park
 * on this exact opcode, re-read next call), or 'jump' (handler already set entity.pc directly --
 * the caller must not recompute it from startPc).
 */
function execOpcode(opcode, entity, globals) {
  const op1 = () => entity.script[entity.pc + 1];
  const op2 = () => entity.script[entity.pc + 2];

  if (NOOP_OPCODES.has(opcode)) return 0;

  switch (opcode) {
    case 0x01: // SetAnimFrame
      entity.frame = op1();
      return 1;
    case 0x02: // WaitFrames -- fixed 1-operand-byte footprint regardless of outcome (docs)
      entity.waitCounter = (entity.waitCounter || 0) + 1;
      if (entity.waitCounter < op1()) return 'wait';
      entity.waitCounter = 0;
      return 1;
    case 0x03: // RelativeJumpBack
      entity.pc -= op1();
      return 'jump';
    case 0x06: // Kill
      entity.dead = true;
      return 'wait'; // abort -- matches the original returning out of the VM entirely
    case 0x0b: // Call: save return address, jump to operand as an offset in the same script
      entity.callReturn = entity.pc + 2;
      entity.pc = op1();
      return 'jump';
    case 0x0c: // Return: resume from the saved call site if any (continues running this frame);
      // else it's ResetScript's own fallback target (2665) -- a full reset that ABORTS the frame.
      if (entity.callReturn != null) {
        entity.pc = entity.callReturn;
        entity.callReturn = null;
        return 'jump';
      }
      entity.pc = 0;
      return 'wait';
    case 0x0e: // Goto (see module header: operand treated as a direct offset, not a state lookup)
      entity.pc = op1();
      return 'jump';
    case 0x11: { // WaitOrLoopBack: on mismatch, reads BOTH operand bytes and jumps back by the 2nd
      entity.waitCounter = (entity.waitCounter || 0) + 1;
      if (entity.waitCounter < op1()) {
        entity.pc -= op2();
        entity.waitCounter = 0;
        return 'jump';
      }
      entity.waitCounter = 0;
      return 2;
    }
    case 0x1e: // WaitUnlessAiActive
      if (globals.aiFrozen) return 'wait';
      return 0;
    case 0x24: // AddToPosition
      entity.x += signed8(op1());
      entity.y += signed8(op2());
      return 2;
    case 0x36: // ResetScript
      entity.pc = 0;
      entity.callReturn = null;
      return 'wait';
    default:
      warnUnimplemented(opcode);
      return 0;
  }
}

function signed8(v) {
  return v >= 0x80 ? v - 0x100 : v;
}

/** Builds a fresh per-entity script-runner state, matching Entity_RunScript's initial seed step. */
export function initScriptState(script) {
  return { script, pc: 0, callReturn: null, waitCounter: 0 };
}
