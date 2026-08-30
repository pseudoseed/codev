/**
 * Issue #219 — the deterministic half of #179 items 3 and 4.
 *
 * The live run is in `spec-146-phase-9-live-architect-thread.test.ts` and needs a
 * server. These do not, and they pin the two defects the live run exposed:
 *
 *  - an architect's empty branch was sent as `''`, which t3code refuses, so no
 *    architect thread could ever be created against a real server;
 *  - the engine could only `create`, so nothing could resume a thread that
 *    outlived the process which made it.
 *
 * Both were invisible to the existing suite: `createMemoryThreadEngine` does not
 * validate a payload it never sends, and no test asked an engine to adopt a
 * thread it had not created.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchJournal } from '@cluesmith/porch-driver/commands';
import { TurnTracker } from '@cluesmith/porch-driver/turn';
import { DriverThread } from '@cluesmith/porch-driver/thread';
import { createPorchThreadEngine } from './helpers/porch-thread-engine.js';
import { createMemoryThreadEngine, deliverThreadTurn, setThreadEngine, clearThreadEngines } from '../thread-runtime.js';

function recordingDispatcher() {
  const calls: Array<{ method: string; payload: unknown }> = [];
  return {
    calls,
    async call(method: string, payload: unknown) {
      calls.push({ method, payload });
      return {};
    },
  };
}

function payloads(dispatcher: ReturnType<typeof recordingDispatcher>, type: string) {
  return dispatcher.calls
    .map((c) => c.payload as Record<string, unknown>)
    .filter((p) => p.type === type);
}

function scratch(): { dir: string; worktreePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'air-219-'));
  const worktreePath = join(dir, 'wt');
  mkdirSync(worktreePath);
  return { dir, worktreePath };
}

function engineOn(dispatcher: ReturnType<typeof recordingDispatcher>, root: string) {
  return createPorchThreadEngine({
    dispatcher,
    journal: new DispatchJournal(join(root, 'commands.jsonl')),
    tracker: new TurnTracker(),
    projectId: 'p1',
    workspaceRoot: root,
    defaultHarness: 'codex',
    defaultModel: 'gpt-5.6-luna',
  });
}

describe('#179 item 3 — an architect thread is created with no branch, not an empty one', () => {
  /**
   * The defect that made item 3 impossible rather than merely unrun.
   *
   * `createArchitectThread` says "no branch" with `''` because `ThreadRecord.branch`
   * is a plain string. t3code's `thread.create` types `branch` as
   * `NullOr(TrimmedNonEmptyString)`, so `''` is a value it refuses — and it refuses
   * it as a `Die` quoting a schema path, which reads as a client bug of some other
   * kind. Observed against the pinned server before the fix:
   *
   *   Die: Expected a value with a length of at least 1
   *     at ["branch"]
   */
  it('sends branch: null for an architect, and the real branch for a builder', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = recordingDispatcher();
      const engine = engineOn(dispatcher, dir);

      await engine.create({ builderId: 'architect-main', worktreePath: dir, branch: '', role: 'architect' });
      await engine.create({ builderId: 'air-219', worktreePath, branch: 'builder/air-219' });

      const created = payloads(dispatcher, 'thread.create');
      expect(created).toHaveLength(2);
      // `null`, not `''` and not absent: absent is a different refusal, and `''`
      // is the one that was shipping.
      expect(created[0].branch).toBeNull();
      expect(created[0].worktreePath).toBe(dir);
      expect(created[1].branch).toBe('builder/air-219');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the architect thread the engine records is rooted at the workspace root', async () => {
    const { dir } = scratch();
    try {
      const dispatcher = recordingDispatcher();
      const engine = engineOn(dispatcher, dir);
      const threadId = await engine.create({
        builderId: 'architect-main',
        worktreePath: dir,
        branch: '',
        role: 'architect',
      });
      expect(engine.worktreePath(threadId)).toBe(dir);
      expect(engine.get(threadId)?.branch).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#179 item 4 — an engine can adopt a thread it did not create', () => {
  it('attach dispatches no thread.create', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = recordingDispatcher();
      const engine = engineOn(dispatcher, dir);

      const record = await engine.attach({
        threadId: 'thr-from-before-the-restart',
        worktreePath,
        branch: '',
        builderId: 'architect-main',
      });

      // The whole point. `create` would mint a second thread and re-apply the
      // worktree setup over a tree an agent has been working in.
      expect(payloads(dispatcher, 'thread.create')).toHaveLength(0);
      expect(record.threadId).toBe('thr-from-before-the-restart');
      expect(record.worktreePath).toBe(worktreePath);
      expect(engine.worktreePath('thr-from-before-the-restart')).toBe(worktreePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a turn on an attached thread carries the caller text and no role', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = recordingDispatcher();
      const engine = engineOn(dispatcher, dir);
      await engine.attach({
        threadId: 'thr-resumed',
        worktreePath,
        branch: '',
        builderId: 'architect-main',
      });

      await engine.startTurn('thr-resumed', 'WHAT WAS THE CODEWORD');

      const starts = payloads(dispatcher, 'thread.turn.start');
      expect(starts).toHaveLength(1);
      expect(starts[0].threadId).toBe('thr-resumed');
      const text = ((starts[0].message ?? {}) as { text?: string }).text ?? JSON.stringify(starts[0]);
      expect(text).toContain('WHAT WAS THE CODEWORD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attach is idempotent and does not replace a thread already being tracked', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = recordingDispatcher();
      const engine = engineOn(dispatcher, dir);
      const threadId = await engine.create({
        builderId: 'air-219',
        worktreePath,
        branch: 'builder/air-219',
      });

      const record = await engine.attach({
        threadId,
        // Deliberately wrong: a second attach must not overwrite what create knows.
        worktreePath: '/somewhere/else',
        branch: 'other',
        builderId: 'someone-else',
      });

      expect(record.worktreePath).toBe(worktreePath);
      expect(record.builderId).toBe('air-219');
      expect(payloads(dispatcher, 'thread.create')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * "I have not been told about this thread" and "there is no such thread" are
   * different facts, and the message must not merge them — that is the standing
   * rule this repo applies at every seam where a check reports a value it was not
   * positioned to observe.
   */
  it('a turn on an unattached thread names the limitation rather than denying the thread', async () => {
    const { dir } = scratch();
    try {
      const engine = engineOn(recordingDispatcher(), dir);
      await expect(engine.startTurn('thr-never-seen', 'hello')).rejects.toThrow(/attach/);
      await expect(engine.startTurn('thr-never-seen', 'hello')).rejects.toThrow(
        /not evidence that the thread does not exist/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the in-memory engine attaches too, so a test double cannot diverge from the contract', async () => {
    const engine = createMemoryThreadEngine();
    const record = await engine.attach({
      threadId: 'thr-x',
      worktreePath: '/ws',
      branch: '',
      builderId: 'architect-main',
    });
    expect(record.worktreePath).toBe('/ws');
    // An attached thread was launched before this process existed. `false` would
    // be a claim about the thread, not about this engine's memory of it.
    expect(record.launched).toBe(true);
    await expect(engine.startTurn('thr-x', 'hi')).resolves.toBeUndefined();
  });
});

describe('DriverThread.attach', () => {
  it('is not create: it dispatches nothing and delivers no role', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = recordingDispatcher();
      const thread = DriverThread.attach(
        {
          dispatcher,
          journal: new DispatchJournal(join(dir, 'commands.jsonl')),
          tracker: new TurnTracker(),
        },
        {
          threadId: 'thr-attached',
          harnessName: 'codex',
          defaultModel: 'gpt-5.6-luna',
          worktreePath,
          branch: '',
        },
      );

      expect(dispatcher.calls).toHaveLength(0);
      expect(thread.threadId).toBe('thr-attached');
      expect(thread.worktreePath).toBe(worktreePath);
      // A thread that exists has already had its first turn; re-delivering the
      // role would repeat instructions the agent already holds.
      expect(thread.roleDelivered).toBe(true);
      // Its event log is empty because this process holds no subscription — that
      // is "I have not been told", not "nothing happened".
      expect(thread.events).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on an unmappable harness at attach, not at the first turn', () => {
    const { dir, worktreePath } = scratch();
    try {
      expect(() =>
        DriverThread.attach(
          {
            dispatcher: recordingDispatcher(),
            journal: new DispatchJournal(join(dir, 'commands.jsonl')),
            tracker: new TurnTracker(),
          },
          { threadId: 't', harnessName: 'gemini', defaultModel: 'x', worktreePath, branch: '' },
        ),
      ).toThrow(/retired/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #219 round 7 — a message could run TWICE.
 *
 * `dispatchCommand` deliberately leaves an UNANSWERED command pending: a dead socket or a
 * timed-out request does not say whether the server applied it, and journalling that as
 * failed would spell "I could not tell" exactly like "no". So a turn whose acknowledgement
 * was lost is still, as far as anyone knows, running.
 *
 * The mailbox then held the row and a later tick submitted the same message again — and
 * `startTurn` mints a FRESH `commandId` per call, so t3code, which collapses duplicates by
 * `commandId`, saw two different commands and ran the turn twice. For a builder that is two
 * PRs, or the same destructive instruction carried out twice.
 *
 * The in-flight guard from round 6 does not cover this: it prevents a retry while the
 * original promise is UNSETTLED, and an ambiguous rejection settles it.
 *
 * `recoverPendingCommands` — which existed, was tested, and had no production caller — is
 * the fix, and this is what gives it one.
 */
describe('an unacknowledged turn is replayed, not repeated', () => {
  function ambiguousThenRecording() {
    const calls: Array<Record<string, unknown>> = [];
    let failNext = true;
    return {
      calls,
      allowNext() { failNext = false; },
      async call(_method: string, payload: unknown) {
        calls.push(payload as Record<string, unknown>);
        if (failNext) {
          // The server APPLIED it and the client heard nothing. Not an `RpcFailureError`,
          // so `isServerRefusal` is false and the intent stays pending — which is the
          // correct, deliberate behaviour this test is built on top of.
          const err = new Error('socket closed before the reply arrived');
          err.name = 'NotConnectedError';
          throw err;
        }
        return {};
      },
    };
  }

  it('a later tick replays the ORIGINAL command id instead of minting a new one', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = ambiguousThenRecording();
      const engine = engineOn(dispatcher as never, dir);
      await engine.attach({ threadId: 'thr-1', worktreePath, branch: '', builderId: 'air-219' });
      setThreadEngine(engine, dir);

      // Tick 1: the turn is applied by the server and the acknowledgement is lost.
      await expect(deliverThreadTurn('thr-1', 'DO THE THING', dir, 'row-1')).rejects.toThrow(/socket closed/);

      const first = dispatcher.calls.filter((c) => c.type === 'thread.turn.start');
      expect(first).toHaveLength(1);
      const originalId = first[0].commandId as string;

      // Tick 2: the row is still held, so the mailbox tries again.
      dispatcher.allowNext();
      await expect(deliverThreadTurn('thr-1', 'DO THE THING', dir, 'row-1')).resolves.toBe('recovered');

      const starts = dispatcher.calls.filter((c) => c.type === 'thread.turn.start');
      expect(starts).toHaveLength(2);
      // THE assertion. Two dispatches, ONE command id — so t3code, which keys its receipt
      // on `commandId`, has exactly one turn. A fresh id here is the duplicate.
      expect(starts[1].commandId).toBe(originalId);
      expect(new Set(starts.map((c) => c.commandId)).size).toBe(1);
    } finally {
      clearThreadEngines();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a third tick after a successful replay issues nothing further', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = ambiguousThenRecording();
      const engine = engineOn(dispatcher as never, dir);
      await engine.attach({ threadId: 'thr-1', worktreePath, branch: '', builderId: 'air-219' });
      setThreadEngine(engine, dir);

      await expect(deliverThreadTurn('thr-1', 'DO THE THING', dir, 'row-1')).rejects.toThrow();
      dispatcher.allowNext();
      await deliverThreadTurn('thr-1', 'DO THE THING', dir, 'row-1');
      const afterReplay = dispatcher.calls.length;

      // The replay journalled an outcome, so nothing is pending any more — and this call
      // is a genuinely new send rather than a recovery.
      await expect(deliverThreadTurn('thr-1', 'DO THE THING', dir, 'row-1')).resolves.toBe('delivered');
      expect(dispatcher.calls.length).toBe(afterReplay + 1);
    } finally {
      clearThreadEngines();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A refusal is settled: the server answered, and answered no. Replaying it would repeat
   * a decision that was already made, so it must NOT be recovered — a fresh submit is the
   * correct behaviour, and the two must not be confused.
   */
  it('a refused turn is not treated as ambiguous', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const calls: Array<Record<string, unknown>> = [];
      let refuse = true;
      const dispatcher = {
        calls,
        async call(_m: string, payload: unknown) {
          calls.push(payload as Record<string, unknown>);
          if (refuse) {
            const err = new Error('the server said no');
            err.name = 'RpcFailureError';
            throw err;
          }
          return {};
        },
      };
      const engine = engineOn(dispatcher as never, dir);
      await engine.attach({ threadId: 'thr-1', worktreePath, branch: '', builderId: 'air-219' });
      setThreadEngine(engine, dir);

      await expect(deliverThreadTurn('thr-1', 'DO THE THING', dir, 'row-1')).rejects.toThrow(/said no/);
      refuse = false;
      await expect(deliverThreadTurn('thr-1', 'DO THE THING', dir, 'row-1')).resolves.toBe('delivered');

      const starts = calls.filter((c) => c.type === 'thread.turn.start');
      expect(starts).toHaveLength(2);
      // Two distinct ids, deliberately: the first was refused and settled, so the second
      // is a new intent rather than a replay of a decided one.
      expect(new Set(starts.map((c) => c.commandId)).size).toBe(2);
    } finally {
      clearThreadEngines();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a different message on the same thread is not mistaken for the pending one', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = ambiguousThenRecording();
      const engine = engineOn(dispatcher as never, dir);
      await engine.attach({ threadId: 'thr-1', worktreePath, branch: '', builderId: 'air-219' });
      setThreadEngine(engine, dir);

      await expect(deliverThreadTurn('thr-1', 'FIRST MESSAGE', dir, 'row-1')).rejects.toThrow();
      dispatcher.allowNext();

      // A different ROW must be sent, not collapsed into the pending one.
      await expect(deliverThreadTurn('thr-1', 'SECOND MESSAGE', dir, 'row-2')).resolves.toBe('delivered');
      const starts = dispatcher.calls.filter((c) => c.type === 'thread.turn.start');
      const texts = starts.map((c) => ((c.message as { text?: string } | undefined)?.text));
      expect(texts).toContain('FIRST MESSAGE');
      expect(texts).toContain('SECOND MESSAGE');
    } finally {
      clearThreadEngines();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #219 round 8. The round-7 fix had two independent holes, found by two lanes that
 * did not see each other, and both produced the outcome it existed to prevent.
 *
 * These are the tests neither of us had. The one-thread tests above cannot see either
 * defect, which is why they passed.
 */
describe('recovery identifies its own intent and touches nothing else', () => {
  function ambiguous() {
    const calls: Array<Record<string, unknown>> = [];
    let failNext = true;
    return {
      calls,
      allowNext() { failNext = false; },
      failAgain() { failNext = true; },
      async call(_method: string, payload: unknown) {
        calls.push(payload as Record<string, unknown>);
        if (failNext) {
          const err = new Error('socket closed before the reply arrived');
          err.name = 'NotConnectedError';
          throw err;
        }
        return {};
      },
    };
  }

  /**
   * HOLE 1 — matching on message text.
   *
   * Two identical messages to one agent are ordinary: a retried instruction, a repeated
   * nudge, any templated notice. Text matching let a STALE intent answer for the current
   * message, so delivery reported `recovered` — and the caller marked the row delivered —
   * for a message that had never been submitted. That is the worse direction: a duplicate
   * turn is visible and recoverable, a false "delivered" is neither.
   */
  it('a second row with IDENTICAL text is not answered by the first row\'s stale intent', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = ambiguous();
      const engine = engineOn(dispatcher as never, dir);
      await engine.attach({ threadId: 'thr-1', worktreePath, branch: '', builderId: 'air-219' });
      setThreadEngine(engine, dir);

      // Row 1's turn is applied and its acknowledgement is lost.
      await expect(deliverThreadTurn('thr-1', 'PLEASE PROCEED', dir, 'row-1')).rejects.toThrow();
      dispatcher.allowNext();

      // Row 2 is a DIFFERENT message that happens to read the same.
      await expect(deliverThreadTurn('thr-1', 'PLEASE PROCEED', dir, 'row-2')).resolves.toBe('delivered');

      const starts = dispatcher.calls.filter((c) => c.type === 'thread.turn.start');
      // Two distinct commands, because they are two distinct messages. Under text
      // matching the second returned `recovered` having sent nothing.
      expect(starts).toHaveLength(2);
      expect(new Set(starts.map((c) => c.commandId)).size).toBe(2);
    } finally {
      clearThreadEngines();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * HOLE 2 — draining the workspace journal.
   *
   * Round 6 made submissions concurrent across agents, so two lost acknowledgements in
   * one workspace is a state this code can produce. Replaying every pending intent marked
   * the SIBLING's dispatched while its mailbox row was still held — so its next tick found
   * nothing pending, minted a fresh command id, and produced the duplicate turn one agent
   * over.
   */
  it('recovering one thread does not settle another thread\'s pending intent', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = ambiguous();
      const engine = engineOn(dispatcher as never, dir);
      await engine.attach({ threadId: 'thr-a', worktreePath, branch: '', builderId: 'air-a' });
      await engine.attach({ threadId: 'thr-b', worktreePath, branch: '', builderId: 'air-b' });
      setThreadEngine(engine, dir);

      // BOTH lose their acknowledgement — the concurrent case round 6 made possible.
      await expect(deliverThreadTurn('thr-a', 'A MESSAGE', dir, 'row-a')).rejects.toThrow();
      await expect(deliverThreadTurn('thr-b', 'B MESSAGE', dir, 'row-b')).rejects.toThrow();
      dispatcher.allowNext();

      // Recover A only.
      await expect(deliverThreadTurn('thr-a', 'A MESSAGE', dir, 'row-a')).resolves.toBe('recovered');

      // B's intent must still be pending, so B recovers rather than re-sending. THE
      // assertion: no second command id for B.
      await expect(deliverThreadTurn('thr-b', 'B MESSAGE', dir, 'row-b')).resolves.toBe('recovered');

      const bStarts = dispatcher.calls.filter(
        (c) => c.type === 'thread.turn.start' && c.threadId === 'thr-b',
      );
      expect(bStarts).toHaveLength(2);
      expect(new Set(bStarts.map((c) => c.commandId)).size).toBe(1);
    } finally {
      clearThreadEngines();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a replay that is itself unanswered leaves the intent pending for the next attempt', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const dispatcher = ambiguous();
      const engine = engineOn(dispatcher as never, dir);
      await engine.attach({ threadId: 'thr-1', worktreePath, branch: '', builderId: 'air-219' });
      setThreadEngine(engine, dir);

      await expect(deliverThreadTurn('thr-1', 'DO IT', dir, 'row-1')).rejects.toThrow();
      // The replay also gets no answer. It must NOT settle the intent — an unanswered
      // replay is as ambiguous as the original.
      await expect(deliverThreadTurn('thr-1', 'DO IT', dir, 'row-1')).rejects.toThrow();

      dispatcher.allowNext();
      await expect(deliverThreadTurn('thr-1', 'DO IT', dir, 'row-1')).resolves.toBe('recovered');

      const starts = dispatcher.calls.filter((c) => c.type === 'thread.turn.start');
      expect(starts).toHaveLength(3);
      // Three dispatches, one command id: the server collapses all of them.
      expect(new Set(starts.map((c) => c.commandId)).size).toBe(1);
    } finally {
      clearThreadEngines();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a refused replay settles the intent, so the next attempt is a new command', async () => {
    const { dir, worktreePath } = scratch();
    try {
      const calls: Array<Record<string, unknown>> = [];
      let mode: 'lose' | 'refuse' | 'ok' = 'lose';
      const dispatcher = {
        async call(_m: string, payload: unknown) {
          calls.push(payload as Record<string, unknown>);
          if (mode === 'lose') {
            const err = new Error('socket closed'); err.name = 'NotConnectedError'; throw err;
          }
          if (mode === 'refuse') {
            const err = new Error('the server said no'); err.name = 'RpcFailureError'; throw err;
          }
          return {};
        },
      };
      const engine = engineOn(dispatcher as never, dir);
      await engine.attach({ threadId: 'thr-1', worktreePath, branch: '', builderId: 'air-219' });
      setThreadEngine(engine, dir);

      await expect(deliverThreadTurn('thr-1', 'DO IT', dir, 'row-1')).rejects.toThrow();
      mode = 'refuse';
      // The replay is REFUSED — the server answered, and answered no. That is settled.
      await expect(deliverThreadTurn('thr-1', 'DO IT', dir, 'row-1')).rejects.toThrow(/said no/);
      mode = 'ok';
      // Nothing is pending any more, so this is a genuinely new send.
      await expect(deliverThreadTurn('thr-1', 'DO IT', dir, 'row-1')).resolves.toBe('delivered');

      const starts = calls.filter((c) => c.type === 'thread.turn.start');
      expect(starts).toHaveLength(3);
      expect(new Set(starts.map((c) => c.commandId)).size).toBe(2);
    } finally {
      clearThreadEngines();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
