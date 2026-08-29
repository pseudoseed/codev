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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { writeControlSequence, ESCAPE_ENTER_DELAY_MS } from '../servers/message-write.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { enqueue } from '../db/mailbox.js';
import {
  BUILTIN_HARNESSES,
  CLEAR_DRAFT_BYTES,
  INTERRUPT_BYTES,
  buildCustomHarnessProvider,
  getBuiltinHarness,
  clearDraftKeyForHarness,
  describeInterruptBytes,
  isShellCommand,
  keyName,
  interruptSignalForHarness,
  validateCustomHarnessConfig,
  type ClearDraftKey,
  type InterruptSignal,
} from '../utils/harness.js';
import { hasGateProfile } from '../servers/gate-profiles.js';
import { heldRecoveryAction, heldRecoveryKeystroke } from '../servers/mailbox-hold-policy.js';
import {
  writeHeldRecovery,
  clearDraftKeyForSession,
  promptReadySequence,
  heldRemedy,
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

  it('the two tables agree on ctrl-c — the coupling promptReadySequence dedups on', () => {
    // CMAP round 1, finding 5. `promptReadySequence`'s dedup is a STRING COMPARE, so
    // claude and codex get one write only while these two stay equal. They are derived
    // rather than independently spelled, and this pins the property by identity so the
    // dependency is named rather than implied.
    expect(CLEAR_DRAFT_BYTES['ctrl-c']).toBe(INTERRUPT_BYTES['ctrl-c']);
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

  it('resolves built-ins ONLY — a custom name is esc, not a configurable value', () => {
    // No `customHarnesses` parameter by design: nothing on the interrupt path can resolve
    // a custom harness, so accepting one would be an inert parameter dressed as support.
    expect(interruptSignalForHarness('my-custom-agent')).toBe('esc');
  });
});

describe('the interrupt byte a harness name resolves to', () => {
  const byteFor = (name: string | undefined | null) =>
    INTERRUPT_BYTES[interruptSignalForHarness(name)];

  it('is Ctrl+C for a ctrl-c harness and ESC for an esc harness', () => {
    expect(byteFor('claude')).toBe(CTRL_C);
    expect(byteFor('codex')).toBe(CTRL_C);
    expect(byteFor('opencode')).toBe(ESC);
  });

  it('is never Ctrl+C for anything it cannot identify', () => {
    for (const name of [undefined, null, '', 'gemini', 'agy', 'a-tui-shipped-tomorrow']) {
      expect(byteFor(name)).not.toBe(CTRL_C);
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

  it('resolves built-ins ONLY — a custom name is none, not a configurable value', () => {
    expect(clearDraftKeyForHarness('my-custom-agent')).toBe('none');
  });
});

// ============================================================================
// Custom harness config
// ============================================================================

describe('custom harnesses stay out of the interrupt table', () => {
  it('builds a provider with the fail-safe constants, not configurable ones', () => {
    // CMAP round 1, finding 2: making these configurable would ship a validated,
    // documented field that no write path can reach — `assertHarnessAcceptsModel`'s own
    // docblock in this file warns against exactly that. They are constants until the
    // resolvers actually thread `customHarnesses` through.
    const provider = buildCustomHarnessProvider({ roleArgs: [], roleScriptFragment: '' });
    expect(provider.interruptSignal).toBe('esc');
    expect(provider.clearDraftKey).toBe('none');
  });

  it('ignores the config fields rather than validating them into inertness', () => {
    // A config carrying them still validates (unknown keys are ignored) but the values
    // are NOT honoured — asserted so nobody re-adds validation without wiring.
    const config = validateCustomHarnessConfig('x', {
      roleArgs: [], roleScriptFragment: '', interruptSignal: 'ctrl-c', clearDraftKey: 'ctrl-c',
    });
    const provider = buildCustomHarnessProvider(config);
    expect(provider.interruptSignal).toBe('esc');
    expect(provider.clearDraftKey).toBe('none');
  });

  it('a custom harness name resolves to the fail-safe pair', () => {
    expect(interruptSignalForHarness('my-custom-agent')).toBe('esc');
    expect(clearDraftKeyForHarness('my-custom-agent')).toBe('none');
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

describe('session identification (the seam every interrupt caller shares)', () => {
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

  it('identifies the agent from the launch command, full path and args included', () => {
    expect(promptReadySequence(sessionRunning('claude'))).toEqual([CTRL_C]);
    expect(promptReadySequence(sessionRunning('/opt/homebrew/bin/codex --foo'))).toEqual([CTRL_C]);
    expect(promptReadySequence(sessionRunning('/usr/local/bin/opencode --prompt x')))
      .toEqual([ESC, CTRL_U]);
  });

  it('fails safe when the command names neither a known agent nor a shell', () => {
    // `bash` is deliberately NOT in this list any more: a shell is a known target with a
    // known interrupt, and treating it as unknown is what made `--interrupt` a no-op on
    // shells (CMAP round 1, finding 1). `agy` has a gate profile but no harness entry, so
    // it stays in the fail-safe bucket.
    for (const command of ['', 'agy', 'some-new-tui']) {
      expect(promptReadySequence(sessionRunning(command))).toEqual([ESC]);
      expect(clearDraftKeyForSession(sessionRunning(command))).toBe('none');
    }
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
  function harness(result: HeldRecoveryResult | boolean, emitsOutput: boolean) {
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

  it('coerces a LEGACY boolean port: true latches as written', async () => {
    // recoverHeld's return widened from boolean to an outcome. A port still returning a
    // bare boolean must not be misread — `true` meant "the byte reached a live PTY".
    const { drainer, calls, advance } = harness(true, true);
    await drainer.tick();
    advance(10_000);
    await drainer.tick();
    expect(calls).toHaveLength(1);
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('written');
    drainer.stop();
  });

  it('coerces a LEGACY boolean port: false stays RETRYABLE, never latched', async () => {
    // The subtle direction. `false` meant "the write did not land" — transient. Coercing it
    // into a latching phase would turn a torn-down PTY into a permanent give-up, which is
    // exactly the retryable-vs-latched distinction the four phases exist to preserve.
    const { drainer, calls, advance } = harness(false, false);
    await drainer.tick();
    advance(10_000);
    await drainer.tick();
    expect(calls).toHaveLength(1);
    expect(drainer.recoveryPhaseFor(WS, AGENT)).toBe('not-attempted');

    advance(10_000);
    await drainer.tick();
    expect(calls).toHaveLength(2); // retried: `false` is not a verdict about the future
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

// ============================================================================
// `afx send --interrupt` — what its contract actually is (Issue #196).
//
// Established from source, because the whole bug came from one byte serving two
// intents and guessing again would repeat it:
//   Spec 0020 introduced --interrupt as "send Ctrl+C first to ensure prompt is ready",
//     mitigating the "Vim trap" — a RUNNING process to escape.
//   Spec 1273 gave "end the turn" its own command (afx interrupt, ESC) and recorded
//     --interrupt as "a different signal", explicitly NOT the mid-turn unwedge.
//   Issue #21 adopted it as the remedy for an abandoned composer, because Ctrl+C
//     clears typed text where ESC does not.
//
// So it owns BOTH halves. On claude/codex one byte is both; on opencode they are two.
// Routing it to the interrupt alone would make it safe and useless for the job #21
// documents — the operator could not clear an opencode composer while Tower's own
// auto-recovery could, which is backwards.
// ============================================================================

describe('promptReadySequence', () => {
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

  it('is a single Ctrl+C on claude and codex — unchanged from before the fix', () => {
    expect(promptReadySequence(sessionRunning('claude'))).toEqual([CTRL_C]);
    expect(promptReadySequence(sessionRunning('codex'))).toEqual([CTRL_C]);
  });

  it('is ESC then Ctrl+U on opencode, in that order', () => {
    // ESC first so any running turn ends, then Ctrl+U to clear what is in the composer —
    // the same two effects claude gets from one Ctrl+C.
    expect(promptReadySequence(sessionRunning('opencode'))).toEqual([ESC, CTRL_U]);
  });

  it('is the interrupt alone when no clear key is recorded', () => {
    // No guessed byte at an unidentified TUI.
    expect(promptReadySequence(sessionRunning('some-new-tui'))).toEqual([ESC]);
    expect(promptReadySequence(sessionRunning(''))).toEqual([ESC]);
  });

  it('never contains Ctrl+C for a harness that quits on it', () => {
    for (const command of ['opencode', '/opt/homebrew/bin/opencode', 'some-new-tui', '']) {
      expect(promptReadySequence(sessionRunning(command))).not.toContain(CTRL_C);
    }
  });
});

describe('keystroke naming', () => {
  it('names the bytes an operator reasons in', () => {
    expect(keyName(CTRL_C)).toBe('Ctrl+C');
    expect(keyName(CTRL_U)).toBe('Ctrl+U');
    expect(keyName(ESC)).toBe('ESC');
  });

  it('renders an unknown byte as hex rather than guessing', () => {
    expect(keyName('\x07')).toBe('\\x07');
  });

  it('reads as a keystroke list', () => {
    expect(describeInterruptBytes([ESC, CTRL_U])).toBe('ESC then Ctrl+U');
    expect(describeInterruptBytes([CTRL_C])).toBe('Ctrl+C');
    expect(describeInterruptBytes([])).toBe('nothing');
  });
});

// ============================================================================
// A plain SHELL is a known target, not an unknown harness (CMAP round 1, finding 1).
//
// `afx send <shell-id> --interrupt` is reachable — resolveAgentInRegistry matches
// entry.shells — and a shell has no harness and no `.builder-start.sh`. Resolving it
// into the unknown bucket wrote a lone ESC, which bash IGNORES: a documented capability
// (Spec 0020's "Vim trap" escape) became a silent no-op that still reported success.
// ============================================================================

describe('isShellCommand', () => {
  it('recognises the shells a workspace actually launches', () => {
    for (const command of ['bash', 'zsh', '/bin/bash', 'sh', 'fish', 'dash']) {
      expect(isShellCommand(command)).toBe(true);
    }
    expect(isShellCommand('/bin/zsh -l')).toBe(true);
  });

  it('does NOT claim an indirect invocation like `env bash`', () => {
    // `/usr/bin/env` is not a shell, and resolving the wrapped program would mean parsing
    // arbitrary command lines. Falling back to the unknown bucket here costs a no-op ESC,
    // which is the safe direction; claiming a target wrongly is the expensive one. The
    // workspace's configured shell (`shell.shell`, default `bash`) is a bare name, so this
    // form does not arise in practice today.
    expect(isShellCommand('/usr/bin/env bash')).toBe(false);
  });

  it('matches the basename EXACTLY, never as a substring', () => {
    // A loose match would claim `shellper` (a real binary in this codebase) and any
    // wrapper script ending in `-sh`. Claiming a target wrongly is how a fatal byte
    // gets sent, so this is stricter than detectHarnessFromCommand deliberately.
    for (const command of ['shellper', 'bashful', 'my-sh', 'zshrc-tool', '', 'claude', 'opencode']) {
      expect(isShellCommand(command)).toBe(false);
    }
  });
});

describe('a shell target keeps Ctrl+C', () => {
  function session(command: string, cwd = '/nonexistent-worktree-for-bugfix-196'): DeliverySession {
    return {
      bytesWritten: 0,
      info: { cols: 80, rows: 24 },
      command,
      launchArgs: [],
      cwd,
      writable: true,
      write: () => true,
    };
  }

  it('sends Ctrl+C to a plain shell, not the ESC that bash ignores', () => {
    for (const command of ['bash', '/bin/zsh', 'sh']) {
      expect(promptReadySequence(session(command))).toEqual([CTRL_C]);
    }
  });

  it('clears a shell composer with Ctrl+C too — readline discards the line', () => {
    expect(clearDraftKeyForSession(session('bash'))).toBe('ctrl-c');
  });

  it('still fails safe for a target that is neither a shell nor a known agent', () => {
    expect(promptReadySequence(session('/usr/local/bin/some-new-tui'))).toEqual([ESC]);
    expect(clearDraftKeyForSession(session('some-new-tui'))).toBe('none');
  });
});

describe('a wrapped builder is NEVER mistaken for a shell', () => {
  // The ordering guard, and the reason shell detection is a separate predicate consulted
  // LAST. A builder's own session.command IS a shell — the `.builder-start.sh` wrapper —
  // so matching it before the launch-script lookup would send Ctrl+C to an opencode
  // builder, which is precisely the bug this whole change exists to fix.
  let worktree: string;
  beforeEach(() => { worktree = mkdtempSync(join(tmpdir(), 'bugfix196-wrapped-')); });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  function wrappedSession(launchScript: string): DeliverySession {
    writeFileSync(join(worktree, '.builder-start.sh'), launchScript);
    return {
      bytesWritten: 0,
      info: { cols: 80, rows: 24 },
      // The shell that wraps the agent — exactly what a real builder session reports.
      command: 'bash',
      launchArgs: [],
      cwd: worktree,
      writable: true,
      write: () => true,
    };
  }

  it('an opencode builder launched through bash gets ESC then Ctrl+U, NEVER Ctrl+C', () => {
    const seq = promptReadySequence(wrappedSession('#!/bin/bash\nopencode --prompt "$(cat p.txt)"\n'));
    expect(seq).toEqual([ESC, CTRL_U]);
    expect(seq).not.toContain(CTRL_C);
  });

  it('a claude builder launched through bash still gets a single Ctrl+C', () => {
    expect(promptReadySequence(wrappedSession('#!/bin/bash\nclaude --dangerously-skip-permissions\n')))
      .toEqual([CTRL_C]);
  });

  it('only a shell with NO launch script is treated as a shell', () => {
    // Same command, no `.builder-start.sh` — now it is genuinely a plain shell.
    const bare: DeliverySession = {
      bytesWritten: 0, info: { cols: 80, rows: 24 }, command: 'bash',
      launchArgs: [], cwd: worktree, writable: true, write: () => true,
    };
    expect(promptReadySequence(bare)).toEqual([CTRL_C]);
  });
});

// ============================================================================
// The bytes must be SETTLED, not written back-to-back (CMAP round 2, blocking 1).
//
// ESC immediately followed by a character is the terminal encoding for Alt+character,
// so an unspaced `\x1b\x15` can reach a TUI as ONE alt-keypress instead of two
// keystrokes. VERIFIED LIVE against opencode 1.18.18 — see
// codev/research/196-esc-alt-encoding-probe.mjs:
//   unspaced -> composer NOT cleared;  settled -> cleared;  Ctrl+U alone -> cleared.
// The unspaced form did not quit opencode, so it failed SILENTLY, which is why a unit
// test could never have found it. These tests pin the sequencing the live run validated.
// ============================================================================

describe('writeControlSequence', () => {
  function recorder() {
    const writes: Array<{ byte: string; atMs: number }> = [];
    const t0 = Date.now();
    return {
      writes,
      session: { write: (d: string) => { writes.push({ byte: d, atMs: Date.now() - t0 }); return true; } },
    };
  }

  it('writes a single byte immediately and claims no settle time', () => {
    // claude and codex dedup to one byte, so they must be unchanged in timing as well
    // as in bytes — a settle they do not need would be a behaviour change for harnesses
    // that were never broken.
    const { writes, session } = recorder();
    expect(writeControlSequence(session, [CTRL_C])).toBe(0);
    expect(writes.map(w => w.byte)).toEqual([CTRL_C]);
  });

  it('separates two bytes by the settle the TUI needs, and reports the offset', () => {
    const { writes, session } = recorder();
    const done = writeControlSequence(session, [ESC, CTRL_U]);
    expect(done).toBe(ESCAPE_ENTER_DELAY_MS);
    // The first byte is on the wire immediately; the second is deferred, NOT concatenated.
    expect(writes.map(w => w.byte)).toEqual([ESC]);
  });

  it('never concatenates ESC with the byte after it', () => {
    // The actual defect: `session.write(ESC + CTRL_U)` in one call is the Alt+u encoding.
    const { writes, session } = recorder();
    writeControlSequence(session, [ESC, CTRL_U]);
    for (const w of writes) {
      expect(w.byte.length).toBe(1);
      expect(w.byte).not.toBe(ESC + CTRL_U);
    }
  });

  it('writes nothing and claims no time for an empty sequence', () => {
    const { writes, session } = recorder();
    expect(writeControlSequence(session, [])).toBe(0);
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// heldRemedy's `canAutoClear` must be stated, never assumed
// ---------------------------------------------------------------------------

describe('heldRemedy never defaults to promising a keystroke (#190 re-armed)', () => {
  it('takes canAutoClear as a REQUIRED third parameter', () => {
    // Function.length counts parameters before the first defaulted one. A default of
    // `true` — the shape this test exists to prevent — would drop it to 2 and fail
    // here, which is the only runtime-visible trace a re-added default leaves.
    //
    // `tsc` catches an omitted argument in production source, but NOT here: this
    // package's tsconfig excludes `**/__tests__/**`, so test files are never
    // typechecked. That is exactly why this assertion is on arity rather than left
    // to the compiler.
    expect(heldRemedy.length).toBe(3);
  });

  it('promises the automatic clearing keystroke only when one can be sent', () => {
    const can = heldRemedy('builder-x', 'user-text', true);
    expect(can).toContain('Tower sends one automatic clearing keystroke');
  });

  it('says outright that no repair is coming when no keystroke is recorded', () => {
    // #190's shape: an operator told to wait for a keystroke that will never arrive
    // waits forever, because nothing else reports the promise was empty.
    const cannot = heldRemedy('builder-x', 'user-text', false);
    expect(cannot).toContain('NO clearing keystroke recorded');
    expect(cannot).toContain('needs a human');
    expect(cannot).not.toContain('Tower sends one automatic clearing keystroke');
    // It must still name the command that works — refusing the false promise is not
    // a reason to leave the operator with no remedy at all.
    expect(cannot).toContain('afx send builder-x --interrupt');
  });
});
