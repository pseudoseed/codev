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
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { DriverThread } from '../../../../porch-driver/src/thread.js';
import { createPorchThreadEngine } from './helpers/porch-thread-engine.js';
import { createMemoryThreadEngine } from '../thread-runtime.js';

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
