/**
 * Issue #260 — a session refusal must FAIL the spawn, not just be logged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchJournal } from '../../../../porch-driver/src/commands.js';
import { TurnTracker } from '../../../../porch-driver/src/turn.js';
import { createPorchThreadEngine } from '../porch-thread-engine.js';
import { createThreadSubscriptionPool, type ThreadSubscriber } from '../thread-subscriptions.js';

function scriptedSubscriber() {
  let live: { onValue: (v: unknown) => void; end: () => void } | null = null;
  let nextId = 1;
  const subscriber: ThreadSubscriber = {
    stream(_method, _payload, onValue, _timeoutMs, onRequestId) {
      onRequestId?.(nextId++);
      return new Promise<unknown>((resolveStream) => {
        live = { onValue, end: () => resolveStream(undefined) };
        queueMicrotask(() => onValue({ kind: 'synchronized' }));
      });
    },
    cancel: () => live?.end(),
  };
  return { subscriber, emit: (v: unknown) => live?.onValue(v) };
}

describe('bugfix 260', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('create fails when the server refuses the session', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bugfix-260-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath);
    const script = scriptedSubscriber();
    const engineRef: { current?: ReturnType<typeof createPorchThreadEngine> } = {};
    const pool = createThreadSubscriptionPool({
      subscriber: script.subscriber,
      workspaceRoot: dir,
      observe: (v) => engineRef.current?.observe(v),
      log: () => {},
      attachTimeoutMs: 2_000,
      retryDelayMs: 1,
    });

    let threadId = '';
    const engine = createPorchThreadEngine({
      dispatcher: {
        async call(_method: string, payload: unknown) {
          const command = (payload as { command?: Record<string, unknown> }).command ?? (payload as Record<string, unknown>);
          if (command?.type === 'thread.create') threadId = String(command.threadId);
          if (command?.type === 'thread.turn.start') {
            // The refusal the real server emits ~12ms after the dispatch.
            setTimeout(() => script.emit({
              kind: 'event',
              event: {
                sequence: 1,
                aggregateId: threadId,
                type: 'thread.session-set',
                eventId: 'e1',
                payload: { session: { status: 'error', lastError: "Provider instance 'opencode' is disabled in T3 Code settings.", activeTurnId: null } },
              },
            }), 5);
          }
          return {};
        },
      },
      journal: new DispatchJournal(join(dir, 'commands.jsonl')),
      tracker: new TurnTracker(),
      projectId: 'p1',
      workspaceRoot: dir,
      defaultHarness: 'codex',
      defaultModel: 'gpt-5.6-luna',
      subscriptions: pool,
    });
    engineRef.current = engine;

    await expect(engine.create({
      builderId: 'bugfix-260',
      worktreePath,
      branch: 'builder/bugfix-260',
      prompt: 'go',
    })).rejects.toThrow(/failed before the turn started/);

    pool.stopAll();
  });
});
