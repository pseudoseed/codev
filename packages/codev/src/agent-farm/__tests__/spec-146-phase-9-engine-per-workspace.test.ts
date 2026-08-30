/**
 * Issue #219 round 3 — one engine per WORKSPACE, not one per process.
 *
 * The engine was a bare module-level `let`. In the CLI that is harmless: an `afx`
 * process serves one workspace and exits. Tower does not — it drains mail for every
 * workspace in `global.db` from a single process — so the first thread-configured
 * workspace to connect pinned the socket, the projectId, the dispatcher and the
 * journal, and every later workspace's turns ran against that server, under that
 * project. Silently, because a turn dispatched to the wrong server succeeds.
 *
 * The bug was created by moving engine registration into Tower, which the delivery
 * fix required. It is the shape of that seam.
 *
 * These drive a REAL fake t3code server — token exchange, websocket ticket, shell
 * snapshot, socket upgrade — because the three things under test (which engine a
 * workspace gets, whether a second workspace short-circuits, and what happens when a
 * socket dies) are all properties of a live connection, and a mock of one would be a
 * mock of the answer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { setSpawnThreadFactory } from '../db/thread-identity.js';
import {
  canonicalWorkspaceKey,
  clearThreadEngines,
  getThreadEngine,
  setThreadEngine,
  tryGetThreadEngine,
  createMemoryThreadEngine,
} from '../thread-runtime.js';
import { ensureThreadBackendReady } from '../thread-backend.js';

interface Fake {
  readonly url: string;
  /** How many bootstrap-token exchanges this server has been asked for. */
  readonly tokenExchanges: () => number;
  /** Drop every live WebSocket, as a server restart does. */
  readonly dropSockets: () => void;
  readonly close: () => Promise<void>;
}

/** A t3code server, as far as `connectDispatcher` can tell. */
async function fakeT3(projectsFor: () => ReadonlyArray<{ id: string; workspaceRoot: string }>): Promise<Fake> {
  let exchanges = 0;
  const sockets: WsSocket[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/oauth/token')) {
      exchanges += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    if (req.url?.startsWith('/api/auth/websocket-ticket')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'ticket-1', expires_in: 60 }));
      return;
    }
    if (req.url?.startsWith('/api/orchestration/shell')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ projects: projectsFor(), threads: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      wss.emit('connection', ws, req);
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    tokenExchanges: () => exchanges,
    dropSockets: () => {
      for (const ws of sockets.splice(0)) ws.close();
    },
    close: async () => {
      for (const ws of sockets.splice(0)) ws.terminate();
      wss.close();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

const dirs: string[] = [];

function workspaceAt(serverUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'air-219-ws-key-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.codev'), { recursive: true });
  writeFileSync(
    join(dir, '.codev', 'config.json'),
    JSON.stringify({ threads: { serverUrl, bootstrapToken: 'unbounded-desktop-seed', model: 'gpt-5.6-luna' } }),
  );
  return dir;
}

/** Wait for a condition that a socket event settles, with a bound. */
async function until(predicate: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe('the engine registry is keyed by workspace', () => {
  afterEach(() => {
    clearThreadEngines();
    setSpawnThreadFactory(undefined);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('a keyed lookup never falls back to an engine registered for another workspace', () => {
    const a = createMemoryThreadEngine();
    setThreadEngine(a, '/ws/a');

    expect(tryGetThreadEngine('/ws/a')).toBe(a);
    // The whole bug, in one assertion: workspace B must not receive A's engine, which
    // holds A's socket, A's project and A's journal.
    expect(tryGetThreadEngine('/ws/b')).toBeUndefined();
    expect(() => getThreadEngine('/ws/b')).toThrow(/An engine registered for a different workspace/);
  });

  it('an unkeyed registration is not a fallback for a keyed lookup, or the reverse', () => {
    const unkeyed = createMemoryThreadEngine();
    setThreadEngine(unkeyed);

    expect(tryGetThreadEngine()).toBe(unkeyed);
    expect(tryGetThreadEngine('/ws/a')).toBeUndefined();

    const keyed = createMemoryThreadEngine();
    setThreadEngine(keyed, '/ws/a');
    expect(tryGetThreadEngine()).toBe(unkeyed);
    expect(tryGetThreadEngine('/ws/a')).toBe(keyed);
  });

  it('two spellings of one workspace are one key, not two engines', () => {
    const engine = createMemoryThreadEngine();
    const root = mkdtempSync(join(tmpdir(), 'air-219-canon-'));
    dirs.push(root);
    setThreadEngine(engine, root);
    // Trailing slash, and the `.`-relative form: the same directory either way. Two keys
    // would mean two sockets and two projects for one workspace.
    expect(tryGetThreadEngine(`${root}/`)).toBe(engine);
    expect(tryGetThreadEngine(join(root, '.'))).toBe(engine);
    expect(canonicalWorkspaceKey(`${root}/`)).toBe(canonicalWorkspaceKey(root));
  });
});

describe('Tower serves two workspaces from one process', () => {
  let fake: Fake | undefined;

  afterEach(async () => {
    clearThreadEngines();
    setSpawnThreadFactory(undefined);
    if (fake) await fake.close();
    fake = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('each workspace gets its own engine, and the second is not short-circuited by the first', async () => {
    const roots: string[] = [];
    fake = await fakeT3(() => roots.map((root, i) => ({ id: `p-${i}`, workspaceRoot: root })));
    const a = workspaceAt(fake.url);
    const b = workspaceAt(fake.url);
    roots.push(a, b);

    expect(await ensureThreadBackendReady(a)).toBe('installed');
    // `already-installed` here was the bug: the check read an unkeyed slot, so the second
    // workspace was told it had an engine and then used the first one's.
    expect(await ensureThreadBackendReady(b)).toBe('installed');

    const engineA = tryGetThreadEngine(a);
    const engineB = tryGetThreadEngine(b);
    expect(engineA).toBeDefined();
    expect(engineB).toBeDefined();
    expect(engineA).not.toBe(engineB);

    // Asking again for A is the legitimate `already-installed`.
    expect(await ensureThreadBackendReady(a)).toBe('already-installed');
    expect(tryGetThreadEngine(a)).toBe(engineA);
  });

  /**
   * Two deliveries for one workspace arriving together. Both saw no engine, both
   * connected, and the second overwrote the first — an orphaned socket, and two
   * `project.create` attempts racing for the same root.
   *
   * Counted at the server, not at a spy: one bootstrap-token exchange is what "one
   * connection" means, and a pairing grant is one-time, so a second exchange is not
   * merely wasteful.
   */
  it('concurrent first deliveries for one workspace connect once', async () => {
    const roots: string[] = [];
    fake = await fakeT3(() => roots.map((root, i) => ({ id: `p-${i}`, workspaceRoot: root })));
    const a = workspaceAt(fake.url);
    roots.push(a);

    const [first, second, third] = await Promise.all([
      ensureThreadBackendReady(a),
      ensureThreadBackendReady(a),
      ensureThreadBackendReady(a),
    ]);

    expect([first, second, third]).toEqual(['installed', 'installed', 'installed']);
    expect(fake.tokenExchanges()).toBe(1);
  });

  /**
   * A dead socket must not stay registered as a live engine.
   *
   * Item 4 of this PR proves the t3code server can be restarted. Tower held the engine
   * from before that restart forever, and every delivery through it failed until Tower
   * itself was restarted — the old close handler only warned.
   */
  it('a closed socket drops that workspace\'s engine, and only that one', async () => {
    const roots: string[] = [];
    fake = await fakeT3(() => roots.map((root, i) => ({ id: `p-${i}`, workspaceRoot: root })));
    const a = workspaceAt(fake.url);
    roots.push(a);
    const other = createMemoryThreadEngine();
    setThreadEngine(other, '/ws/untouched');

    await ensureThreadBackendReady(a);
    expect(tryGetThreadEngine(a)).toBeDefined();

    fake.dropSockets();

    expect(await until(() => tryGetThreadEngine(a) === undefined)).toBe(true);
    // Eviction is per workspace, not a process-wide reset.
    expect(tryGetThreadEngine('/ws/untouched')).toBe(other);
  });

  it('after eviction the next call reconnects rather than reporting already-installed', async () => {
    const roots: string[] = [];
    fake = await fakeT3(() => roots.map((root, i) => ({ id: `p-${i}`, workspaceRoot: root })));
    const a = workspaceAt(fake.url);
    roots.push(a);

    await ensureThreadBackendReady(a);
    fake.dropSockets();
    await until(() => tryGetThreadEngine(a) === undefined);

    expect(await ensureThreadBackendReady(a)).toBe('installed');
    expect(fake.tokenExchanges()).toBe(2);
  });
});
