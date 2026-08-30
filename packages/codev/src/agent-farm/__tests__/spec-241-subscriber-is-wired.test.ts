/**
 * Issue #241 — the subscriber is reachable in production.
 *
 * This file is the durable half, and it exists for the same reason
 * `spec-146-phase-9-thread-backend.test.ts`'s manifest assertions do.
 *
 * The behavioural tests in `spec-241-thread-subscriptions.test.ts` construct the pool
 * and hand it to the engine themselves, so they prove the wiring WORKS. They cannot
 * prove it is wired: every one of them would still pass if
 * `initialiseThreadBackend` stopped passing `subscriptions`, or if Tower stopped
 * starting the sweeper — and production would be back to a tracker nothing feeds,
 * with a green suite.
 *
 * That is exactly the shape of the bug this issue reports. #221's first finding is
 * that the in-memory engine records what it is handed and validates nothing, so
 * in-memory tests could not see that production had no subscriber at all. A test that
 * builds its own subscriber has the same blind spot. So these assertions read the
 * production source.
 *
 * Source-text assertions are brittle by nature, and that is accepted here rather than
 * hidden: each one names the property it protects, so a rename that breaks it tells
 * the next person what to re-establish instead of what to delete.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

describe('Issue #241 — production wires the thread subscriber', () => {
  it('initialiseThreadBackend builds a subscription pool and gives it to the engine', () => {
    const source = read('packages/codev/src/agent-farm/thread-backend.ts');
    expect(source).toContain('createThreadSubscriptionPool(');
    // The engine must RECEIVE it. A pool that is built and not handed over subscribes
    // to nothing, because only the engine calls `ensure`.
    expect(source).toMatch(/createPorchThreadEngine\(\{[\s\S]*?subscriptions: pool,[\s\S]*?\}\)/);
  });

  it('the pool feeds the engine, not the tracker alone', () => {
    const source = read('packages/codev/src/agent-farm/thread-backend.ts');
    // Feeding `tracker.observe` alone would settle turns and leave every one of them
    // wordless: it is `DriverThread.observe` that fills the event log `runTurn` reads
    // its assistant text out of, and only the engine routes to that.
    expect(source).toContain('registered.observe(value)');
  });

  it('the socket close handler stops the pool', () => {
    const source = read('packages/codev/src/agent-farm/thread-backend.ts');
    // A pool outliving its socket retries forever against a dead wire.
    expect(source).toContain('pool?.stopAll()');
  });

  it('every path that dispatches a turn awaits the subscription first', () => {
    const source = read('packages/codev/src/agent-farm/porch-thread-engine.ts');
    // Exactly the two dispatch paths: `create` (the spawn turn) and `startTurn`.
    // `attach` deliberately does not await — it adopts, it does not dispatch — and
    // this count is what would catch someone "fixing" a sweeper latency complaint by
    // dropping the guard from a path that does dispatch.
    const ensures = source.match(/await options\.subscriptions\?\.ensure\(/g) ?? [];
    expect(ensures.length).toBe(2);
    expect(source).toContain('options.subscriptions?.start(thread.threadId)');
    // And the wait is BEFORE the first turn, not after it. This is the ordering the
    // whole change exists for: a turn dispatched first can have its `running`
    // transition land inside the server's snapshot frame, which carries no
    // observable events.
    const ensureAt = source.indexOf('await options.subscriptions?.ensure(thread.threadId)');
    const beginAt = source.indexOf('await thread.beginTurn(input.prompt)');
    expect(ensureAt).toBeGreaterThan(-1);
    expect(beginAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeLessThan(beginAt);
  });

  it('removeWorktree stops the thread subscription', () => {
    const source = read('packages/codev/src/agent-farm/porch-thread-engine.ts');
    expect(source).toContain('options.subscriptions?.stop(threadId)');
  });

  it('Tower starts and stops the adoption sweeper', () => {
    const source = read('packages/codev/src/agent-farm/servers/tower-server.ts');
    expect(source).toContain('createThreadAdoptionSweeper(');
    expect(source).toContain('threadSweeper.start()');
    expect(source).toContain('threadAdoptionSweeper?.stop()');
    // `tryGetThreadEngine`, never the throwing accessor: a workspace with no t3code
    // server is the ordinary case, and `getThreadEngine` would make it an error on
    // every pass.
    expect(source).toContain('engineFor: (workspaceRoot) => tryGetThreadEngine(workspaceRoot)');
  });

  it('ThreadEngine declares observe, so a new implementation cannot forget it', () => {
    const source = read('packages/codev/src/agent-farm/thread-runtime.ts');
    expect(source).toMatch(/export interface ThreadEngine \{[\s\S]*?observe\(value: unknown\): void;[\s\S]*?\n\}/);
  });
});
