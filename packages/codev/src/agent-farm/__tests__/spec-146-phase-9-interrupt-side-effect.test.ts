/**
 * Spec 146 Phase 9, issue #179 item 5 — the SECOND half of the interrupt criterion.
 *
 * The plan states it as two clauses: `afx interrupt` on a running turn leaves
 * `activeTurnId: null` AND the interrupted command's side effect absent. Only the
 * first was asserted. `createMemoryThreadEngine` cannot assert the second, because
 * its `startTurn` records a turn id and runs nothing — there is no side effect for
 * an interrupt to prevent.
 *
 * This file closes that with a process-backed engine: `startTurn` spawns a real
 * child that writes STARTED, sleeps, then writes SHOULD_NOT_FINISH; `interrupt`
 * kills it. The assertion is the one the plan's `SHOULD_NOT_FINISH` spike is named
 * for, and it runs in CI on every platform, with no server and no network.
 *
 * WHAT THIS DOES NOT PROVE: that t3code's `thread.turn.interrupt` kills a provider's
 * command. That claim needs a live server and is asserted by
 * `spec-146-phase-9-live-harness.test.ts`, which skips loudly when it cannot check.
 * This test proves the seam — `interruptThread` → `ThreadEngine.interrupt` — actually
 * stops running work rather than only clearing a field.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deliverThreadTurn,
  interruptThread,
  setThreadEngine,
  type ThreadEngine,
  type ThreadRecord,
} from '../thread-runtime.js';

/** A ThreadEngine whose turns are real child processes, so an interrupt has something to stop. */
function createProcessThreadEngine(): ThreadEngine & { exited(threadId: string): Promise<void> } {
  const records = new Map<string, ThreadRecord>();
  const children = new Map<string, ChildProcess>();
  const exits = new Map<string, Promise<void>>();

  return {
    async create(input) {
      const threadId = `proc-${input.builderId}`;
      records.set(threadId, {
        threadId,
        worktreePath: input.worktreePath,
        branch: input.branch,
        builderId: input.builderId,
        activeTurnId: null,
        merged: false,
        launched: true,
      });
      return threadId;
    },

    /**
     * Issue #219 added `attach` to `ThreadEngine` so a double could not diverge from
     * the contract — and this double diverged from it in the same commit, silently:
     * `packages/codev/tsconfig.json` excludes `**\/__tests__/**`, the package has no
     * check-types script, and CI typechecks only `packages/types`, so a missing member
     * on a `ThreadEngine &` annotation is a type error nothing ever runs. See #210.
     *
     * Real here, not a stub: an attached thread is one this engine did not create, so
     * it has no child process and nothing to interrupt until a turn starts.
     */
    async attach(input) {
      const existing = records.get(input.threadId);
      if (existing) return existing;
      const record: ThreadRecord = {
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        branch: input.branch,
        builderId: input.builderId,
        activeTurnId: null,
        merged: false,
        launched: true,
      };
      records.set(input.threadId, record);
      return record;
    },

    // #219 round 7: this engine's turns are child processes with no dispatch journal, so
    // nothing here is ever ambiguous. `none` is the truthful answer, not a stub — and the
    // interface requires it so a double cannot quietly omit it (see #210).
    async recoverTurn() {
      return 'none';
    },

    async startTurn(threadId, text) {
      const record = records.get(threadId);
      if (!record) throw new Error(`Unknown thread ${threadId}`);
      const child = spawn('/bin/sh', ['-c', text], { stdio: 'ignore' });
      children.set(threadId, child);
      exits.set(threadId, new Promise<void>((res) => child.once('exit', () => res())));
      record.activeTurnId = `turn-${threadId}`;
    },

    async interrupt(threadId) {
      const record = records.get(threadId);
      if (!record) throw new Error(`Unknown thread ${threadId}`);
      children.get(threadId)?.kill('SIGKILL');
      record.activeTurnId = null;
      return { activeTurnId: null };
    },

    worktreePath(threadId) {
      return records.get(threadId)?.worktreePath;
    },

    async removeWorktree(threadId) {
      records.delete(threadId);
      return 'removed';
    },

    get(threadId) {
      return records.get(threadId);
    },

    /** Resolves once the child has actually exited — no sleep-and-hope. */
    async exited(threadId) {
      await exits.get(threadId);
    },
  };
}

describe('Spec 146 Phase 9 — interrupt leaves the command\'s side effect absent (#179 item 5)', () => {
  let dir: string | undefined;

  afterEach(() => {
    setThreadEngine(undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('kills the running turn: activeTurnId is null AND SHOULD_NOT_FINISH was never written', async () => {
    dir = mkdtempSync(join(tmpdir(), 'phase9-interrupt-'));
    const started = join(dir, 'STARTED');
    const marker = join(dir, 'SHOULD_NOT_FINISH');
    const engine = createProcessThreadEngine();
    setThreadEngine(engine);

    const threadId = await engine.create({
      builderId: 'air-173',
      worktreePath: dir,
      branch: 'builder/air-173',
    });
    await deliverThreadTurn(
      threadId,
      `touch "${started}"; sleep 30; touch "${marker}"`,
    );

    // Poll for the command to actually be running, then interrupt in that window.
    const deadline = Date.now() + 10_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(started)).toBe(true);
    expect(engine.get(threadId)?.activeTurnId).not.toBeNull();

    const settled = await interruptThread(threadId);

    expect(settled.activeTurnId).toBeNull();
    expect(engine.get(threadId)?.activeTurnId).toBeNull();

    // Wait on the process exiting rather than on a timer, then assert the sleep never
    // completed. A `sleep 30` that survived the interrupt would still be running here.
    await engine.exited(threadId);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('without the interrupt the same turn DOES write the marker — the assertion can fail', async () => {
    dir = mkdtempSync(join(tmpdir(), 'phase9-interrupt-control-'));
    const marker = join(dir, 'SHOULD_NOT_FINISH');
    const engine = createProcessThreadEngine();
    setThreadEngine(engine);

    const threadId = await engine.create({
      builderId: 'air-173-control',
      worktreePath: dir,
      branch: 'builder/air-173',
    });
    await deliverThreadTurn(threadId, `sleep 0.2; touch "${marker}"`);
    await engine.exited(threadId);

    expect(existsSync(marker)).toBe(true);
  }, 30_000);
});
