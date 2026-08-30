/**
 * Spec 146, Phase 3 — porch's session lifecycle against t3code.
 *
 * Here for the same reason Phase 1's and Phase 2's tests are: the root `test`
 * script is `pnpm --filter @cluesmith/codev test`, so a test placed inside
 * `packages/porch-driver` would look present and never run. The plan named
 * `packages/porch-driver/__tests__/`; that location is not reachable by the check
 * porch actually executes, so the tests live where they run and the plan records
 * the deviation.
 *
 * Weighted towards the ways this layer can lose work rather than fail:
 * a settle reported before the turn started, a journal written after the
 * dispatch, a cursor advanced before the handler, a check run against a tree an
 * agent is still writing, an unmapped harness spawning the default driver.
 *
 * The two crash windows are exercised with real hooks standing inside them —
 * `beforeDispatch` and `beforeAdvance` — not by asserting the code reads as if it
 * were ordered correctly. Live process kills at the same two windows are the
 * integration harness's job (`codev/experiments/146-phase3-live/`).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HARNESSES_ACCEPTING_MODEL,
  HARNESS_TO_DRIVER_KIND,
  ModelUnsupportedForDriverError,
  RETIRED_HARNESS_NAMES,
  RetiredHarnessMappingError,
  T3_DRIVER_KINDS,
  UnmappedHarnessError,
  mapHarness,
} from '../../../porch-driver/src/harness-map.js';
import {
  DISPATCH_METHOD,
  DispatchJournal,
  JournalCorruptError,
  dispatchCommand,
  isServerRefusal,
  newCommandId,
  recoverPendingCommands,
} from '../../../porch-driver/src/commands.js';
import { CursorUnreadableError, PersistentCursor } from '../../../porch-driver/src/cursor.js';
import {
  TurnDisplacedError,
  TurnTracker,
  activeTurnIdOf,
  asThreadEvent,
  assistantText,
  interruptTurn,
  startTurn,
  type ThreadEvent,
} from '../../../porch-driver/src/turn.js';
import { TurnActiveError, runPhaseCheck } from '../../../porch-driver/src/checks.js';
import { applyWorktreeSetup, planWorktreeSetup } from '../../../porch-driver/src/worktree-setup.js';
import { DriverThread, ModelSelectionRequiredError, createWorktree } from '../../../porch-driver/src/thread.js';
import { checkPayload } from '../../../t3-client/src/checked.js';
import { BUILTIN_HARNESSES, getBuiltinHarness, RETIRED_HARNESSES } from '../agent-farm/utils/harness.js';

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `spec146-p3-${label}-`));
}

/** A dispatcher that records what it was asked to send. */
function recordingDispatcher(reply: (method: string, payload: unknown) => unknown = () => ({})) {
  const calls: Array<{ method: string; payload: any }> = [];
  return {
    calls,
    async call(method: string, payload: unknown) {
      calls.push({ method, payload });
      return reply(method, payload);
    },
  };
}

/** A `thread.session-set` stream value. */
function sessionSet(threadId: string, sequence: number, activeTurnId: string | null): unknown {
  return {
    kind: 'event',
    event: {
      sequence,
      aggregateId: threadId,
      eventId: `evt-${sequence}`,
      type: 'thread.session-set',
      payload: { session: { activeTurnId, status: 'ready' } },
    },
  };
}

function assistantMessage(threadId: string, sequence: number, text: string): unknown {
  return {
    kind: 'event',
    event: {
      sequence,
      aggregateId: threadId,
      eventId: `evt-${sequence}`,
      type: 'thread.message-sent',
      payload: { role: 'assistant', text },
    },
  };
}

// ------------------------------------------------------------- harness map

describe('spec 146 phase 3: harness to driverKind', () => {
  it('maps claude to claudeAgent, not to claude', () => {
    // Two of five kinds match Codev's names by accident. This is the third.
    expect(mapHarness('claude').driverKind).toBe('claudeAgent');
  });

  it('maps the harnesses that do match, without inventing the ones that do not', () => {
    expect(mapHarness('codex').driverKind).toBe('codex');
    expect(mapHarness('opencode').driverKind).toBe('opencode');
    for (const kind of Object.values(HARNESS_TO_DRIVER_KIND)) {
      expect(T3_DRIVER_KINDS).toContain(kind);
    }
  });

  it('refuses an unknown harness rather than falling back to a default driver', () => {
    expect(() => mapHarness('my-custom-thing')).toThrow(UnmappedHarnessError);
  });

  it('answers a retired harness with retirement, not with "unknown"', () => {
    // Different facts. "Nobody has heard of gemini" would be false.
    const error = (() => {
      try {
        mapHarness('gemini');
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error).toBeInstanceOf(RetiredHarnessMappingError);
    expect(error?.message).toMatch(/retired/i);
    expect(error).not.toBeInstanceOf(UnmappedHarnessError);
  });

  it('the retired list matches Codev\'s own', () => {
    // Compares the two DUPLICATED sets, not the copy against a literal. A literal
    // would go green while the copy and the real registry disagreed, which is the
    // only failure this test exists to catch.
    expect([...RETIRED_HARNESS_NAMES].sort()).toEqual(Object.keys(RETIRED_HARNESSES).sort());
  });

  it('maps --model onto modelSelection.model', () => {
    const mapping = mapHarness('codex', { model: 'gpt-5.6-luna' });
    expect(mapping.modelSelection).toEqual({ instanceId: 'codex', model: 'gpt-5.6-luna' });
  });

  it('omits modelSelection entirely when no model was given', () => {
    // Not `{ model: undefined }`: an absent selection lets the server default,
    // a present-but-empty one is a payload the contract rejects.
    expect(mapHarness('codex').modelSelection).toBeUndefined();
  });

  it('fails an unsupported harness/model pair at spawn', () => {
    expect(() => mapHarness('codex', { model: 'x', acceptsModel: () => false })).toThrow(
      ModelUnsupportedForDriverError,
    );
  });

  it('the model-accepting set matches the real harness table', () => {
    // The duplication is deliberate (porch-driver must not import agent-farm),
    // so it is asserted rather than trusted.
    const real = Object.keys(BUILTIN_HARNESSES).filter(
      (name) => getBuiltinHarness(name)?.buildScriptModelArg !== undefined,
    );
    expect([...HARNESSES_ACCEPTING_MODEL].sort()).toEqual(real.sort());
  });

  it('the mapped harnesses are exactly Codev\'s built-ins', () => {
    expect(Object.keys(HARNESS_TO_DRIVER_KIND).sort()).toEqual(Object.keys(BUILTIN_HARNESSES).sort());
  });
});

// -------------------------------------------------------- dispatch journal

describe('spec 146 phase 3: the dispatch journal', () => {
  it('writes the intent BEFORE the command is dispatched', async () => {
    const dir = tempDir('journal-order');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      let journalAtDispatch: number | null = null;
      const dispatcher = {
        async call() {
          journalAtDispatch = journal.read().records.length;
          return {};
        },
      };

      await dispatchCommand(dispatcher, journal, { type: 'thread.turn.start' });

      // One record — the intent — was already durable when the send happened.
      expect(journalAtDispatch).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a crash between the journal write and the dispatch leaves the command pending', async () => {
    const dir = tempDir('journal-crash');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      const crash = new Error('killed between journal and dispatch');

      await expect(
        dispatchCommand(
          { async call() { throw new Error('must not be reached'); } },
          journal,
          { type: 'thread.turn.start', commandId: 'cmd-1' },
          { beforeDispatch: () => { throw crash; } },
        ),
      ).rejects.toBe(crash);

      // A fresh process reads the same file.
      const reopened = new DispatchJournal(path);
      expect(reopened.pending().map((r) => r.commandId)).toEqual(['cmd-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovery re-dispatches under the SAME commandId, so the server can dedupe', async () => {
    const dir = tempDir('journal-recover');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      journal.recordIntent('cmd-7', 'thread.turn.start', { type: 'thread.turn.start', commandId: 'cmd-7' });

      const dispatcher = recordingDispatcher();
      const replayed = await recoverPendingCommands(dispatcher, new DispatchJournal(path));

      expect(replayed).toEqual(['cmd-7']);
      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0].method).toBe(DISPATCH_METHOD);
      expect(dispatcher.calls[0].payload.commandId).toBe('cmd-7');
      // And it is settled now, so a second recovery does nothing.
      expect(new DispatchJournal(path).pending()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a REFUSAL during recovery settles the intent', async () => {
    // The server answered no. Replaying it would replay a decision already made,
    // so this one is allowed to leave recovery.
    const dir = tempDir('journal-recover-refused');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      journal.recordIntent('cmd-1', 'thread.turn.start', { type: 'thread.turn.start', commandId: 'cmd-1' });

      const refusal = Object.assign(new Error('rejected'), { name: 'RpcFailureError' });
      const dispatcher = {
        async call() {
          throw refusal;
        },
      };

      await expect(recoverPendingCommands(dispatcher, new DispatchJournal(path))).rejects.toBe(refusal);
      expect(new DispatchJournal(path).pending()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an UNANSWERED command during recovery stays pending for the next recovery', async () => {
    // The failure recovery is most likely to meet, because recovery runs right
    // after a crash, when the server may still be coming up. Recording it as
    // `failed` would spell "I could not tell" like "no" and drop the command
    // from the one code path whose job is to re-send it.
    const dir = tempDir('journal-recover-unanswered');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      journal.recordIntent('cmd-1', 'thread.turn.start', { type: 'thread.turn.start', commandId: 'cmd-1' });

      const dead = Object.assign(new Error('socket closed'), { name: 'NotConnectedError' });
      await expect(
        recoverPendingCommands(
          {
            async call() {
              throw dead;
            },
          },
          new DispatchJournal(path),
        ),
      ).rejects.toBe(dead);

      // Still pending on disk, so a later recovery finds it.
      expect(new DispatchJournal(path).pending().map((r) => r.commandId)).toEqual(['cmd-1']);

      const dispatcher = recordingDispatcher();
      expect(await recoverPendingCommands(dispatcher, new DispatchJournal(path))).toEqual(['cmd-1']);
      expect(dispatcher.calls[0].payload.commandId).toBe('cmd-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a completed dispatch is not pending', async () => {
    const dir = tempDir('journal-settled');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      await dispatchCommand(recordingDispatcher(), journal, { type: 'project.create' });
      expect(new DispatchJournal(path).pending()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a torn LAST line is recovered; a torn middle line is reported', () => {
    const dir = tempDir('journal-torn');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      journal.recordIntent('cmd-a', 'thread.turn.start', { commandId: 'cmd-a' });
      // A kill mid-append.
      writeFileSync(path, readFileSync(path, 'utf-8') + '{"kind":"intent","comm', 'utf-8');

      const result = new DispatchJournal(path).read();
      expect(result.tornTail).toBe(true);
      expect(result.records).toHaveLength(1);

      // Damage that a crash does not produce must not read as "nothing here".
      const damaged = join(dir, 'damaged.jsonl');
      writeFileSync(damaged, '{"kind":"intent"}\nnot json at all\n{"kind":"intent"}\n', 'utf-8');
      expect(() => new DispatchJournal(damaged).read()).toThrow(JournalCorruptError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appending after a torn tail does not corrupt the journal', async () => {
    // Tolerating the torn line on read is not enough: appending after it glues the
    // next record onto the partial one, and from then on every read throws. One
    // crash after the crash the journal exists to survive.
    const dir = tempDir('journal-torn-append');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      journal.recordIntent('cmd-a', 'thread.turn.start', { commandId: 'cmd-a' });
      writeFileSync(path, readFileSync(path, 'utf-8') + '{"kind":"intent","comm', 'utf-8');

      journal.recordIntent('cmd-b', 'thread.turn.start', { commandId: 'cmd-b' });

      const reopened = new DispatchJournal(path);
      expect(() => reopened.read()).not.toThrow();
      expect(reopened.pending().map((r) => r.commandId)).toEqual(['cmd-a', 'cmd-b']);
      expect(reopened.read().tornTail).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports what the torn tail contained rather than fixing it silently', () => {
    const dir = tempDir('journal-torn-report');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      journal.recordIntent('cmd-a', 'thread.turn.start', { commandId: 'cmd-a' });
      writeFileSync(path, readFileSync(path, 'utf-8') + '{"partial', 'utf-8');
      expect(journal.repairTornTail()).toBe('{"partial');
      expect(journal.repairTornTail()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an absent journal is empty and not torn', () => {
    const dir = tempDir('journal-absent');
    try {
      const result = new DispatchJournal(join(dir, 'nothing.jsonl')).read();
      expect(result).toEqual({ records: [], tornTail: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a command the server REFUSED is settled, not retried forever', async () => {
    const dir = tempDir('journal-refused');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      const refusal = Object.assign(new Error('the server said no'), { name: 'RpcFailureError' });
      await expect(
        dispatchCommand({ async call() { throw refusal; } }, journal, { type: 'thread.create' }),
      ).rejects.toBe(refusal);
      expect(new DispatchJournal(path).pending()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a command left UNANSWERED stays pending, because absent is not negative', async () => {
    // A dead socket does not tell us whether the command landed. Recording it as
    // failed would spell "I could not tell" exactly like "no", and a command the
    // server had already applied would then never be recovered.
    const dir = tempDir('journal-unanswered');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      const dropped = Object.assign(new Error('socket closed'), { name: 'NotConnectedError' });
      await expect(
        dispatchCommand({ async call() { throw dropped; } }, journal, { type: 'thread.turn.start' }),
      ).rejects.toBe(dropped);
      expect(new DispatchJournal(path).pending()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unrecognised error is treated as unanswered, not as a refusal', () => {
    expect(isServerRefusal(new Error('who knows'))).toBe(false);
    expect(isServerRefusal(Object.assign(new Error('no'), { name: 'RpcFailureError' }))).toBe(true);
    expect(isServerRefusal(Object.assign(new Error('t'), { name: 'RequestTimeoutError' }))).toBe(false);
  });

  it('generates a distinct commandId per command when none is supplied', async () => {
    const dir = tempDir('journal-ids');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher();
      const a = await dispatchCommand(dispatcher, journal, { type: 'thread.turn.start' });
      const b = await dispatchCommand(dispatcher, journal, { type: 'thread.turn.start' });
      expect(a.commandId).not.toBe(b.commandId);
      expect(dispatcher.calls[0].payload.commandId).toBe(a.commandId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('newCommandId returns a uuid', () => {
    expect(newCommandId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// -------------------------------------------------------------- the cursor

describe('spec 146 phase 3: the persisted cursor', () => {
  it('advances only after the handler completes', async () => {
    const dir = tempDir('cursor-order');
    try {
      const path = join(dir, 'cursor');
      const cursor = PersistentCursor.load(path);
      let onDiskDuringHandler: string | null = null;

      await cursor.apply(5, async () => {
        onDiskDuringHandler = existsSync(path) ? readFileSync(path, 'utf-8').trim() : null;
      });

      // Nothing was written while the handler ran.
      expect(onDiskDuringHandler).toBeNull();
      expect(readFileSync(path, 'utf-8').trim()).toBe('5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a crash between the handler and the cursor write REPROCESSES the event', async () => {
    const dir = tempDir('cursor-crash');
    try {
      const path = join(dir, 'cursor');
      const applied: number[] = [];
      const cursor = PersistentCursor.load(path);
      await cursor.apply(1, () => { applied.push(1); });

      // Killed inside the window the spec names: handler done, cursor unwritten.
      const crash = new Error('killed before the cursor advanced');
      await expect(
        cursor.apply(2, () => { applied.push(2); }, { beforeAdvance: () => { throw crash; } }),
      ).rejects.toBe(crash);

      // Restart. The cursor still says 1, so event 2 comes back — the property
      // at-least-once delivery was chosen to buy.
      const reopened = PersistentCursor.load(path);
      expect(reopened.applied).toBe(1);
      await reopened.apply(2, () => { applied.push(2); });
      expect(applied).toEqual([1, 2, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a handler that throws leaves the cursor where it was', async () => {
    const dir = tempDir('cursor-handler-throw');
    try {
      const path = join(dir, 'cursor');
      const cursor = PersistentCursor.load(path);
      await expect(cursor.apply(3, () => { throw new Error('handler failed'); })).rejects.toThrow('handler failed');
      expect(cursor.applied).toBe(0);
      expect(PersistentCursor.load(path).applied).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a redelivered sequence instead of re-running its handler', async () => {
    const dir = tempDir('cursor-dupe');
    try {
      const cursor = PersistentCursor.load(join(dir, 'cursor'));
      const handler = vi.fn();
      await cursor.apply(4, handler);
      expect(await cursor.apply(4, handler)).toBe('duplicate');
      expect(await cursor.apply(3, handler)).toBe('duplicate');
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reset moves the cursor BACKWARDS, which is the case it exists for', async () => {
    const dir = tempDir('cursor-reset');
    try {
      const path = join(dir, 'cursor');
      const cursor = PersistentCursor.load(path);
      await cursor.apply(5_000_000, () => {});
      // A restored server: the cursor is ahead of the head.
      cursor.reset(12);
      expect(cursor.applied).toBe(12);
      expect(PersistentCursor.load(path).applied).toBe(12);
      // And live events flow again rather than being discarded as already-applied.
      expect(await cursor.apply(13, () => {})).toBe('applied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an absent cursor file is a cold start; an unreadable one is an error', () => {
    const dir = tempDir('cursor-unreadable');
    try {
      expect(PersistentCursor.load(join(dir, 'missing')).applied).toBe(0);
      const damaged = join(dir, 'damaged');
      writeFileSync(damaged, 'not-a-number\n', 'utf-8');
      expect(() => PersistentCursor.load(damaged)).toThrow(CursorUnreadableError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------- settle detection
//
// `TurnTracker`'s REFUSAL behaviour is tested elsewhere, and this pointer exists
// so the split is discoverable rather than accidental:
// `agent-farm/__tests__/spec-146-phase-10-full-protocol.test.ts`, under
// "a refusal is not a timeout". Phase 10 added `SessionStartFailedError` — a
// session that fails before the turn is running abandons the waiter with the
// server's own sentence instead of letting the caller time out — plus the
// sequence guard that stops a REPLAYED refusal killing a healthy turn, and the
// role-prompt restore. Those tests live with the phase that found the defect and
// carries the evidence for it; these cover the settle latch this phase built.

describe('spec 146 phase 3: settle detection', () => {
  it('does NOT report settled on the thread-creation event', async () => {
    // `activeTurnId` is already null there. A detector without the latch reports
    // settled before the turn starts, and everything downstream measures nothing.
    const tracker = new TurnTracker();
    const expectation = tracker.expectTurn('t1');
    let settled = false;
    void expectation.settled.then(() => { settled = true; });

    tracker.observe(sessionSet('t1', 1, null));
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.observe(sessionSet('t1', 2, 'turn-a'));
    tracker.observe(sessionSet('t1', 3, null));
    await expectation.settled;
    expect(settled).toBe(true);
  });

  it('reports the turn id from the running transition', async () => {
    const tracker = new TurnTracker();
    const expectation = tracker.expectTurn('t1');
    tracker.observe(sessionSet('t1', 2, 'turn-b'));
    await expect(expectation.running).resolves.toBe('turn-b');
  });

  it('keys on activeTurnId, not on session status', () => {
    // An interrupted turn reports status `ready`, exactly as a finished one does.
    const interrupted = asThreadEvent(sessionSet('t1', 9, null))!;
    expect((interrupted.payload!.session as any).status).toBe('ready');
    expect(activeTurnIdOf(interrupted)).toBeNull();
    // A non-session event carries no opinion at all, which is a third answer.
    expect(activeTurnIdOf(asThreadEvent(assistantMessage('t1', 10, 'hi'))!)).toBeUndefined();
  });

  it('tracks each thread separately', async () => {
    const tracker = new TurnTracker();
    const one = tracker.expectTurn('t1');
    const two = tracker.expectTurn('t2');
    tracker.observe(sessionSet('t1', 1, 'a'));
    tracker.observe(sessionSet('t2', 2, 'b'));
    expect(tracker.activeThreads.size).toBe(2);
    tracker.observe(sessionSet('t1', 3, null));
    await one.settled;
    expect(tracker.activeThreads.has('t1')).toBe(false);
    expect(tracker.activeThreads.has('t2')).toBe(true);
    tracker.observe(sessionSet('t2', 4, null));
    await two.settled;
  });

  it('survives a redelivered settle event', async () => {
    const tracker = new TurnTracker();
    const expectation = tracker.expectTurn('t1');
    tracker.observe(sessionSet('t1', 1, 'a'));
    tracker.observe(sessionSet('t1', 2, null));
    tracker.observe(sessionSet('t1', 2, null));
    await expectation.settled;
    expect(tracker.lastSequence('t1')).toBe(2);
  });

  it('lastSequence never goes backwards on a redelivery', () => {
    const tracker = new TurnTracker();
    tracker.observe(assistantMessage('t1', 7, 'a'));
    tracker.observe(assistantMessage('t1', 3, 'b'));
    expect(tracker.lastSequence('t1')).toBe(7);
  });

  it('registers the waiter before the command is dispatched', async () => {
    const dir = tempDir('turn-register');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const tracker = new TurnTracker();
      let runningAtDispatch: string | null = null;

      const dispatcher = {
        async call(_method: string, _payload: unknown) {
          // The server answers instantly. If the waiter were registered after
          // this, the running signal would be missed.
          tracker.observe(sessionSet('t1', 5, 'turn-fast'));
          runningAtDispatch = 'observed';
          return {};
        },
      };

      const started = await startTurn(dispatcher, journal, tracker, { threadId: 't1', text: 'go' });
      expect(runningAtDispatch).toBe('observed');
      await expect(started.running).resolves.toBe('turn-fast');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures the starting sequence before the turn is dispatched', async () => {
    const dir = tempDir('turn-start-seq');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const tracker = new TurnTracker();
      tracker.observe(assistantMessage('t1', 11, 'earlier turn'));
      const dispatcher = {
        async call() {
          tracker.observe(assistantMessage('t1', 12, 'from this turn'));
          return {};
        },
      };
      const started = await startTurn(dispatcher, journal, tracker, { threadId: 't1', text: 'go' });
      expect(started.startSequence).toBe(11);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('journals the turn and the interrupt as commands', async () => {
    const dir = tempDir('turn-journal');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      const dispatcher = recordingDispatcher();
      await startTurn(dispatcher, journal, new TurnTracker(), { threadId: 't1', text: 'hello' });
      await interruptTurn(dispatcher, journal, 't1', 'turn-a');

      const types = journal.read().records.filter((r) => r.kind === 'intent').map((r: any) => r.type);
      expect(types).toEqual(['thread.turn.start', 'thread.turn.interrupt']);
      expect(dispatcher.calls[1].payload).toMatchObject({ type: 'thread.turn.interrupt', threadId: 't1', turnId: 'turn-a' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scopes assistant text to the turn\'s own sequence range', () => {
    const events: ThreadEvent[] = [
      asThreadEvent(assistantMessage('t1', 1, 'before '))!,
      asThreadEvent(assistantMessage('t1', 2, 'during '))!,
      asThreadEvent(assistantMessage('t2', 3, 'other thread '))!,
      asThreadEvent(assistantMessage('t1', 4, 'after'))!,
    ];
    expect(assistantText(events, 't1', 1, 3)).toBe('during ');
  });
});

// -------------------------------------------------------------- the checks

describe('spec 146 phase 3: phase checks', () => {
  it('runs in the worktree path, as a process, with no RPC involved', async () => {
    const dir = tempDir('check-cwd');
    try {
      const result = await runPhaseCheck({ command: 'pwd', cwd: dir });
      expect(result.passed).toBe(true);
      // macOS resolves /tmp through /private, so compare the tail.
      expect(result.stdout.trim().endsWith(dir.replace(/^\/private/, ''))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a non-zero exit as a result, not an exception', async () => {
    const dir = tempDir('check-fail');
    try {
      const result = await runPhaseCheck({ command: 'exit 3', cwd: dir });
      expect(result.exitCode).toBe(3);
      expect(result.passed).toBe(false);
      expect(result.timedOut).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a timeout is spelled differently from a failure', async () => {
    const dir = tempDir('check-timeout');
    try {
      const result = await runPhaseCheck({ command: 'sleep 30', cwd: dir, timeoutMs: 200, killGraceMs: 100 });
      expect(result.timedOut).toBe(true);
      // Not a number a caller could read as a verdict.
      expect(result.exitCode).toBeNull();
      expect(result.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the timeout bounds a COMPOUND command, which is what a real check is', async () => {
    // `bash -lc 'sleep 30'` execs, so the shell's pid is the sleep's and killing
    // it works. `sleep 20; true` forks, and signalling only the shell left the
    // call running for the full 20 seconds against a 1-second budget. Every real
    // check — `npm test`, `pnpm build` — is this shape.
    const dir = tempDir('check-timeout-compound');
    try {
      const started = Date.now();
      const result = await runPhaseCheck({
        command: 'sleep 20; true',
        cwd: dir,
        timeoutMs: 700,
        killGraceMs: 200,
      });
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(6_000);
      expect(result.durationMs).toBeLessThan(6_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the timeout kills a backgrounded grandchild, not just the shell', async () => {
    const dir = tempDir('check-timeout-grandchild');
    try {
      const marker = join(dir, 'grandchild-ran.txt');
      const result = await runPhaseCheck({
        command: `(sleep 3; touch ${JSON.stringify(marker)}) & sleep 20`,
        cwd: dir,
        timeoutMs: 700,
        killGraceMs: 200,
      });
      expect(result.timedOut).toBe(true);
      // Well past the grandchild's own sleep: if the group was not signalled, the
      // marker is here.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a SIGTERM-ignoring check is still bounded', async () => {
    const dir = tempDir('check-sigterm-ignored');
    try {
      const started = Date.now();
      const result = await runPhaseCheck({
        command: 'trap "" TERM; sleep 20',
        cwd: dir,
        timeoutMs: 500,
        killGraceMs: 300,
      });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps captured output and says it did', async () => {
    const dir = tempDir('check-output-cap');
    try {
      const result = await runPhaseCheck({
        command: 'for i in $(seq 1 500); do echo "0123456789"; done',
        cwd: dir,
        maxOutputBytes: 200,
      });
      expect(result.passed).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(200);
      expect(result.stdoutTruncated).toBe(true);
      // The TAIL is what a failing check explains itself with.
      expect(result.stdout.trim().endsWith('0123456789')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps output in BYTES, which is what the option is called', async () => {
    // `combined.length` counts UTF-16 code units, so a 4 MiB cap held about 8 MiB
    // of astral output — wrong in the direction that matters, and only for the
    // output most likely to be large.
    //
    // THE SIZE IS THE TEST. Each emoji is 4 bytes and 2 code units, so a
    // code-unit cap only escapes in the window where the units still fit and the
    // bytes do not: 40 emoji is 80 units against a cap of 100, and 160 bytes
    // against the same 100. Pick 200 instead and both readings truncate — the
    // trim itself is byte-based — and the test goes green against the bug it
    // was written for. Which is what the first version of it did.
    const dir = tempDir('check-output-cap-bytes');
    try {
      const result = await runPhaseCheck({
        command: 'for i in $(seq 1 40); do printf "\\xF0\\x9F\\x9A\\x80"; done',
        cwd: dir,
        maxOutputBytes: 100,
      });
      expect(result.passed).toBe(true);
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(100);
      expect(result.stdoutTruncated).toBe(true);
      // Cut on a character boundary: no replacement character at the head.
      expect(result.stdout.startsWith('�')).toBe(false);
      expect(result.stdout.endsWith('🚀')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    // A `data` chunk is a byte boundary, not a character boundary. Under a plain
    // `chunk.toString()` a sequence straddling two chunks decodes to replacement
    // characters, and a check's output is then wrong in a way no exit code shows.
    //
    // THE SPLIT HAS TO BE FORCED. Writing a lot of ASCII and then the emoji does
    // not split anything — the emoji arrives whole in its own chunk, and the test
    // passes with or without the decoder. So the command writes the first two
    // bytes of the sequence, waits long enough for the reader to consume them,
    // and then writes the last two.
    const dir = tempDir('check-utf8-split');
    try {
      const result = await runPhaseCheck({
        command: 'printf "start:"; printf "\\xF0\\x9F"; sleep 0.3; printf "\\x9A\\x80"; printf ":end"',
        cwd: dir,
      });
      expect(result.passed).toBe(true);
      expect(result.stdout).toBe('start:🚀:end');
      expect(result.stdout).not.toContain('�');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kills a SIGTERM-ignoring descendant even though the shell exited first', async () => {
    // The escape the group kill alone does not close. SIGTERM goes to the group,
    // the shell dies, `exit` fires, and `finish` used to CLEAR the pending SIGKILL
    // — so a descendant that ignored SIGTERM outlived the check that spawned it
    // and kept writing to the worktree the next check is about to measure.
    const dir = tempDir('check-sigterm-survivor');
    try {
      const result = await runPhaseCheck({
        command: `( trap "" TERM; sleep 2; printf x > survivor.txt ) & sleep 30`,
        cwd: dir,
        timeoutMs: 400,
        killGraceMs: 5_000,
      });
      expect(result.timedOut).toBe(true);

      // Past when the survivor would have written, had it survived.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(existsSync(join(dir, 'survivor.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('records the interpreter it used', async () => {
    // Phase 2 had a teardown race that failed under bash and passed under zsh.
    const dir = tempDir('check-shell');
    try {
      const result = await runPhaseCheck({ command: 'echo $0', cwd: dir });
      expect(result.shell).toBe('bash');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps every byte a normal check printed, despite resolving promptly', async () => {
    // `exit` can fire before the pipes drain, so resolving on it alone would cut
    // the tail off a chatty check — a truncated log presented as a whole one.
    const dir = tempDir('check-drain');
    try {
      const result = await runPhaseCheck({
        command: 'for i in $(seq 1 2000); do echo "line-$i"; done',
        cwd: dir,
      });
      expect(result.passed).toBe(true);
      expect(result.stdoutTruncated).toBe(false);
      expect(result.stdout.trim().split('\n')).toHaveLength(2000);
      expect(result.stdout.trim().endsWith('line-2000')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures stderr separately from stdout', async () => {
    const dir = tempDir('check-streams');
    try {
      const result = await runPhaseCheck({ command: 'echo out; echo err >&2', cwd: dir });
      expect(result.stdout.trim()).toBe('out');
      expect(result.stderr.trim()).toBe('err');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------ worktree setup

describe('spec 146 phase 3: worktree setup', () => {
  it('installs the guard for claudeAgent when its content is supplied', () => {
    const plan = planWorktreeSetup('claudeAgent', {
      worktreePath: '/tmp/w',
      guardFiles: [{ relativePath: '.claude/hooks/worktree-write-guard.cjs', content: '// guard' }],
    });
    expect(plan.guard).toBe('installed');
    expect(plan.files.map((f) => f.relativePath)).toContain('.claude/hooks/worktree-write-guard.cjs');
  });

  it('reports an absent guard rather than silently omitting it', () => {
    const plan = planWorktreeSetup('claudeAgent', { worktreePath: '/tmp/w' });
    expect(plan.guard).toBe('absent');
    expect(plan.guardReason).toMatch(/NOT/);
  });

  it('distinguishes "no guard supplied" from "no guard applies"', () => {
    expect(planWorktreeSetup('codex', { worktreePath: '/tmp/w' }).guard).toBe('not-applicable');
    expect(planWorktreeSetup('claudeAgent', { worktreePath: '/tmp/w' }).guard).toBe('absent');
  });

  it('places opencode.json pointing at the role file', () => {
    const plan = planWorktreeSetup('opencode', { worktreePath: '/tmp/w', roleContent: '# role' });
    const opencode = plan.files.find((f) => f.relativePath === 'opencode.json');
    expect(JSON.parse(opencode!.content)).toEqual({ instructions: ['.builder-role.md'] });
    expect(plan.files.find((f) => f.relativePath === '.builder-role.md')?.content).toBe('# role');
  });

  it('merges an existing opencode.json rather than overwriting it', () => {
    const dir = tempDir('setup-merge');
    try {
      writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ theme: 'dark', instructions: ['MINE.md'] }), 'utf-8');
      const plan = planWorktreeSetup('opencode', { worktreePath: dir, roleContent: '# role' });
      applyWorktreeSetup(plan, dir);
      const merged = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf-8'));
      expect(merged.theme).toBe('dark');
      expect(merged.instructions.sort()).toEqual(['.builder-role.md', 'MINE.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an unparseable JSON file alone and says so', () => {
    const dir = tempDir('setup-jsonc');
    try {
      writeFileSync(join(dir, 'opencode.json'), '{ // a comment\n }', 'utf-8');
      const warnings: string[] = [];
      const plan = planWorktreeSetup('opencode', { worktreePath: dir });
      const written = applyWorktreeSetup(plan, dir, (m) => warnings.push(m));
      expect(written).not.toContain('opencode.json');
      expect(warnings.join(' ')).toMatch(/not valid JSON/);
      expect(readFileSync(join(dir, 'opencode.json'), 'utf-8')).toContain('// a comment');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates nested directories the guard needs', () => {
    const dir = tempDir('setup-nested');
    try {
      const plan = planWorktreeSetup('claudeAgent', {
        worktreePath: dir,
        guardFiles: [{ relativePath: '.claude/hooks/worktree-write-guard.cjs', content: '// guard' }],
      });
      applyWorktreeSetup(plan, dir);
      expect(readFileSync(join(dir, '.claude/hooks/worktree-write-guard.cjs'), 'utf-8')).toBe('// guard');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ the thread

describe('spec 146 phase 3: the thread', () => {
  async function makeThread(dir: string, overrides: Record<string, unknown> = {}) {
    const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
    const tracker = new TurnTracker();
    const dispatcher = recordingDispatcher();
    const worktreePath = join(dir, 'worktree');
    mkdirSync(worktreePath, { recursive: true });
    const thread = await DriverThread.create(
      { dispatcher, journal, tracker },
      {
        projectId: 'p1',
        title: 'a builder',
        harnessName: 'codex',
        model: 'gpt-5.6-luna',
        worktreePath,
        branch: 'builder/x',
        threadId: 't1',
        ...overrides,
      },
    );
    return { thread, tracker, dispatcher, journal, worktreePath };
  }

  it('creates the thread with the mapped driver and the worktree path', async () => {
    const dir = tempDir('thread-create');
    try {
      const { thread, dispatcher } = await makeThread(dir, { harnessName: 'claude', model: 'claude-opus-5' });
      expect(thread.driverKind).toBe('claudeAgent');
      const created = dispatcher.calls.find((c) => c.payload.type === 'thread.create')!;
      expect(created.payload.modelSelection).toEqual({ instanceId: 'claudeAgent', model: 'claude-opus-5' });
      expect(created.payload.worktreePath).toBe(thread.worktreePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('always sends modelSelection on thread.create, which the contract requires', async () => {
    const dir = tempDir('thread-model-required');
    try {
      const { dispatcher } = await makeThread(dir, { model: undefined, defaultModel: 'gpt-5.6-luna' });
      const created = dispatcher.calls.find((c) => c.payload.type === 'thread.create')!;
      expect(created.payload.modelSelection).toEqual({ instanceId: 'codex', model: 'gpt-5.6-luna' });

      // And the payload passes the vendored contract's own input schema, which is
      // where the omission would have been caught before it reached a server.
      // `toBe('ok')`, not `not.toBe('failed')`: the checker also answers
      // `unchecked`, and "I could not check this" passing as "this is valid" is
      // the exact spelling collapse the rest of this phase refuses.
      const outcome = checkPayload('orchestration.dispatchCommand', 'input', created.payload);
      expect(outcome.status).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to create a thread with no model at all', async () => {
    const dir = tempDir('thread-no-model');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher();
      await expect(
        DriverThread.create(
          { dispatcher, journal, tracker: new TurnTracker() },
          { projectId: 'p1', title: 't', harnessName: 'codex', worktreePath: dir, branch: 'b' },
        ),
      ).rejects.toThrow(ModelSelectionRequiredError);
      expect(dispatcher.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails before creating a thread when the harness cannot be mapped', async () => {
    const dir = tempDir('thread-unmapped');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher();
      await expect(
        DriverThread.create(
          { dispatcher, journal, tracker: new TurnTracker() },
          { projectId: 'p1', title: 't', harnessName: 'nope', model: 'x', worktreePath: dir, branch: 'b' },
        ),
      ).rejects.toThrow(UnmappedHarnessError);
      // Nothing was dispatched, so there is no half-configured thread.
      expect(dispatcher.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a turn to settle and returns only that turn\'s text', async () => {
    const dir = tempDir('thread-turn');
    try {
      const { thread, tracker } = await makeThread(dir);
      thread.observe(assistantMessage('t1', 1, 'from an earlier turn'));

      const promise = thread.runTurn('do the thing');
      // The server's lifecycle, in order.
      thread.observe(sessionSet('t1', 2, 'turn-1'));
      thread.observe(assistantMessage('t1', 3, 'DONE'));
      thread.observe(sessionSet('t1', 4, null));

      const outcome = await promise;
      expect(outcome.turnId).toBe('turn-1');
      expect(outcome.text).toBe('DONE');
      expect(outcome.startSequence).toBe(1);
      expect(outcome.endSequence).toBe(4);
      expect(tracker.activeThreads.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries the role prompt in the FIRST turn, and only the first', async () => {
    // The deliverable is "role prompts are delivered as the first turn's
    // content". Writing `.builder-role.md` satisfies the human-readable half and
    // none of the agent-facing one: a role the agent never receives is a role
    // that was not delivered, and the outbound payload is where that is visible.
    const dir = tempDir('thread-role');
    try {
      const { thread, dispatcher } = await makeThread(dir, { roleContent: '# Role: Builder' });
      expect(thread.roleDelivered).toBe(false);

      const first = await thread.beginTurn('start phase 1');
      thread.observe(sessionSet('t1', 2, 'turn-1'));
      thread.observe(sessionSet('t1', 3, null));
      await first.settled;

      const turns = dispatcher.calls.filter((c) => c.payload.type === 'thread.turn.start');
      expect(turns[0].payload.message.text).toBe('# Role: Builder\n\nstart phase 1');
      expect(thread.roleDelivered).toBe(true);

      const second = await thread.beginTurn('start phase 2');
      thread.observe(sessionSet('t1', 4, 'turn-2'));
      thread.observe(sessionSet('t1', 5, null));
      await second.settled;

      const later = dispatcher.calls.filter((c) => c.payload.type === 'thread.turn.start');
      expect(later[1].payload.message.text).toBe('start phase 2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the role pending when the first turn fails to start', async () => {
    // Of the two ways to be wrong — a role delivered twice, or a role never
    // delivered — only the second leaves the agent working with no instructions.
    const dir = tempDir('thread-role-retry');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const worktreePath = join(dir, 'worktree');
      mkdirSync(worktreePath, { recursive: true });
      let failNext = false;
      const calls: Array<{ payload: any }> = [];
      const dispatcher = {
        async call(_method: string, payload: any) {
          calls.push({ payload });
          if (failNext) throw Object.assign(new Error('socket closed'), { name: 'NotConnectedError' });
          return {};
        },
      };
      const thread = await DriverThread.create(
        { dispatcher, journal, tracker: new TurnTracker() },
        {
          projectId: 'p1',
          title: 'a builder',
          harnessName: 'codex',
          model: 'gpt-5.6-luna',
          worktreePath,
          branch: 'builder/x',
          threadId: 't1',
          roleContent: '# Role: Builder',
        },
      );

      failNext = true;
      await expect(thread.beginTurn('go')).rejects.toThrow('socket closed');
      expect(thread.roleDelivered).toBe(false);

      failNext = false;
      await thread.beginTurn('go');
      const turns = calls.filter((c) => c.payload.type === 'thread.turn.start');
      expect(turns[turns.length - 1].payload.message.text).toBe('# Role: Builder\n\ngo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a redelivered event is applied once, not twice', async () => {
    // At-least-once delivery is the contract — the cursor advances after the
    // handler by design — so every replay crosses `observe`. Appending the
    // duplicate returned the assistant's text twice: a range filter admits both
    // copies of the same sequence, which is what the old comment assumed it
    // would not.
    const dir = tempDir('thread-redelivery');
    try {
      const { thread } = await makeThread(dir);
      const promise = thread.runTurn('do the thing');
      thread.observe(sessionSet('t1', 2, 'turn-1'));
      thread.observe(assistantMessage('t1', 3, 'DONE'));
      // The socket dropped and resubscribed from the applied cursor; the server
      // replays what it already sent.
      thread.observe(sessionSet('t1', 2, 'turn-1'));
      thread.observe(assistantMessage('t1', 3, 'DONE'));
      thread.observe(sessionSet('t1', 4, null));

      const outcome = await promise;
      expect(outcome.text).toBe('DONE');
      expect(thread.events).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a redelivered event does not consume a second slot of the retention cap', async () => {
    // The other half of the same defect: a replay used to evict live events to
    // make room for copies of events already held, so `textTruncated` could go
    // true without a single event having been lost.
    const dir = tempDir('thread-redelivery-cap');
    try {
      const { thread } = await makeThread(dir, { retainEvents: 2 });
      thread.observe(assistantMessage('t1', 1, 'a'));
      thread.observe(assistantMessage('t1', 2, 'b'));
      thread.observe(assistantMessage('t1', 1, 'a'));
      thread.observe(assistantMessage('t1', 2, 'b'));

      expect(thread.droppedEvents).toBe(0);
      expect(assistantText(thread.events, 't1', 0)).toBe('ab');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains a worktree file that could not be merged as a warning', async () => {
    // `applyWorktreeSetup` leaves unparseable JSON alone rather than destroying a
    // user's config. That is only defensible if the skip is reported, and
    // `create` used to pass no `onWarning` at all — the same silence the module
    // refuses for a missing guard.
    const dir = tempDir('thread-setup-warning');
    try {
      const worktreePath = join(dir, 'worktree');
      mkdirSync(worktreePath, { recursive: true });
      writeFileSync(join(worktreePath, 'opencode.json'), '{ not json', 'utf-8');

      const seen: string[] = [];
      const { thread } = await makeThread(dir, {
        harnessName: 'opencode',
        worktreePath,
        roleContent: '# role',
        onSetupWarning: (message: string) => seen.push(message),
      });

      expect(thread.setupWarnings).toHaveLength(1);
      expect(thread.setupWarnings[0]).toContain('opencode.json');
      expect(seen).toEqual([...thread.setupWarnings]);
      // And the user's file is still theirs.
      expect(readFileSync(join(worktreePath, 'opencode.json'), 'utf-8')).toBe('{ not json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a phase check while a turn is active', async () => {
    const dir = tempDir('thread-check-guard');
    try {
      const { thread } = await makeThread(dir);
      const started = await thread.beginTurn('long job');
      thread.observe(sessionSet('t1', 2, 'turn-1'));
      await started.running;

      await expect(thread.runCheck('true')).rejects.toThrow(TurnActiveError);

      thread.observe(sessionSet('t1', 3, null));
      await started.settled;
      const result = await thread.runCheck('true');
      expect(result.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a file written externally between turns', async () => {
    const dir = tempDir('thread-external');
    try {
      const { thread, worktreePath } = await makeThread(dir);
      writeFileSync(join(worktreePath, 'external.txt'), 'TOKEN-42\n', 'utf-8');
      const result = await thread.runCheck('cat external.txt');
      expect(result.stdout.trim()).toBe('TOKEN-42');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks its text truncated when events fell off the cap', async () => {
    const dir = tempDir('thread-cap');
    try {
      const { thread } = await makeThread(dir, { retainEvents: 2 });
      thread.observe(assistantMessage('t1', 1, 'a'));
      thread.observe(assistantMessage('t1', 2, 'b'));
      thread.observe(assistantMessage('t1', 3, 'c'));
      expect(thread.droppedEvents).toBe(1);
      expect(thread.events).toHaveLength(2);
      const promise = thread.runTurn('x');
      thread.observe(sessionSet('t1', 4, 'turn-1'));
      thread.observe(sessionSet('t1', 5, null));
      // The text may be incomplete, and the flag says so rather than the empty
      // string implying the turn was silent.
      expect((await promise).textTruncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores events belonging to another thread', async () => {
    const dir = tempDir('thread-isolation');
    try {
      const { thread } = await makeThread(dir);
      thread.observe(assistantMessage('t2', 1, 'not mine'));
      expect(thread.events).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out with a message that does not claim the turn finished', async () => {
    const dir = tempDir('thread-timeout');
    try {
      const { thread } = await makeThread(dir);
      await expect(thread.runTurn('x', { timeoutMs: 20 })).rejects.toThrow(/still be running/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spends ONE budget across a turn, not one per wait', async () => {
    // Two waits each holding the full budget made `timeoutMs: 60_000` take up to
    // 120 seconds — a timeout that does not bound what the caller asked it to.
    const dir = tempDir('thread-one-budget');
    try {
      const { thread } = await makeThread(dir);
      const started = Date.now();
      const promise = thread.runTurn('x', { timeoutMs: 400 });
      // Running arrives late in the budget; settling never does. With one shared
      // budget the whole call ends at ~400ms. With a budget per wait it ends at
      // ~750ms, so the bound below is what separates them.
      setTimeout(() => thread.observe(sessionSet('t1', 2, 'turn-1')), 350);
      await expect(promise).rejects.toThrow(/still be running/);
      expect(Date.now() - started).toBeLessThan(600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a displaced waiter rather than leaving it unresolved forever', async () => {
    // Only one turn is tracked per thread, so a second `expectTurn` replaced the
    // first waiter and the promises it had handed out could never settle either
    // way. "Nobody will ever tell you" spelled exactly like "still running".
    const tracker = new TurnTracker();
    const first = tracker.expectTurn('t1');
    tracker.expectTurn('t1');

    await expect(first.running).rejects.toThrow(TurnDisplacedError);
    await expect(first.settled).rejects.toThrow(TurnDisplacedError);
  });

  it('lists no opencode instructions when there is no role file to point at', () => {
    const withRole = planWorktreeSetup('opencode', { worktreePath: '/tmp/w', roleContent: '# role' });
    const without = planWorktreeSetup('opencode', { worktreePath: '/tmp/w' });

    const read = (plan: typeof withRole) =>
      JSON.parse(plan.files.find((f) => f.relativePath === 'opencode.json')!.content).instructions;

    expect(read(withRole)).toEqual(['.builder-role.md']);
    // Not a harmless extra entry: it would describe instructions nobody supplied.
    expect(read(without)).toEqual([]);
    expect(without.files.some((f) => f.relativePath === '.builder-role.md')).toBe(false);
  });

  it('bounds the DISPATCH too, not only the waits after it', async () => {
    // The budget used to start after `thread.turn.start` returned, so a dispatch
    // that hung sat outside it entirely and `runTurn` never returned at all — the
    // same defect as the doubled budget, one call earlier, and invisible to a test
    // whose dispatcher answers instantly.
    const dir = tempDir('thread-dispatch-budget');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const worktreePath = join(dir, 'worktree');
      mkdirSync(worktreePath, { recursive: true });
      let hang = false;
      const dispatcher = {
        async call() {
          if (hang) await new Promise(() => {});
          return {};
        },
      };
      const thread = await DriverThread.create(
        { dispatcher, journal, tracker: new TurnTracker() },
        {
          projectId: 'p1',
          title: 'a builder',
          harnessName: 'codex',
          model: 'gpt-5.6-luna',
          worktreePath,
          branch: 'builder/x',
          threadId: 't1',
        },
      );

      hang = true;
      const started = Date.now();
      await expect(thread.runTurn('x', { timeoutMs: 400 })).rejects.toThrow(/dispatched/);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a worktree result the server did not fill in', async () => {
    await expect(
      createWorktree({ async call() { return {}; } }, { cwd: '/repo', newRefName: 'b' }),
    ).rejects.toThrow(/no usable worktree/);
  });

  it('creates the worktree with the requested branch', async () => {
    const dispatcher = recordingDispatcher(() => ({ worktree: { path: '/wt', refName: 'b' } }));
    const created = await createWorktree(dispatcher, { cwd: '/repo', newRefName: 'b' });
    expect(created).toEqual({ path: '/wt', refName: 'b' });
    expect(dispatcher.calls[0].payload).toEqual({ cwd: '/repo', refName: 'HEAD', newRefName: 'b', path: null });
  });
});
