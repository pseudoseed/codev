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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { enqueue } from '../db/mailbox.js';
import {
  BUILTIN_HARNESSES,
  CLEAR_DRAFT_BYTES,
  INTERRUPT_BYTES,
  buildCustomHarnessProvider,
  getBuiltinHarness,
  clearDraftKeyForHarness,
  interruptByteForHarness,
  interruptSignalForHarness,
  validateCustomHarnessConfig,
  type CustomHarnessConfig,
  type ClearDraftKey,
  type InterruptSignal,
} from '../utils/harness.js';
import { hasGateProfile } from '../servers/gate-profiles.js';
import { heldRecoveryAction, heldRecoveryKeystroke } from '../servers/mailbox-hold-policy.js';
import {
  writeHeldRecovery,
  interruptSignalForSession,
  clearDraftKeyForSession,
} from '../servers/mailbox-wiring.js';
import {
  MailboxDrainer,
  type DeliveryPorts,
  type DeliverySession,
  type HeldRecoveryInfo,
  type HeldRecoveryResult,
} from '../servers/mailbox-delivery.js';
import type { GateVerdict } from '../servers/render-gate.js';

const CTRL_C = '\x03';
const ESC = '\x1b';
const CTRL_U = '\x15';

const SIGNALS: InterruptSignal[] = ['esc', 'ctrl-c'];
const CLEAR_KEYS: ClearDraftKey[] = ['ctrl-c', 'ctrl-u', 'none'];

/** The two bytes are distinct — every assertion below is meaningless otherwise. */
describe('INTERRUPT_BYTES', () => {
  it('spells the two control bytes, and they differ', () => {
    expect(INTERRUPT_BYTES['ctrl-c']).toBe(CTRL_C);
    expect(INTERRUPT_BYTES.esc).toBe(ESC);
    expect(INTERRUPT_BYTES.esc).not.toBe(INTERRUPT_BYTES['ctrl-c']);
    expect(CLEAR_DRAFT_BYTES['ctrl-c']).toBe(CTRL_C);
    expect(CLEAR_DRAFT_BYTES['ctrl-u']).toBe(CTRL_U);
    // Ctrl+U must not collide with anything that ends a turn or quits an app.
    expect(CTRL_U).not.toBe(CTRL_C);
    expect(CTRL_U).not.toBe(ESC);
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

  it('covers every entry in BUILTIN_HARNESSES for the draft-clear key too', () => {
    // The second per-harness fact, guarded the same way: the #92 auto-recovery writes
    // THIS byte with no operator in the loop, so an omission must be caught here.
    const names = Object.keys(BUILTIN_HARNESSES);
    const missing = names.filter(
      (name) => !CLEAR_KEYS.includes(BUILTIN_HARNESSES[name].clearDraftKey),
    );
    expect(missing, `harnesses with no recorded clearDraftKey: ${missing.join(', ')}`)
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

  it('records opencode\'s draft clear as ctrl-u, claude/codex as ctrl-c', () => {
    // From opencode 1.18.18's shipped default keybind table: `input_clear` is ctrl+c,
    // but so is `app_exit` — the overlap that quits it. `input_delete_to_line_start`
    // is ctrl+u, the only binding for that byte in the whole table.
    expect(BUILTIN_HARNESSES.opencode.clearDraftKey).toBe('ctrl-u');
    expect(BUILTIN_HARNESSES.claude.clearDraftKey).toBe('ctrl-c');
    expect(BUILTIN_HARNESSES.codex.clearDraftKey).toBe('ctrl-c');
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

describe('clearDraftKeyForHarness', () => {
  it('resolves each built-in harness from the table', () => {
    expect(clearDraftKeyForHarness('claude')).toBe('ctrl-c');
    expect(clearDraftKeyForHarness('codex')).toBe('ctrl-c');
    expect(clearDraftKeyForHarness('opencode')).toBe('ctrl-u');
  });

  it('fails safe to none for an unknown, retired or absent name', () => {
    // 'none' means the recovery writes NOTHING and reports the hold as unrecoverable.
    // Guessing a control byte at an unidentified TUI is how this bug was written.
    for (const name of [undefined, null, '', 'gemini', 'agy', 'a-tui-shipped-tomorrow']) {
      expect(clearDraftKeyForHarness(name)).toBe('none');
    }
  });

  it('honours a custom harness that declares one, and defaults the rest to none', () => {
    const customs: Record<string, CustomHarnessConfig> = {
      declared: { roleArgs: [], roleScriptFragment: '', clearDraftKey: 'ctrl-u' },
      undeclared: { roleArgs: [], roleScriptFragment: '' },
    };
    expect(clearDraftKeyForHarness('declared', customs)).toBe('ctrl-u');
    expect(clearDraftKeyForHarness('undeclared', customs)).toBe('none');
  });
});

// ============================================================================
// Custom harness config
// ============================================================================

describe('custom harness interruptSignal', () => {
  it('defaults an undeclared custom provider to esc', () => {
    const provider = buildCustomHarnessProvider({ roleArgs: [], roleScriptFragment: '' });
    expect(provider.interruptSignal).toBe('esc');
    expect(provider.clearDraftKey).toBe('none');
  });

  it('carries a declared signal onto the provider', () => {
    const provider = buildCustomHarnessProvider({
      roleArgs: [], roleScriptFragment: '', interruptSignal: 'ctrl-c', clearDraftKey: 'ctrl-u',
    });
    expect(provider.interruptSignal).toBe('ctrl-c');
    expect(provider.clearDraftKey).toBe('ctrl-u');
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

    expect(validateCustomHarnessConfig('ok', { ...base, clearDraftKey: 'ctrl-u' }))
      .toMatchObject({ clearDraftKey: 'ctrl-u' });
    expect(() => validateCustomHarnessConfig('bad', { ...base, clearDraftKey: 'ctrl-z' }))
      .toThrow(/clearDraftKey/);
  });
});

// ============================================================================
// The third write site: the AUTOMATIC stuck-screen recovery (#92), which fires
// with no operator in the loop.
// ============================================================================

describe('heldRecoveryKeystroke (policy)', () => {
  it('clears an abandoned draft with Ctrl+C where Ctrl+C is the clear key', () => {
    expect(heldRecoveryKeystroke('cancel-draft', 'ctrl-c')).toBe(CTRL_C);
  });

  it('clears with Ctrl+U where that is the clear key, never Ctrl+C', () => {
    const key = heldRecoveryKeystroke('cancel-draft', 'ctrl-u');
    expect(key).toBe(CTRL_U);
    expect(key).not.toBe(CTRL_C);
  });

  it('returns null — not a guessed byte — when no clear key is recorded', () => {
    // The distinction the whole change turns on: "cannot succeed" is spelled `null`,
    // and the caller reports it, rather than writing something that looks like a try.
    expect(heldRecoveryKeystroke('cancel-draft', 'none')).toBeNull();
  });

  it('escapes an unreadable screen with ESC whatever the clear key is', () => {
    for (const key of CLEAR_KEYS) {
      expect(heldRecoveryKeystroke('escape-screen', key)).toBe(ESC);
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
  function recordingSession(command: string, writable = true) {
    const written: string[] = [];
    const session: DeliverySession = {
      bytesWritten: 0,
      info: { cols: 80, rows: 24 },
      command,
      launchArgs: [],
      // No `.builder-start.sh` to find, so identity comes from `command` alone and the
      // test touches no filesystem.
      cwd: '/nonexistent-worktree-for-bugfix-196',
      writable,
      write(data: string) { written.push(data); return writable; },
    };
    return { session, written };
  }

  it('still writes Ctrl+C to clear a draft on claude', () => {
    const { session, written } = recordingSession('claude');
    expect(writeHeldRecovery(session, heldRecoveryAction('user-text')!)).toBe(CTRL_C);
    expect(written).toEqual([CTRL_C]);
  });

  it('writes Ctrl+U, never Ctrl+C, to clear a draft on opencode', () => {
    const { session, written } = recordingSession('opencode');
    expect(writeHeldRecovery(session, heldRecoveryAction('user-text')!)).toBe(CTRL_U);
    expect(written).toEqual([CTRL_U]);
    expect(written).not.toContain(CTRL_C);
  });

  it('writes NOTHING at all when the agent cannot be identified', () => {
    // Not a fallback byte, not ESC: an unidentified TUI gets no keystroke, and the
    // caller reports the hold as unrecoverable.
    const { session, written } = recordingSession('/usr/local/bin/some-new-tui');
    expect(writeHeldRecovery(session, 'cancel-draft')).toBeNull();
    expect(written).toEqual([]);
  });

  it('writes ESC for escape-screen on every harness', () => {
    for (const command of ['claude', 'codex', 'opencode', 'unknown-tui']) {
      const { session, written } = recordingSession(command);
      expect(writeHeldRecovery(session, 'escape-screen')).toBe(ESC);
      expect(written).toEqual([ESC]);
      expect(written).not.toContain(CTRL_C);
    }
  });

  it('reports a rejected write as null', () => {
    const { session } = recordingSession('claude', false);
    expect(writeHeldRecovery(session, 'cancel-draft')).toBeNull();
  });

  it('no harness resolves to a recovery that could quit opencode', () => {
    // The blanket guard: across every command an opencode terminal can present as,
    // no recovery action ever produces \x03.
    for (const command of ['opencode', '/opt/homebrew/bin/opencode', 'opencode --prompt x']) {
      expect(clearDraftKeyForSession(recordingSession(command).session)).toBe('ctrl-u');
      for (const action of ['cancel-draft', 'escape-screen'] as const) {
        const { session, written } = recordingSession(command);
        writeHeldRecovery(session, action);
        expect(written).not.toContain(CTRL_C);
      }
    }
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

// ============================================================================
// Residual 1 bookkeeping (Issue #196).
//
// opencode's clear key is `ctrl+u` = `input_delete_to_line_start`, so it clears the
// LAST LINE of a draft. A multi-row draft is not cleared, and a second press on an
// already-empty line emits no output at all — the keystroke is accepted and does
// nothing. That is `attempted-and-did-not-work`, and it is NOT the same fact as
// `never-attempted` or as `no-safe-byte-exists`. Nothing acts on it yet; these tests
// exist so it is recorded rather than collapsed, because the fix for the silent
// `user-text` starvation has to branch on exactly this distinction.
// ============================================================================

describe('recovery phase records WHICH state a stuck screen is in', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const WS = '/ws/a';
  const AGENT = 'bugfix-196';

  /**
   * A drainer wired to a permanently `user-text` screen, with `recoverHeld` returning
   * `outcome` and optionally emitting output (advancing the change token) as a real
   * keystroke would.
   */
  function harness(result: HeldRecoveryResult, emitsOutput: boolean) {
    let now = 1_000;
    let bytesWritten = 0;
    const calls: HeldRecoveryInfo[] = [];
    const logs: string[] = [];
    const verdict: GateVerdict = { clean: false, reason: 'busy', detail: 'user-text' };
    const session: DeliverySession = {
      get bytesWritten() { return bytesWritten; },
      info: { cols: 80, rows: 24 },
      command: 'opencode',
      launchArgs: [],
      cwd: '/ws/a',
      writable: true,
      write: () => true,
    };
    const ports: DeliveryPorts = {
      getSessionForAgent: () => session,
      resolveProfile: () => ({ app: 'opencode', markerPattern: /^>/, regionEndPatterns: [] }),
      classify: async () => verdict,
      writeMessage: () => true,
      broadcast: () => undefined,
      onHeldStateChange: () => undefined,
      onEscalation: () => undefined,
      onLiveness: () => undefined,
      recoverHeld: (info) => {
        calls.push(info);
        if (emitsOutput) bytesWritten++;
        return result;
      },
      log: (message) => { logs.push(message); },
      now: () => now,
    };
    enqueue(db, {
      workspacePath: WS, toAgent: AGENT, body: 'go', formattedMessage: '[architect] go',
    }, now);
    const drainer = new MailboxDrainer({
      intervalMs: 999_999, escalationMs: 999_999, recoveryMs: 10_000,
    });
    drainer.start(ports, db);
    return { drainer, calls, logs, advance: (ms: number) => { now += ms; } };
  }

  it('starts at not-attempted and fires once the window elapses', async () => {
    const { drainer, calls, advance } = harness({ outcome: 'written', keystroke: 'Ctrl+U' }, true);
    await drainer.tick();
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('not-attempted');
    expect(calls).toHaveLength(0);

    advance(10_000);
    await drainer.tick();
    expect(calls).toHaveLength(1);
    drainer.stop();
  });

  it('records written-inert when the keystroke produced no output at all', async () => {
    // The opencode multi-row-draft case: ctrl+u went out, the screen did not move.
    const { drainer, calls, logs, advance } = harness({ outcome: 'written', keystroke: 'Ctrl+U' }, false);
    await drainer.tick();
    advance(10_000);
    await drainer.tick();
    expect(calls).toHaveLength(1);
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('written');

    advance(10_000);
    await drainer.tick();
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('written-inert');
    expect(calls).toHaveLength(1); // latched: never retried, and never will be

    // Until #198 lands this log line is the ONLY signal an operator gets — the liveness
    // alarm deliberately excludes `user-text`. It names the agent, the detail and the byte.
    const inert = logs.filter((l) => l.includes('RECOVERY INERT'));
    expect(inert).toHaveLength(1);
    expect(inert[0]).toContain(AGENT);
    expect(inert[0]).toContain('user-text');
    expect(inert[0]).toContain('Ctrl+U');
    drainer.stop();
  });

  it('does not record written-inert when the screen actually moved', async () => {
    // Output resets the whole state, so the phase returns to not-attempted rather than
    // being mislabelled inert. `written-inert` must mean exactly one thing.
    const { drainer, logs, advance } = harness({ outcome: 'written', keystroke: 'Ctrl+U' }, true);
    await drainer.tick();
    advance(10_000);
    await drainer.tick();
    advance(10_000);
    await drainer.tick();
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('not-attempted');
    expect(logs.filter((l) => l.includes('RECOVERY INERT'))).toHaveLength(0);
    drainer.stop();
  });

  it('records unrecoverable distinctly, and never writes or retries', async () => {
    const { drainer, calls, logs, advance } = harness({ outcome: 'unrecoverable' }, false);
    await drainer.tick();
    advance(10_000);
    await drainer.tick();
    expect(calls).toHaveLength(1);
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('unrecoverable');

    advance(10_000);
    await drainer.tick();
    // Latched, and NOT relabelled written-inert: nothing was ever written, so
    // "the screen did not change" is not a finding about this state.
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('unrecoverable');
    expect(calls).toHaveLength(1);
    // Nothing was written, so "it produced no output" is not a finding about this state.
    expect(logs.filter((l) => l.includes('RECOVERY INERT'))).toHaveLength(0);
    drainer.stop();
  });

  it('keeps a failed write retryable rather than latching it', async () => {
    const { drainer, calls, advance } = harness({ outcome: 'failed' }, false);
    await drainer.tick();
    advance(10_000);
    await drainer.tick();
    expect(calls).toHaveLength(1);
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('not-attempted');

    advance(10_000);
    await drainer.tick();
    expect(calls).toHaveLength(2); // a torn-down PTY is transient, not unrecoverable
    drainer.stop();
  });
});
