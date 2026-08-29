/**
 * Issue #196 — the interrupt byte is a per-harness fact, not a constant.
 *
 * `afx send --interrupt` used to write `\x03` unconditionally. claude and codex read
 * Ctrl+C as "end this turn"; **opencode reads it as "quit"**. Verified in the Tower log
 * 2026-08-29: a Ctrl+C to an opencode builder took the shellper down 30s later, and
 * opencode has no conversation resume, so the replacement woke with no memory of its work.
 *
 * These tests pin the TABLE and the derivation. The byte-level assertions on the live
 * `/api/send` interrupt path (Ctrl+C for a ctrl-c harness, never Ctrl+C for an esc one)
 * live in tower-routes.test.ts, where the route's mocks already are.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_HARNESSES,
  INTERRUPT_BYTES,
  buildCustomHarnessProvider,
  getBuiltinHarness,
  interruptByteForHarness,
  interruptSignalForHarness,
  validateCustomHarnessConfig,
  type CustomHarnessConfig,
  type InterruptSignal,
} from '../utils/harness.js';
import { hasGateProfile } from '../servers/gate-profiles.js';
import { heldRecoveryAction, heldRecoveryKeystroke } from '../servers/mailbox-hold-policy.js';
import { writeHeldRecovery, interruptSignalForSession } from '../servers/mailbox-wiring.js';
import type { DeliverySession } from '../servers/mailbox-delivery.js';

const CTRL_C = '\x03';
const ESC = '\x1b';

const SIGNALS: InterruptSignal[] = ['esc', 'ctrl-c'];

/** The two bytes are distinct — every assertion below is meaningless otherwise. */
describe('INTERRUPT_BYTES', () => {
  it('spells the two control bytes, and they differ', () => {
    expect(INTERRUPT_BYTES['ctrl-c']).toBe(CTRL_C);
    expect(INTERRUPT_BYTES.esc).toBe(ESC);
    expect(INTERRUPT_BYTES.esc).not.toBe(INTERRUPT_BYTES['ctrl-c']);
  });
});

// ============================================================================
// Test 3 (the one that matters): the mapping covers every harness in the registry.
// A new harness must not default into `ctrl-c` by omission — that is exactly how
// this bug would come back.
// ============================================================================

describe('every registered harness declares an interrupt signal', () => {
  it('covers every entry in BUILTIN_HARNESSES', () => {
    const names = Object.keys(BUILTIN_HARNESSES);
    expect(names.length).toBeGreaterThan(0);

    const missing = names.filter(
      (name) => !SIGNALS.includes(BUILTIN_HARNESSES[name].interruptSignal),
    );
    expect(missing, `harnesses with no recorded interruptSignal: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('covers every harness the render gate can classify', () => {
    // A gate-profiled harness is one `afx send` can address, so it is one an interrupt
    // can reach. Resolving through `getBuiltinHarness` rather than
    // `interruptSignalForHarness` is deliberate: the latter FAILS SAFE to 'esc' for an
    // unknown name, which would make a missing entry look present.
    const classifiable = Object.keys(BUILTIN_HARNESSES).filter((name) => hasGateProfile(name));
    expect(classifiable.length).toBeGreaterThan(0);

    const missing = classifiable.filter((name) => {
      const provider = getBuiltinHarness(name);
      return !provider || !SIGNALS.includes(provider.interruptSignal);
    });
    expect(missing, `gate-profiled harnesses with no recorded interruptSignal: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('records opencode as esc and claude/codex as ctrl-c', () => {
    expect(BUILTIN_HARNESSES.opencode.interruptSignal).toBe('esc');
    expect(BUILTIN_HARNESSES.claude.interruptSignal).toBe('ctrl-c');
    expect(BUILTIN_HARNESSES.codex.interruptSignal).toBe('ctrl-c');
  });
});

// ============================================================================
// Resolution by name — and the fail-safe direction
// ============================================================================

describe('interruptSignalForHarness', () => {
  it('resolves each built-in harness from the table', () => {
    expect(interruptSignalForHarness('claude')).toBe('ctrl-c');
    expect(interruptSignalForHarness('codex')).toBe('ctrl-c');
    expect(interruptSignalForHarness('opencode')).toBe('esc');
  });

  it('fails safe to esc for an unknown, retired or absent name', () => {
    // NOT 'ctrl-c': `resolveHarness` defaults an unidentified command to CLAUDE_HARNESS,
    // and inheriting that default here is what would hand an unidentified opencode
    // terminal the byte that kills it.
    expect(interruptSignalForHarness(undefined)).toBe('esc');
    expect(interruptSignalForHarness(null)).toBe('esc');
    expect(interruptSignalForHarness('')).toBe('esc');
    expect(interruptSignalForHarness('gemini')).toBe('esc'); // retired
    expect(interruptSignalForHarness('some-new-tui')).toBe('esc');
  });

  it('never reads an inherited Object member as a provider', () => {
    expect(interruptSignalForHarness('constructor')).toBe('esc');
    expect(interruptSignalForHarness('toString')).toBe('esc');
  });

  it('honours a custom harness that declares one, and defaults the rest to esc', () => {
    const customs: Record<string, CustomHarnessConfig> = {
      'pauses-on-ctrl-c': { roleArgs: [], roleScriptFragment: '', interruptSignal: 'ctrl-c' },
      undeclared: { roleArgs: [], roleScriptFragment: '' },
    };
    expect(interruptSignalForHarness('pauses-on-ctrl-c', customs)).toBe('ctrl-c');
    expect(interruptSignalForHarness('undeclared', customs)).toBe('esc');
  });
});

describe('interruptByteForHarness', () => {
  it('yields Ctrl+C for a ctrl-c harness and ESC for an esc harness', () => {
    expect(interruptByteForHarness('claude')).toBe(CTRL_C);
    expect(interruptByteForHarness('codex')).toBe(CTRL_C);
    expect(interruptByteForHarness('opencode')).toBe(ESC);
  });

  it('never yields Ctrl+C for anything it cannot identify', () => {
    for (const name of [undefined, null, '', 'gemini', 'agy', 'a-tui-shipped-tomorrow']) {
      expect(interruptByteForHarness(name)).not.toBe(CTRL_C);
    }
  });
});

// ============================================================================
// Custom harness config
// ============================================================================

describe('custom harness interruptSignal', () => {
  it('defaults an undeclared custom provider to esc', () => {
    const provider = buildCustomHarnessProvider({ roleArgs: [], roleScriptFragment: '' });
    expect(provider.interruptSignal).toBe('esc');
  });

  it('carries a declared signal onto the provider', () => {
    const provider = buildCustomHarnessProvider({
      roleArgs: [], roleScriptFragment: '', interruptSignal: 'ctrl-c',
    });
    expect(provider.interruptSignal).toBe('ctrl-c');
  });

  it('accepts a valid signal and rejects anything else', () => {
    const base = { roleArgs: [], roleScriptFragment: '' };
    expect(validateCustomHarnessConfig('ok', { ...base, interruptSignal: 'esc' }))
      .toMatchObject({ interruptSignal: 'esc' });
    expect(validateCustomHarnessConfig('ok', { ...base, interruptSignal: 'ctrl-c' }))
      .toMatchObject({ interruptSignal: 'ctrl-c' });
    expect(validateCustomHarnessConfig('ok', base)).toMatchObject(base);

    expect(() => validateCustomHarnessConfig('bad', { ...base, interruptSignal: 'sigkill' }))
      .toThrow(/interruptSignal/);
    expect(() => validateCustomHarnessConfig('bad', { ...base, interruptSignal: 3 }))
      .toThrow(/interruptSignal/);
  });
});

// ============================================================================
// The third write site: the AUTOMATIC stuck-screen recovery (#92), which fires
// with no operator in the loop.
// ============================================================================

describe('heldRecoveryKeystroke (policy)', () => {
  it('clears an abandoned draft with Ctrl+C on a ctrl-c harness', () => {
    expect(heldRecoveryKeystroke('cancel-draft', 'ctrl-c')).toBe(CTRL_C);
  });

  it('never returns Ctrl+C for an esc harness, even to clear a draft', () => {
    // The draft may survive and the row stays held for a human. That is the correct
    // trade against quitting the agent and losing the conversation behind it.
    expect(heldRecoveryKeystroke('cancel-draft', 'esc')).toBe(ESC);
  });

  it('escapes an unreadable screen with ESC on every harness', () => {
    for (const signal of SIGNALS) {
      expect(heldRecoveryKeystroke('escape-screen', signal)).toBe(ESC);
    }
  });
});

// ============================================================================
// The AUTOMATIC path, asserted on the BYTES WRITTEN.
//
// `heldRecoveryAction('user-text') === 'cancel-draft'` still fires with no human in
// the loop, so this is the byte Tower puts on a PTY by itself. air-197 established
// that opencode's holds are a real rows-geometry clipping problem, so `user-text`
// holds on opencode are reachable — this path is not theoretical.
// ============================================================================

describe('automatic stuck-hold recovery never writes Ctrl+C to an esc harness', () => {
  /** A DeliverySession that records every byte written to it. */
  function recordingSession(command: string) {
    const written: string[] = [];
    const session: DeliverySession = {
      bytesWritten: 0,
      info: { cols: 80, rows: 24 },
      command,
      launchArgs: [],
      // No `.builder-start.sh` to find, so identity comes from `command` alone and the
      // test touches no filesystem.
      cwd: '/nonexistent-worktree-for-bugfix-196',
      writable: true,
      write(data: string) { written.push(data); return true; },
    };
    return { session, written };
  }

  it('still writes Ctrl+C to clear a draft on claude', () => {
    const { session, written } = recordingSession('claude');
    expect(writeHeldRecovery(session, heldRecoveryAction('user-text')!)).toBe(CTRL_C);
    expect(written).toEqual([CTRL_C]);
  });

  it('writes ESC, never Ctrl+C, to clear a draft on opencode', () => {
    const { session, written } = recordingSession('opencode');
    expect(writeHeldRecovery(session, heldRecoveryAction('user-text')!)).toBe(ESC);
    expect(written).toEqual([ESC]);
    expect(written).not.toContain(CTRL_C);
  });

  it('writes ESC, never Ctrl+C, to a session whose agent cannot be identified', () => {
    const { session, written } = recordingSession('/usr/local/bin/some-new-tui');
    expect(written).toEqual([]);
    writeHeldRecovery(session, 'cancel-draft');
    expect(written).not.toContain(CTRL_C);
    expect(written).toEqual([ESC]);
  });

  it('writes ESC for escape-screen on every harness', () => {
    for (const command of ['claude', 'codex', 'opencode', 'unknown-tui']) {
      const { session, written } = recordingSession(command);
      writeHeldRecovery(session, 'escape-screen');
      expect(written).toEqual([ESC]);
    }
  });

  it('reports a rejected write as null and puts nothing on the wire', () => {
    const session: DeliverySession = {
      bytesWritten: 0,
      info: { cols: 80, rows: 24 },
      command: 'claude',
      launchArgs: [],
      cwd: '/nonexistent-worktree-for-bugfix-196',
      writable: false,
      write: () => false,
    };
    expect(writeHeldRecovery(session, 'cancel-draft')).toBeNull();
  });
});

// ============================================================================
// Session-level resolution, the seam both interrupt callers share.
// ============================================================================

describe('interruptSignalForSession', () => {
  function sessionRunning(command: string): DeliverySession {
    return {
      bytesWritten: 0,
      info: { cols: 80, rows: 24 },
      command,
      launchArgs: [],
      cwd: '/nonexistent-worktree-for-bugfix-196',
      writable: true,
      write: () => true,
    };
  }

  it('identifies the agent from the launch command, full path included', () => {
    expect(interruptSignalForSession(sessionRunning('claude'))).toBe('ctrl-c');
    expect(interruptSignalForSession(sessionRunning('/opt/homebrew/bin/codex --foo'))).toBe('ctrl-c');
    expect(interruptSignalForSession(sessionRunning('/usr/local/bin/opencode --prompt x'))).toBe('esc');
  });

  it('fails safe to esc when the command names no known agent', () => {
    expect(interruptSignalForSession(sessionRunning(''))).toBe('esc');
    expect(interruptSignalForSession(sessionRunning('bash'))).toBe('esc');
    expect(interruptSignalForSession(sessionRunning('agy'))).toBe('esc');
  });
});
