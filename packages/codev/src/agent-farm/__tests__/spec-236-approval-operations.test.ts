/**
 * The durable approval operation store (Spec 236, phase 4).
 *
 * ## What these tests are actually about
 *
 * An approval outlives its request, so this store is a client's only account of
 * work it can no longer watch. Two properties decide whether it is honest:
 *
 *  1. **A record left `running` by a dead host is resolved before anything can
 *     poll it**, so "running forever" is unreachable rather than unlikely; and
 *  2. **an interruption is not evidence the gate is unapproved.** The host may
 *     have died after porch wrote it, so `status.yaml` is READ and the answer says
 *     what it found — including "approved", which must never read as a failure.
 *
 * The resolution pass is scoped to this host's dead processes, and there is a
 * test for each half of that: another host's record is left alone, and so is one
 * this process itself owns.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_OPERATION_SIGNAL,
  ApprovalOperationStore,
  isTerminal,
  type ApprovalOperation,
  type OperationOwner,
} from '../lib/approval-operations.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'codev-236-ops-'));
  roots.push(root);
  return root;
}

const THIS_HOST = { host: 'tower-a', pid: 4242 };

function storeAt(root: string, over: {
  owner?: OperationOwner;
  now?: () => number;
  retentionMs?: number;
  isAlive?: (pid: number) => boolean;
} = {}): ApprovalOperationStore {
  return new ApprovalOperationStore({
    root,
    owner: over.owner ?? THIS_HOST,
    now: over.now,
    retentionMs: over.retentionMs,
    isAlive: over.isAlive ?? (() => false),
  });
}

function submit(store: ApprovalOperationStore, over: Partial<{
  workspacePath: string; projectId: string; gateName: string; sessionId: string;
}> = {}) {
  const result = store.submit({
    workspacePath: '/w',
    projectId: '236',
    gateName: 'pr',
    sessionId: 'session-1',
    ...over,
  });
  if (!result.accepted) throw new Error(`expected acceptance, got ${result.code}`);
  return result.operation;
}

describe('the six states are six answers', () => {
  it('records a submitted operation with its owner and its scope', () => {
    const store = storeAt(scratch());
    const operation = submit(store);
    expect(operation.state).toBe('submitted');
    expect(operation.owner).toEqual(THIS_HOST);
    expect(operation.projectId).toBe('236');
    expect(operation.sessionId).toBe('session-1');
    expect(isTerminal(operation.state)).toBe(false);
  });

  /*
   * "Running" with nothing beside it is a spinner, and a spinner is what a status
   * word becomes when it carries no content. An operator waiting on a build
   * deserves to know WHICH build.
   */
  it('names the phase and the checks while it runs', () => {
    const root = scratch();
    const store = storeAt(root);
    const operation = submit(store);
    store.markRunning(operation.operationId, { phase: 'review', checks: ['build', 'tests'] });

    const seen = store.describe(operation.operationId)!;
    expect(seen.state).toBe('running');
    expect(seen.phase).toBe('review');
    expect(seen.checks).toEqual(['build', 'tests']);
    expect(seen.startedAt).toBeDefined();
  });

  it('carries porch\'s persisted record on success, and builds nothing itself', () => {
    const root = scratch();
    const store = storeAt(root);
    const operation = submit(store);
    store.settle(operation.operationId, {
      state: 'succeeded',
      record: {
        machine: 'ipad',
        sessionId: 'session-other',
        approvedAt: '2026-08-29T10:00:00Z',
        authority: 'Chris, at the laptop',
        outcome: 'already-approved',
      },
    });

    const seen = store.describe(operation.operationId)!;
    expect(seen.state).toBe('succeeded');
    // The already-approved path reports SOMEBODY ELSE'S approval, and says so.
    // The route this replaces answered with the requesting session and a fresh
    // timestamp, claiming that session approved a gate it did not.
    expect(seen.record).toEqual({
      machine: 'ipad',
      sessionId: 'session-other',
      approvedAt: '2026-08-29T10:00:00Z',
      authority: 'Chris, at the laptop',
      outcome: 'already-approved',
    });
  });

  /*
   * A REFUSAL IS NOT A FAILURE. Porch declining because a precondition is unmet
   * is porch working correctly; collapsing the two would send an operator to
   * debug a host when the answer is that their checks did not pass.
   */
  it('keeps a refusal apart from a failure, and keeps porch\'s code', () => {
    const root = scratch();
    const store = storeAt(root);
    const refused = submit(store, { projectId: 'a' });
    const failed = submit(store, { projectId: 'b' });
    store.settle(refused.operationId, {
      state: 'refused', code: 'PHASE_CHECKS_FAILED', message: 'the review phase checks did not pass',
    });
    store.settle(failed.operationId, { state: 'failed', message: 'ENOSPC writing status.yaml' });

    expect(store.describe(refused.operationId)!.code).toBe('PHASE_CHECKS_FAILED');
    expect(store.describe(failed.operationId)!.code).toBeUndefined();
    expect(store.describe(failed.operationId)!.state).toBe('failed');
  });

  it('settling an operation it does not hold is a caller bug, not a new record', () => {
    const store = storeAt(scratch());
    expect(() => store.settle('no-such-operation', { state: 'failed', message: 'x' }))
      .toThrow(/APPROVAL_OPERATION_UNKNOWN/);
    expect(store.records()).toHaveLength(0);
  });

  it('answers null for an operation it has never held', () => {
    expect(storeAt(scratch()).describe('nothing')).toBeNull();
  });
});

describe('the concurrency bound refuses at submit time', () => {
  /*
   * NOT A QUEUE. A queue turns "I will not start this" into "this is running",
   * which is the conflation the whole spec is organised against — and it hides
   * the wait behind a word that says work is happening.
   */
  it('refuses a second approval for the same project, naming the live one', () => {
    const store = storeAt(scratch());
    const first = submit(store);
    const second = store.submit({
      workspacePath: '/w', projectId: '236', gateName: 'pr', sessionId: 'session-2',
    });
    expect(second.accepted).toBe(false);
    if (second.accepted) return;
    expect(second.code).toBe(APPROVAL_OPERATION_SIGNAL.APPROVAL_ALREADY_IN_FLIGHT);
    // The caller is told WHICH operation to poll, so it does not resubmit.
    expect(second.message).toContain(first.operationId);
  });

  it('accepts a second approval once the first has settled', () => {
    const store = storeAt(scratch());
    const first = submit(store);
    store.settle(first.operationId, { state: 'failed', message: 'x' });
    expect(store.submit({
      workspacePath: '/w', projectId: '236', gateName: 'pr', sessionId: 'session-2',
    }).accepted).toBe(true);
  });

  // AGAINST THE REAL LIMIT. These used to pass `maxConcurrent` per call — a
  // parameter no production caller set, so the test tuned a number the running
  // system never saw and could have passed with the shipped limit set to
  // anything at all.
  it('bounds concurrent approvals per workspace', () => {
    const store = storeAt(scratch());
    submit(store, { projectId: 'a' });
    submit(store, { projectId: 'b' });
    const third = store.submit({
      workspacePath: '/w', projectId: 'c', gateName: 'pr', sessionId: 's', machine: 'm',
    });
    expect(third.accepted).toBe(false);
    if (third.accepted) return;
    expect(third.code).toBe(APPROVAL_OPERATION_SIGNAL.APPROVAL_CONCURRENCY_LIMIT);
  });

  it('bounds each workspace separately', () => {
    const store = storeAt(scratch());
    submit(store, { workspacePath: '/w', projectId: 'a' });
    submit(store, { workspacePath: '/w', projectId: 'b' });
    // '/w' is now AT the limit, so this is the assertion it was meant to be: a
    // different workspace's build is not this workspace's contention.
    expect(store.submit({
      workspacePath: '/other', projectId: 'a', gateName: 'pr', sessionId: 's', machine: 'm',
    }).accepted).toBe(true);
  });
});

describe('a record from a host that is never coming back', () => {
  /*
   * `resolveInterrupted` will not settle another host's records, and that is
   * right: this host cannot tell a dead foreign process from a slow one, and
   * declaring a live one dead would report an approval interrupted while it runs.
   *
   * The consequence was a permanent block. A host removed from the fleet leaves
   * nonterminal records nothing can settle; retention only sweeps TERMINAL
   * records, so they never expire either. That project's approvals were refused
   * forever, with no message saying why and no command to clear it.
   */
  it('blocks nothing forever — an abandoned foreign record settles after the lease', () => {
    const root = scratch();
    const stamp = Date.parse('2026-08-30T00:00:00Z');
    const foreign = storeAt(root, {
      owner: { host: 'a-host-that-is-gone', pid: 4242 },
      now: () => stamp,
    });
    submit(foreign, { projectId: 'blocked' });

    // SIX HOURS LATER, on a different host. Before the lease this refused, and
    // would have gone on refusing for as long as the file existed.
    const ours = storeAt(root, { now: () => stamp + 6 * 60 * 60 * 1000 + 1 });
    const accepted = ours.submit({
      workspacePath: '/w', projectId: 'blocked', gateName: 'pr', sessionId: 's', machine: 'm',
    });
    expect(accepted.accepted, 'the abandoned record still blocks').toBe(true);

    // AND THE ABANDONED RECORD SAYS WHAT HAPPENED, rather than vanishing. It is
    // interrupted, it names the host, and it does NOT claim to know the gate.
    const abandoned = ours.records().find((operation) => operation.owner.host === 'a-host-that-is-gone');
    expect(abandoned?.state).toBe('interrupted');
    expect(abandoned?.gateAfterInterruption).toBe('unreadable');
    expect(abandoned?.message).toContain('a-host-that-is-gone');
  });

  /*
   * AND NOT BEFORE. A slow foreign build is not an abandoned one, and starting a
   * second run beside a live one is the collision single-flight exists to
   * prevent.
   */
  it('does not expire a foreign record that is merely slow', () => {
    const root = scratch();
    const stamp = Date.parse('2026-08-30T00:00:00Z');
    submit(storeAt(root, { owner: { host: 'busy-host', pid: 4242 }, now: () => stamp }),
      { projectId: 'slow' });

    // Five hours in: long, and inside the lease.
    const ours = storeAt(root, { now: () => stamp + 5 * 60 * 60 * 1000 });
    const refused = ours.submit({
      workspacePath: '/w', projectId: 'slow', gateName: 'pr', sessionId: 's', machine: 'm',
    });
    expect(refused.accepted).toBe(false);
    if (refused.accepted) return;
    expect(refused.code).toBe(APPROVAL_OPERATION_SIGNAL.APPROVAL_ALREADY_IN_FLIGHT);
  });

  /*
   * THE CONCURRENCY CAP IS THIS MACHINE'S LOAD, so another host's runs must not
   * count against it. Single-flight is the rule that must see every host, and it
   * still does — this is about the cap only.
   */
  it('does not count another host\'s runs against this host\'s cap', () => {
    const root = scratch();
    const stamp = Date.parse('2026-08-30T00:00:00Z');
    const foreign = storeAt(root, { owner: { host: 'other-host', pid: 4242 }, now: () => stamp });
    submit(foreign, { projectId: 'theirs-a' });
    submit(foreign, { projectId: 'theirs-b' });

    // Both of theirs are live and inside the lease, so nothing expired them.
    const ours = storeAt(root, { now: () => stamp + 1000 });
    expect(ours.submit({
      workspacePath: '/w', projectId: 'ours', gateName: 'pr', sessionId: 's', machine: 'm',
    }).accepted, 'another host\'s runs consumed this host\'s cap').toBe(true);
  });

  /*
   * BUT THE MACHINE IS BOUNDED. The per-workspace cap alone is not a bound on the
   * host: a Tower serving many workspaces would run a build for each and stay
   * inside it.
   */
  it('bounds this host across all workspaces, not only within one', () => {
    const store = storeAt(scratch());
    submit(store, { workspacePath: '/w1', projectId: 'a' });
    submit(store, { workspacePath: '/w1', projectId: 'b' });
    submit(store, { workspacePath: '/w2', projectId: 'c' });
    submit(store, { workspacePath: '/w3', projectId: 'd' });

    // A fifth, in a workspace of its own — within every per-workspace cap and
    // over the host's.
    const refused = store.submit({
      workspacePath: '/w4', projectId: 'e', gateName: 'pr', sessionId: 's', machine: 'm',
    });
    expect(refused.accepted).toBe(false);
    if (refused.accepted) return;
    expect(refused.code).toBe(APPROVAL_OPERATION_SIGNAL.APPROVAL_CONCURRENCY_LIMIT);
    expect(refused.message).toContain('this host');
  });
});

describe('an interrupted operation reports what is true now', () => {
  /** A store whose owner is a DEAD process on this host, ready to be resolved. */
  function withDeadOwner(root: string): { store: ApprovalOperationStore; operation: ApprovalOperation } {
    const dying = storeAt(root, { owner: { host: THIS_HOST.host, pid: 999 } });
    const operation = submit(dying);
    dying.markRunning(operation.operationId, { phase: 'review', checks: ['tests'] });
    // A fresh store standing in for the restarted host: same host, new pid.
    return { store: storeAt(root, { isAlive: () => false }), operation };
  }

  /*
   * THE CASE THAT MATTERS MOST. A host that died AFTER porch wrote the gate
   * leaves a running record and an approved gate. Reporting that as a failure
   * would send an operator to approve something already approved — the "reported
   * one outcome while another happened" defect, arriving through the recovery
   * path instead of the request path.
   */
  it('reports an approved gate as approved, never as a failure', () => {
    const root = scratch();
    const { store, operation } = withDeadOwner(root);
    const resolved = store.resolveInterrupted(() => 'approved');

    expect(resolved).toHaveLength(1);
    const seen = store.describe(operation.operationId)!;
    expect(seen.state).toBe('interrupted');
    expect(seen.gateAfterInterruption).toBe('approved');
    expect(seen.message).toContain('APPROVED');
    expect(seen.message).toContain('nothing needs redoing');
  });

  it('reports a pending gate as nothing having been approved', () => {
    const root = scratch();
    const { store, operation } = withDeadOwner(root);
    store.resolveInterrupted(() => 'pending');
    const seen = store.describe(operation.operationId)!;
    expect(seen.gateAfterInterruption).toBe('pending');
    expect(seen.message).toContain('Nothing was approved');
  });

  it('says it could not tell when status.yaml cannot be read', () => {
    const root = scratch();
    const { store, operation } = withDeadOwner(root);
    store.resolveInterrupted(() => 'unreadable');
    const seen = store.describe(operation.operationId)!;
    // NOT "the gate is unapproved": an unreadable file says nothing about the
    // gate, and reporting it as pending would be a definite answer nobody has.
    expect(seen.message).toContain('is unknown');
    expect(seen.message).toContain('not evidence');
  });

  it('resolves both submitted and running records, so neither can hang', () => {
    const root = scratch();
    const dying = storeAt(root, { owner: { host: THIS_HOST.host, pid: 999 } });
    const submitted = submit(dying, { projectId: 'a' });
    const running = submit(dying, { projectId: 'b' });
    dying.markRunning(running.operationId);

    const store = storeAt(root, { isAlive: () => false });
    expect(store.resolveInterrupted(() => 'pending').map((o) => o.operationId).sort())
      .toEqual([submitted.operationId, running.operationId].sort());
  });

  it('leaves settled records alone', () => {
    const root = scratch();
    const dying = storeAt(root, { owner: { host: THIS_HOST.host, pid: 999 } });
    const done = submit(dying);
    dying.settle(done.operationId, { state: 'succeeded', record: { machine: 'ipad' } });

    storeAt(root, { isAlive: () => false }).resolveInterrupted(() => 'pending');
    expect(storeAt(root).describe(done.operationId)!.state).toBe('succeeded');
  });
});

describe('the resolution pass is scoped, because the store is not keyed by host', () => {
  /*
   * The store lives under `CODEV_AGENT_FARM_DIR`, NOT under a host. An unscoped
   * pass would let a second host starting against a shared root mark a LIVE
   * host's operations interrupted — a running approval reported as dead, which is
   * the failure this store exists to prevent, committed by its own recovery.
   */
  it('leaves another host\'s operations alone', () => {
    const root = scratch();
    const elsewhere = storeAt(root, { owner: { host: 'tower-b', pid: 7 } });
    const theirs = submit(elsewhere);
    elsewhere.markRunning(theirs.operationId);

    const resolved = storeAt(root, { isAlive: () => false }).resolveInterrupted(() => 'pending');
    expect(resolved).toHaveLength(0);
    expect(storeAt(root).describe(theirs.operationId)!.state).toBe('running');
  });

  it('leaves a record whose owning process is still alive', () => {
    const root = scratch();
    const other = storeAt(root, { owner: { host: THIS_HOST.host, pid: 999 } });
    const theirs = submit(other);
    other.markRunning(theirs.operationId);

    // Same host, different pid, and that pid answers alive: a second Tower is
    // running it right now.
    const resolved = storeAt(root, { isAlive: (pid) => pid === 999 }).resolveInterrupted(() => 'pending');
    expect(resolved).toHaveLength(0);
  });

  /*
   * THE PID-REUSE CASE, which a pid check alone never heals. A Tower crashes and
   * the restarted Tower is handed the same pid; a pass asking "is 4242 alive?"
   * gets `true` — because it IS 4242 — and leaves the dead run's record running
   * forever, on exactly the restart that was supposed to clean it up.
   */
  it('resolves a record left by a previous run that had this pid', () => {
    const root = scratch();
    const crashed = storeAt(root, {
      owner: { host: THIS_HOST.host, pid: THIS_HOST.pid, runId: 'run-before-the-crash' },
    });
    const theirs = submit(crashed);
    crashed.markRunning(theirs.operationId);

    // Same host, same pid, different run — and `isAlive` says yes, because that
    // pid is now US. Only the run id can tell the two apart.
    const restarted = storeAt(root, {
      owner: { host: THIS_HOST.host, pid: THIS_HOST.pid, runId: 'run-after-the-restart' },
      isAlive: () => true,
    });
    expect(restarted.resolveInterrupted(() => 'pending')).toHaveLength(1);
    expect(restarted.describe(theirs.operationId)!.state).toBe('interrupted');
  });

  it('leaves the running process\'s own operations alone', () => {
    const root = scratch();
    // `isAlive` answers NO for everything, so only the run-id check can save
    // this record — which is the point: asking whether we are alive is silly, and
    // answering "no" would interrupt work in flight.
    const store = storeAt(root, {
      owner: { ...THIS_HOST, runId: 'this-run' },
      isAlive: () => false,
    });
    const mine = submit(store);
    store.markRunning(mine.operationId);

    expect(store.resolveInterrupted(() => 'pending')).toHaveLength(0);
    expect(store.describe(mine.operationId)!.state).toBe('running');
  });
});

describe('retention', () => {
  it('sweeps settled operations past the window and keeps live ones', () => {
    const root = scratch();
    let clock = 1_000_000;
    const store = storeAt(root, { now: () => clock, retentionMs: 60_000 });
    const settled = submit(store, { projectId: 'a' });
    const live = submit(store, { projectId: 'b' });
    store.settle(settled.operationId, { state: 'failed', message: 'x' });

    clock += 120_000;
    // A submit is what drives the sweep; the settled record ages out and the live
    // one does not, however old it is — a running approval is not litter.
    submit(store, { projectId: 'c' });
    expect(store.describe(settled.operationId)).toBeNull();
    expect(store.describe(live.operationId)!.state).toBe('submitted');
  });
});

describe('a lock timeout is not a corrupt file', () => {
  /*
   * NAMED FOR WHAT IT EXERCISES. This does not run two processes, so it is not a
   * concurrency proof and must not be read as one. It asserts the lock is
   * genuinely taken, and — the point of this phase's fix — that a contention miss
   * reports LOCKED rather than UNREADABLE. Those are two remedies: "retry, it
   * will work" and "go and look at that file". The first cut spelled both as
   * UNREADABLE, in the store whose whole purpose is keeping such pairs apart.
   */
  it('a held lock blocks a submit and says LOCKED, not UNREADABLE', () => {
    const root = scratch();
    const store = storeAt(root);
    submit(store);
    const lockPath = join(root, 'approval-operations.json.lock');
    writeFileSync(lockPath, '');
    // ONE timeout, not two. Each blocked attempt waits out the full lock timeout,
    // so asserting twice spent 2 x 2000ms against vitest's 5000ms default and left
    // almost no headroom on a loaded machine — a test that fails for being slow
    // says nothing about the code.
    let thrown: unknown;
    try {
      submit(store, { projectId: 'b' });
    } catch (error) {
      thrown = error;
    } finally {
      rmSync(lockPath, { force: true });
    }
    expect((thrown as Error | undefined)?.message).toMatch(/APPROVAL_OPERATION_STORE_LOCKED/);
    expect((thrown as Error | undefined)?.message).not.toMatch(/UNREADABLE/);
    // Released, and the blocked submit left nothing behind.
    expect(submit(store, { projectId: 'b' }).state).toBe('submitted');
  });
});

describe('a terminal record is final', () => {
  /*
   * A late callback from an abandoned run must not rewrite an outcome an operator
   * has already been shown — that is reporting a second answer to a question that
   * was already answered.
   */
  it.each([
    ['succeeded', { state: 'succeeded' as const, record: { machine: 'ipad' } }],
    ['refused', { state: 'refused' as const, code: 'PHASE_CHECKS_FAILED', message: 'x' }],
    ['failed', { state: 'failed' as const, message: 'x' }],
  ])('refuses to re-settle a %s operation', (_name, outcome) => {
    const root = scratch();
    const store = storeAt(root);
    const operation = submit(store);
    store.settle(operation.operationId, outcome);
    expect(() => store.settle(operation.operationId, { state: 'failed', message: 'later' }))
      .toThrow(/APPROVAL_OPERATION_ALREADY_SETTLED/);
    expect(() => store.markRunning(operation.operationId)).toThrow(/already settled/);
    expect(store.describe(operation.operationId)!.state).toBe(outcome.state);
  });

  it('refuses to re-run an interrupted operation', () => {
    const root = scratch();
    const dying = storeAt(root, { owner: { host: THIS_HOST.host, pid: 999, runId: 'run-dead' } });
    const operation = submit(dying);
    dying.markRunning(operation.operationId);
    const store = storeAt(root, { isAlive: () => false });
    store.resolveInterrupted(() => 'approved');
    expect(() => store.markRunning(operation.operationId)).toThrow(/already settled/);
  });
});

describe('a store that will not parse is its own answer', () => {
  it('reports unreadable rather than "no such operation"', () => {
    const root = scratch();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'approval-operations.json'), '{ not json');
    // "There is no such operation" sends a caller to check the id it was given;
    // "the store cannot be read" sends someone to look at the host. Spelling them
    // the same way would tell a client its approval never existed because a file
    // was corrupt.
    expect(() => storeAt(root).describe('anything'))
      .toThrow(/APPROVAL_OPERATION_STORE_UNREADABLE/);
  });

  it('reports unreadable from submit as well as from a read', () => {
    const root = scratch();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'approval-operations.json'), '{ not json');
    expect(() => submit(storeAt(root))).toThrow(/APPROVAL_OPERATION_STORE_UNREADABLE/);
  });

  it('treats a store that has never been written as empty, which it is', () => {
    // Absence is not illegibility, and the two must not answer the same way in
    // this direction either.
    expect(storeAt(scratch()).records()).toEqual([]);
  });
});
