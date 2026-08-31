/**
 * Spec 250, Phase 6 — the workspace-to-project map, and the gate writer's credential.
 *
 * The map's three answers are already held up by `issue-227-thread-seams.test.ts`,
 * which drives `activeProjectForWorkspace` against a real HTTP server. This file
 * does not re-test that. It tests the properties phase 6 ADDS, and the ones the
 * plan asks to be stated rather than assumed:
 *
 *   - the map is derived on connect and not cached across processes;
 *   - nothing derives a `projectId` from a path;
 *   - the gate-writer credential answers three ways, not two;
 *   - production actually reaches the gate watch, on its own connection.
 *
 * That last one is the discipline this spec has been caught by five times: a
 * thing wired correctly in a test that production never builds. So the assertion
 * is on the call site in `thread-backend.ts`, not on `startGateWatch` in isolation.
 */

import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGateWriterToken } from '../thread-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const threadBackendPath = join(repoRoot, 'packages/codev/src/agent-farm/thread-backend.ts');
const threadBackendSource = readFileSync(threadBackendPath, 'utf8');

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `spec250-map-${label}-`));
}

// ---------------------------------------------------------------- the map

describe('spec 250: the project map is derived, not remembered', () => {
  /**
   * A restart RE-DERIVES rather than trusting stale state, and the way that is
   * guaranteed is that there is nowhere for stale state to live.
   *
   * `projectId` is resolved inside `initialiseThreadBackend` from the server's own
   * project list and held in the engine, which dies with the socket. If it were
   * written to disk or to the database, a project deleted server-side would keep
   * resolving for as long as the cache did — and a thread created against it
   * would fail at `thread.create` with a message about a project, not about a
   * cache.
   */
  it('writes the resolved projectId to no store', () => {
    // The resolution block, from the lookup to the engine registration.
    const block = threadBackendSource.slice(
      threadBackendSource.indexOf('const lookup = await activeProjectForWorkspace('),
      threadBackendSource.indexOf('setThreadEngine(registered, key)'),
    );
    expect(block.length, 'could not find the resolution block, so this would pass against anything')
      .toBeGreaterThan(500);
    for (const persistence of ['writeFileSync', 'upsert', 'db.', 'localStorage', 'mkdirSync']) {
      expect(block, `the resolved projectId reaches ${persistence}`).not.toContain(persistence);
    }
  });

  /**
   * Two checkouts of the same repository are two workspaces, and a path is not
   * stable across machines. So a `projectId` is read from the server's project
   * list — never constructed from, or keyed by, a path.
   *
   * The canonical workspace key IS a path, and it is the lookup's INPUT: it
   * answers "which project belongs to this root", which is a question the server
   * decides. What must not happen is a path becoming an id.
   */
  it('never builds a projectId out of a path', () => {
    expect(threadBackendSource).not.toMatch(/projectId\s*[:=]\s*[^;\n]*(workspaceRoot|worktreePath|basename|canonicalWorkspaceKey)/);
    // The lookup matches on the workspaceRoot INSIDE each project record, which
    // is the server's own field, and compares it canonically rather than as a
    // string — `/var` and `/private/var` are one directory on macOS.
    expect(threadBackendSource).toContain('canonicalWorkspaceKey(project.workspaceRoot) === target');
  });
});

// ---------------------------------------------------------------- credential

describe('spec 250: the gate-writer credential answers three ways', () => {
  it('reads not-configured when no path was named', () => {
    expect(readGateWriterToken(undefined)).toEqual({ kind: 'not-configured' });
    expect(readGateWriterToken('')).toEqual({ kind: 'not-configured' });
  });

  /**
   * A named path that cannot be read is a FAULT, not "off".
   *
   * Someone said where the credential is. Reporting that as not-configured leaves
   * every gate invisible with nothing said, which is the failure the whole
   * "could not tell" rule exists for — and it is worse here than usual, because
   * the symptom is a sidebar that looks fine.
   */
  it('reads unreadable when the path was named and is absent', () => {
    const dir = scratch('absent');
    try {
      const result = readGateWriterToken(join(dir, 'nope.token'));
      expect(result.kind).toBe('unreadable');
      if (result.kind !== 'unreadable') return;
      expect(result.detail).toContain('ENOENT');
      // Names the likely cause, because "the file is not there" sends an operator
      // looking at Codev when the answer is that the server has not started.
      expect(result.detail).toContain('server');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * An empty file is a half-written credential, not an empty one.
   *
   * The fork writes to `.partial` and renames precisely so a reader never sees
   * that — but a truncated bearer token authenticates like a revoked one, and
   * would be reported as the server refusing us rather than as a local fault.
   */
  it('reads unreadable rather than an empty token', () => {
    const dir = scratch('empty');
    try {
      const path = join(dir, 'gate-writer.token');
      writeFileSync(path, '   \n');
      const result = readGateWriterToken(path);
      expect(result.kind).toBe('unreadable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trims the trailing newline the fork writes', () => {
    const dir = scratch('token');
    try {
      const path = join(dir, 'gate-writer.token');
      // Exactly what `writeCodevGateWriterToken` produces: the token, a newline, 0600.
      writeFileSync(path, 'tok-abc123\n');
      chmodSync(path, 0o600);
      expect(readGateWriterToken(path)).toEqual({ kind: 'token', token: 'tok-abc123' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not put the token in the failure detail', () => {
    const dir = scratch('leak');
    try {
      const path = join(dir, 'gate-writer.token');
      writeFileSync(path, '');
      const result = readGateWriterToken(path);
      if (result.kind !== 'unreadable') throw new Error('expected unreadable');
      // The file was empty, so there is nothing to leak here — the assertion that
      // matters is on the code: the token is read into a local and reaches only
      // the return value, never a message.
      const fn = threadBackendSource.slice(
        threadBackendSource.indexOf('export function readGateWriterToken'),
        threadBackendSource.indexOf('/**', threadBackendSource.indexOf('export function readGateWriterToken')),
      );
      expect(fn).not.toMatch(/detail:[^\n]*\$\{token\}/);
      expect(fn).not.toMatch(/logger\.[a-z]+\([^)]*token/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- call site

/**
 * ASSERT THE CALL SITE, NOT THE MODULE.
 *
 * `startGateWatch` has its own tests and they prove it publishes. None of them
 * prove production ever calls it — which is exactly the shape of every defect
 * this spec has produced: the schema guard wired to a layer nothing builds, the
 * gate-writer credential with no production caller, the spawn factory that was
 * never installed.
 *
 * These read `thread-backend.ts` and assert the wiring is there. Source
 * assertions are a weaker tool than execution, and they are the right tool here:
 * executing this path needs a live t3code server, a bootstrap exchange and two
 * WebSockets, and a test that builds those itself would be supplying the very
 * boundary whose absence is the risk.
 */
describe('spec 250: production reaches the gate watch', () => {
  it('starts the watch inside the connection lifecycle', () => {
    expect(threadBackendSource).toContain('startGateWatch({');
    const init = threadBackendSource.slice(
      threadBackendSource.indexOf('async function initialiseThreadBackend'),
      threadBackendSource.indexOf('const hangUp = new Map'),
    );
    expect(init, 'the watch is not started inside initialiseThreadBackend').toContain('startGateWatch({');
    expect(init, 'the credential is not read where the watch is started').toContain('readGateWriterToken(');
  });

  /**
   * On its OWN socket, with its OWN credential.
   *
   * The engine's dispatcher carries `orchestration:operate`. Routing gate writes
   * over it would hand gate-writing to every holder of that scope, which is
   * exactly what phase 4 gave `codev.gateWrite` a separate scope to prevent. The
   * assertion is that the writer passed to the watch is NOT the engine's
   * dispatcher.
   */
  it('gives the watch a writer that is not the engine dispatcher', () => {
    const call = threadBackendSource.slice(
      threadBackendSource.indexOf('const watch = startGateWatch({'),
      threadBackendSource.indexOf('gateWatches.set(key'),
    );
    expect(call.length).toBeGreaterThan(100);
    expect(call).toContain('writer: gateConnection.dispatcher');
    expect(call, 'gate writes must not travel on the orchestration:operate socket')
      .not.toMatch(/writer:\s*dispatcher\b/);
    // The second connection is opened with the gate credential, not by exchanging
    // the bootstrap token again.
    const connect = threadBackendSource.slice(
      threadBackendSource.indexOf('const gateConnection = await connectDispatcher('),
      threadBackendSource.indexOf('const watch = startGateWatch({'),
    );
    expect(connect).toContain('credential.token');
  });

  /**
   * The first cycle runs on connect, not on the first file change.
   *
   * A gate that reached `pending` while this process was down would otherwise stay
   * invisible until something touched `status.yaml` — which, for a gate waiting on
   * a human, is exactly never.
   */
  it('publishes once immediately rather than waiting for a change', () => {
    expect(threadBackendSource).toContain('watch.publishNow()');
  });

  /**
   * Non-fatal, in all three shapes.
   *
   * A workspace whose gates do not publish is one where a human reads
   * `status.yaml` instead of the sidebar. A workspace that cannot spawn is one
   * where nothing runs. Making the first fatal trades the second for the first.
   */
  it('does not make a gate-publishing failure fatal to spawning', () => {
    const block = threadBackendSource.slice(
      threadBackendSource.indexOf('const credential = readGateWriterToken('),
      threadBackendSource.indexOf('hangUp.set(key, abandonConnection)'),
    );
    expect(block.length).toBeGreaterThan(400);
    expect(block, 'a gate-publishing failure must not throw out of initialiseThreadBackend')
      .not.toMatch(/\bthrow new Error\b/);
    expect(block).toContain('logger.warn');
  });

  /**
   * A RECONNECT must stop the previous watch, not overwrite the reference to it.
   *
   * Raised in review, and the teardown in `closeThreadBackend` does not cover it:
   * a reconnect never goes through `closeThreadBackend`. `ensureThreadBackendReady`
   * re-initialises a workspace whose engine was evicted — which is exactly what a
   * t3code restart causes — so `gateWatches.set` alone drops the previous closer
   * on the floor, leaking a live `fs.watch` AND a WebSocket per reconnect, in
   * Tower, which runs for days.
   *
   * A source assertion for the same reason the rest of this block is one:
   * executing the path needs a live server, a bootstrap exchange and two
   * WebSockets, and a test that builds those itself would be supplying the very
   * boundary whose absence is the risk. What it CAN do is fail when the stop
   * disappears — verified by removing it.
   */
  it('stops the previous watch before installing a new one', () => {
    const block = threadBackendSource.slice(
      threadBackendSource.indexOf('const credential = readGateWriterToken('),
      threadBackendSource.indexOf('hangUp.set(key, abandonConnection)'),
    );
    const stop = block.indexOf('gateWatches.get(key)?.()');
    const install = block.indexOf('gateWatches.set(key');
    expect(stop, 'a reconnect installs a second watch without stopping the first').toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(stop, 'the previous watch is stopped after the new one is installed').toBeLessThan(install);
  });

  /**
   * And the gate socket evicts its own entry when it closes.
   *
   * Nothing else will: this socket carries no engine, so the engine's close
   * handler — which is what evicts everything else on the main connection — never
   * sees it. Without this the map entry outlives its own connection, and a later
   * `closeThreadBackend` closes a socket that is already gone while the watch it
   * points at publishes into a dead wire.
   */
  it('gives the gate socket a close handler that evicts its own entry', () => {
    const connect = threadBackendSource.slice(
      threadBackendSource.indexOf('const gateConnection = await connectDispatcher('),
      threadBackendSource.indexOf('const watch = startGateWatch({'),
    );
    expect(connect).toContain('gateWatches.delete(key)');
    expect(connect, 'the close handler must not evict a watch that replaced it')
      .toContain('gateWatches.get(key) === stopThisWatch');
  });

  /**
   * Torn down with the backend, and BEFORE its early return.
   *
   * The watch is a separate socket and a live `fs.watch`, and it can exist on a
   * workspace whose engine never registered — so it must not be cleaned up behind
   * a guard that asks about the engine's socket.
   */
  it('stops the watch on close, unconditionally', () => {
    const close = threadBackendSource.slice(
      threadBackendSource.indexOf('export function closeThreadBackend(workspaceRoot: string): void {'),
      threadBackendSource.indexOf('deliberate.add(key)'),
    );
    expect(close).toContain('stopGates?.()');
    expect(
      close.indexOf('stopGates?.()'),
      'the watch is torn down after the early return, so a workspace with no engine leaks it',
    ).toBeLessThan(close.indexOf('if (!close) return;'));
  });
});
