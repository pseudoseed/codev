/**
 * Issue #271 — `createArchitectThread` names the role at the seam.
 *
 * The live test in `issue-271-architect-role-live.e2e.test.ts` proves the whole
 * chain, and it skips without `T3_NODE` and a clean fork checkout — so CI never
 * runs it. A guard that cannot run reads exactly like a guard that passed, which
 * is the shape of the failure this issue is about, so the same regression is
 * pinned here as well by a test that runs everywhere.
 *
 * This is the ONE seam neither test can substitute for the other on. The live
 * test cannot say WHERE a lost role was lost; this one says nothing about
 * whether the server stores it. Both, or neither is enough.
 *
 * The engine is a fake registered through `setThreadEngine` — the same
 * registration production uses — rather than a hand-built call to `engine.create`.
 * A test that called the engine itself would be asserting its own argument.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  clearThreadEngines,
  createArchitectThread,
  setThreadEngine,
  type ThreadEngine,
} from '../thread-runtime.js';

type CreateInput = Parameters<ThreadEngine['create']>[0];

function recordingEngine(): { engine: ThreadEngine; creates: CreateInput[] } {
  const creates: CreateInput[] = [];
  const engine = {
    defaults: { harness: 'claude', model: 'claude-opus-5' },
    async create(input: CreateInput) {
      creates.push(input);
      return 'thr-architect-1';
    },
    async attach() { throw new Error('attach is not part of this seam'); },
    async startTurn() { throw new Error('startTurn is not part of this seam'); },
    async recoverTurn() { throw new Error('recoverTurn is not part of this seam'); },
    async interrupt() { throw new Error('interrupt is not part of this seam'); },
  } as unknown as ThreadEngine;
  return { engine, creates };
}

afterEach(() => {
  clearThreadEngines();
});

describe('issue 271: createArchitectThread hands the engine a role', () => {
  it("passes role: 'architect' through to engine.create", async () => {
    const { engine, creates } = recordingEngine();
    setThreadEngine(engine, '/ws');

    const threadId = await createArchitectThread({ name: 'lan', workspaceRoot: '/ws' });

    expect(threadId).toBe('thr-architect-1');
    expect(creates).toHaveLength(1);
    // The assertion the issue is about. Without it the thread is created, the row
    // is written, the command succeeds — and t3code's sidebar draws an ordinary
    // thread that nothing can nest under.
    expect(creates[0]?.role).toBe('architect');
  });

  /**
   * `parentThreadId` stays ABSENT, not null. An architect has no parent, and the
   * server refuses a parent on a non-builder — so a null here would be a value
   * the create path cannot carry, not a tidier way to say "none".
   */
  it('names no parent for an architect', async () => {
    const { engine, creates } = recordingEngine();
    setThreadEngine(engine, '/ws');

    await createArchitectThread({ name: 'lan', workspaceRoot: '/ws' });

    expect(creates[0]).not.toHaveProperty('parentThreadId');
  });

  it('creates the thread at the workspace root, which is what makes it an architect', async () => {
    const { engine, creates } = recordingEngine();
    setThreadEngine(engine, '/ws');

    await createArchitectThread({ name: 'lan', workspaceRoot: '/ws' });

    expect(creates[0]?.worktreePath).toBe('/ws');
    expect(creates[0]?.builderId).toBe('architect-lan');
  });
});
