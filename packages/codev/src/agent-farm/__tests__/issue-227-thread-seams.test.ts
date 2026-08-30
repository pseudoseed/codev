/**
 * Issue #227 — the thread-path seams #221 found, verified, and deliberately did not fix.
 *
 * Items 1, 2 and 4. Item 3 (harness/model on the architect row) needs a database and a
 * mocked terminal registry, so it lives in `issue-227-architect-harness-model.test.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { authorizedGet } from '@cluesmith/t3-client/auth';
import {
  allocateSpawnThread,
  chooseSpawnPath,
  setSpawnThreadFactory,
} from '../db/thread-identity.js';
import {
  clearThreadEngines,
  createMemoryThreadEngine,
  installThreadSpawnFactory,
  setThreadEngine,
} from '../thread-runtime.js';
import { activeProjectForWorkspace, adoptThreadInThisProcess } from '../thread-backend.js';

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'air-227-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  clearThreadEngines();
  setSpawnThreadFactory(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const source = (rel: string) => readFileSync(resolvePath(import.meta.dirname, rel), 'utf-8');

/**
 * ITEM 1. `installThreadSpawnFactory` wrote a process-global from Tower's process.
 *
 * `ensureThreadBackendReady` installs a factory on every successful init, and Tower calls
 * that for every workspace it delivers to — so the last workspace to connect owned the
 * module-level slot. The factory itself closed over its workspace and always dispatched to
 * the right engine; it was the SELECTION that was global. `chooseSpawnPath` said `thread`
 * on the strength of some other workspace's factory existing, and `allocateSpawnThread`
 * then created a thread on that other workspace's server.
 */
describe('the spawn factory is keyed by workspace, not by process', () => {
  it('a workspace with no factory installed is `pty`, whatever other workspaces installed', () => {
    const a = workspace();
    const b = workspace();
    setThreadEngine(createMemoryThreadEngine(), a);
    setThreadEngine(createMemoryThreadEngine(), b);

    installThreadSpawnFactory(a);

    expect(chooseSpawnPath(undefined, a)).toBe('thread');
    // The regression, in one line: this used to be `thread` because A had installed one.
    expect(chooseSpawnPath(undefined, b)).toBe('pty');
    // And a caller that names no workspace reads the unkeyed slot, which a keyed install
    // never fills. A keyed miss falling back to some other workspace's factory would be
    // the process-global behaviour one indirection further away.
    expect(chooseSpawnPath()).toBe('pty');
  });

  it('the last workspace to install does not take the previous one over', () => {
    const a = workspace();
    const b = workspace();
    const engineA = createMemoryThreadEngine();
    const engineB = createMemoryThreadEngine();
    setThreadEngine(engineA, a);
    setThreadEngine(engineB, b);

    installThreadSpawnFactory(a);
    installThreadSpawnFactory(b);

    expect(chooseSpawnPath(undefined, a)).toBe('thread');
    expect(chooseSpawnPath(undefined, b)).toBe('thread');
  });

  it('allocating names the workspace, and the thread lands on that workspace\'s engine', async () => {
    const a = workspace();
    const b = workspace();
    const engineA = createMemoryThreadEngine();
    const engineB = createMemoryThreadEngine();
    setThreadEngine(engineA, a);
    setThreadEngine(engineB, b);
    installThreadSpawnFactory(a);
    installThreadSpawnFactory(b);

    const idA = await allocateSpawnThread(
      { builderId: 'air-a', worktreePath: join(a, '.builders/air-a'), branch: 'builder/air-a' },
      a,
    );

    expect(engineA.get(idA)).toBeDefined();
    // Not just "some engine created it": B must not have been asked.
    expect(engineB.get(idA)).toBeUndefined();
  });

  it('allocating for a workspace with no factory says WHICH workspace has none', async () => {
    const a = workspace();
    const b = workspace();
    setThreadEngine(createMemoryThreadEngine(), a);
    installThreadSpawnFactory(a);

    // "Thread-backed spawn has no factory" was true of the process and false of the
    // system: A had one. A reader told the first goes looking for a wiring bug.
    await expect(
      allocateSpawnThread(
        { builderId: 'air-b', worktreePath: join(b, '.builders/air-b'), branch: 'builder/air-b' },
        b,
      ),
    ).rejects.toThrow(b);
  });

  it('two spellings of one workspace are one factory', () => {
    const a = workspace();
    setThreadEngine(createMemoryThreadEngine(), a);
    installThreadSpawnFactory(`${a}/`);

    // Two keys for one workspace would be two factories for it — the same failure the
    // engine map is keyed to prevent, wearing a different hat.
    expect(chooseSpawnPath(undefined, a)).toBe('thread');
  });
});

/**
 * ITEM 2. `afx interrupt` and `afx cleanup` are fresh processes.
 *
 * Both reached `getThreadEngine(workspaceRoot)` where nothing had registered one, so both
 * threw. #221 made them throw about the right workspace and with a message naming the
 * limitation — honest, and not working. The delivery path had the shape all along:
 * register the backend in this process, `attach` the thread from the row, then act.
 */
describe('a command can adopt a thread it did not create', () => {
  it('an engine that never created the thread refuses it until attach adopts it', async () => {
    const root = workspace();
    const engine = createMemoryThreadEngine();
    setThreadEngine(engine, root);

    // The state every fresh `afx` process starts in: the thread exists on the server, and
    // this engine has never heard of it.
    await expect(engine.interrupt('thr-from-another-process')).rejects.toThrow(/Unknown thread/);

    const adopted = await adoptThreadInThisProcess({
      threadId: 'thr-from-another-process',
      workspaceRoot: root,
      worktreePath: join(root, '.builders/air-227'),
      branch: 'builder/air-227',
      builderId: 'air-227',
    });

    // The engine registered FOR THAT WORKSPACE, not whichever one registered first.
    expect(adopted).toBe(engine);
    await expect(engine.interrupt('thr-from-another-process')).resolves.toEqual({ activeTurnId: null });
  });

  it('adoption carries the worktree from the row, so cleanup has a path to remove', async () => {
    const root = workspace();
    const engine = createMemoryThreadEngine();
    setThreadEngine(engine, root);
    const worktreePath = join(root, '.builders/air-227');

    await adoptThreadInThisProcess({
      threadId: 'thr-1',
      workspaceRoot: root,
      worktreePath,
      branch: 'builder/air-227',
      builderId: 'air-227',
    });

    // Not derivable from the thread id by this process — it comes from the row that
    // recorded it at spawn, which is why `attach` takes it.
    expect(engine.worktreePath('thr-1')).toBe(worktreePath);
    await expect(engine.removeWorktree('thr-1')).resolves.toBe('removed');
  });

  it('adopting twice is not an error', async () => {
    const root = workspace();
    setThreadEngine(createMemoryThreadEngine(), root);
    const input = {
      threadId: 'thr-1',
      workspaceRoot: root,
      worktreePath: join(root, '.builders/air-227'),
      branch: 'builder/air-227',
      builderId: 'air-227',
    };

    // A caller cannot always know whether this process already adopted it, and a second
    // attach must not replace a record that is tracking a live turn.
    await adoptThreadInThisProcess(input);
    await expect(adoptThreadInThisProcess(input)).resolves.toBeDefined();
  });

  /**
   * Source guards, in the pattern this repo already uses for CLI wiring that cannot be
   * driven without a live server (see `spec-146-phase-9-afx-parity.test.ts`). What is
   * asserted above is that adoption WORKS; what is asserted here is that the two broken
   * commands actually reach it, which is the whole of item 2.
   */
  it('afx interrupt adopts the thread before interrupting it', () => {
    const src = source('../commands/interrupt.ts');
    expect(src).toContain('adoptThreadInThisProcess');
    expect(src.indexOf('adoptThreadInThisProcess({')).toBeLessThan(src.indexOf('engine.interrupt('));
  });

  it('afx cleanup adopts the thread before removing its worktree', () => {
    const src = source('../commands/cleanup.ts');
    expect(src).toContain('adoptThreadInThisProcess');
    expect(src.indexOf('adoptThreadInThisProcess({')).toBeLessThan(src.indexOf('engine.removeWorktree('));
    // And no longer reaches an engine map nothing in this process has filled.
    expect(src).not.toContain('getThreadEngine(');
  });
});

/**
 * ITEM 4. One bare `fetch` with a hand-built `authorization: Bearer` header lived in
 * `thread-backend.ts`, next to the client module that owns every other request to this
 * server. It worked. What it cost is measurable: it was the one call that skipped
 * `assertTransportSafe`, so it was willing to put a bearer token on a plaintext
 * connection to a non-loopback host.
 */
describe('the project lookup is addressed through the client', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
  });

  async function listening(handler: (auth: string | undefined, url: string) => unknown): Promise<string> {
    server = createServer((req, res) => {
      const body = handler(req.headers.authorization, req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', () => res()));
    const address = server!.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  it('sends the bearer token and joins the path onto the base url', async () => {
    const seen: Array<{ auth?: string; url: string }> = [];
    const url = await listening((auth, requested) => {
      seen.push({ auth, url: requested });
      return { ok: true };
    });

    // A trailing slash on the base must not produce a double slash in the path.
    const response = await authorizedGet(`${url}/`, '/api/orchestration/shell', 'tok-1');

    expect(response.ok).toBe(true);
    expect(seen).toEqual([{ auth: 'Bearer tok-1', url: '/api/orchestration/shell' }]);
  });

  it('refuses a bearer token on plaintext to a non-loopback host', async () => {
    // The check the hand-built copy skipped. Nothing is sent.
    await expect(authorizedGet('http://example.com', '/api/orchestration/shell', 'tok-1'))
      .rejects.toThrow(/must be HTTPS/);
  });

  it('the project lookup reports that refusal as `unknown`, not as `none`', async () => {
    const lookup = await activeProjectForWorkspace('http://example.com', 'tok-1', '/ws');

    // `unknown` is not `none`: the caller's next move on `none` is to create a project,
    // and `project.create` refuses a second active one for a workspace root. A lookup that
    // could not be performed must never be spelled like a workspace with no project.
    expect(lookup.kind).toBe('unknown');
  });

  it('finds the project for this workspace root through the client', async () => {
    const root = workspace();
    const url = await listening(() => ({ projects: [{ id: 'proj-1', workspaceRoot: root }] }));

    await expect(activeProjectForWorkspace(url, 'tok-1', root))
      .resolves.toEqual({ kind: 'found', projectId: 'proj-1' });
  });
});
