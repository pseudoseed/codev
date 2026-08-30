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
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { setSpawnThreadFactory } from '../db/thread-identity.js';
import {
  canonicalWorkspaceKey,
  clearCanonicalWorkspaceKeys,
  clearThreadEngines,
  getThreadEngine,
  setThreadEngine,
  tryGetThreadEngine,
  createMemoryThreadEngine,
} from '../thread-runtime.js';
import {
  activeProjectForWorkspace,
  clearThreadBackendFailures,
  ensureThreadBackendReady,
  requestThreadBackend,
} from '../thread-backend.js';

interface Fake {
  readonly url: string;
  /** How many bootstrap-token exchanges this server has been asked for. */
  readonly tokenExchanges: () => number;
  /** Drop every live WebSocket, as a server restart does. */
  readonly dropSockets: () => void;
  readonly close: () => Promise<void>;
}

interface FakeOptions {
  /**
   * Called when the shell-snapshot request arrives, BEFORE it is answered. Returning a
   * promise holds the response open — which is the window this whole file is about: the
   * socket is already up while that HTTP request is in flight.
   */
  readonly onShellRequest?: (fake: Fake) => void | Promise<void>;
  /** Never answer the shell snapshot at all. */
  readonly hangShellRequest?: boolean;
}

/** A t3code server, as far as `connectDispatcher` can tell. */
async function fakeT3(
  projectsFor: () => ReadonlyArray<{ id: string; workspaceRoot: string }>,
  options: FakeOptions = {},
): Promise<Fake> {
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
      if (options.hangShellRequest) return; // accepted, never answered
      void Promise.resolve(options.onShellRequest?.(fake)).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ projects: projectsFor(), threads: [] }));
      });
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
  const fake: Fake = {
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
  return fake;
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
    setSpawnThreadFactory(undefined, undefined);
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

  /**
   * Issue #219 round 9. This fix was reported as landed in round 8 and was NOT in the
   * code — every other round-8 blocker had a mutation check that would have caught its
   * absence, and this one had no test at all. A fix with no test is the fix that
   * silently is not there.
   *
   * What it guards: `realpathSync` is a synchronous filesystem syscall, and
   * `canonicalWorkspaceKey` runs on every engine lookup — once per agent per 1.5 s tick,
   * inside Tower's sequential drain loop.
   */
  it('resolves a workspace path once, not on every lookup', () => {
    const root = mkdtempSync(join(tmpdir(), 'air-219-cache-'));
    dirs.push(root);
    clearCanonicalWorkspaceKeys();

    const first = canonicalWorkspaceKey(root);
    // Remove the directory. An uncached implementation now takes the `catch` branch and
    // returns the unresolved path; a cached one returns what it resolved before. That is
    // the observable difference between calling realpathSync and not calling it.
    rmSync(root, { recursive: true, force: true });
    const second = canonicalWorkspaceKey(root);

    expect(second).toBe(first);
    // And the cache is per-process state a test can clear, not a leak.
    clearCanonicalWorkspaceKeys();
    expect(canonicalWorkspaceKey(root)).toBe(resolve(root));
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
    setSpawnThreadFactory(undefined, undefined);
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

/**
 * Round 4. The close handler carried a comment saying it "can only fire after this
 * function has finished registering" the engine. That was not true, and once written as
 * a guarantee it stopped being checked — two reviewers went straight to it.
 *
 * The socket is OPEN while the HTTP project lookup runs. A close in that window left
 * `registered` undefined, so the handler's guard compared `undefined === undefined`,
 * evicted nothing, and initialisation went on to register an engine backed by an
 * already-closed socket. No further close could fire, because it already had.
 *
 * The earlier eviction tests close the socket AFTER initialisation, which is exactly
 * why they could not see this.
 */
describe('a socket that closes DURING initialisation registers nothing', () => {
  let fake: Fake | undefined;

  afterEach(async () => {
    clearThreadEngines();
    setSpawnThreadFactory(undefined, undefined);
    if (fake) await fake.close();
    fake = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no engine behind when the socket dies while the project lookup is in flight', async () => {
    const roots: string[] = [];
    fake = await fakeT3(
      () => roots.map((root, i) => ({ id: `p-${i}`, workspaceRoot: root })),
      {
        // The window itself: the handshake is done, the engine is not yet registered.
        onShellRequest: (self) => {
          self.dropSockets();
          return new Promise((r) => setTimeout(r, 50));
        },
      },
    );
    const a = workspaceAt(fake.url);
    roots.push(a);

    await expect(ensureThreadBackendReady(a)).rejects.toThrow(/closed while the thread backend .* was still initialising/s);

    // The assertion that matters. A registered engine here is a permanently dead one:
    // its socket is gone and no further close event will ever arrive to evict it.
    expect(tryGetThreadEngine(a)).toBeUndefined();
  });

  it('the next call after that failure connects again rather than finding a corpse', async () => {
    const roots: string[] = [];
    let dropOnce = true;
    fake = await fakeT3(
      () => roots.map((root, i) => ({ id: `p-${i}`, workspaceRoot: root })),
      {
        onShellRequest: (self) => {
          if (!dropOnce) return;
          dropOnce = false;
          self.dropSockets();
          return new Promise((r) => setTimeout(r, 50));
        },
      },
    );
    const a = workspaceAt(fake.url);
    roots.push(a);

    await expect(ensureThreadBackendReady(a)).rejects.toThrow();
    expect(await ensureThreadBackendReady(a)).toBe('installed');
    expect(tryGetThreadEngine(a)).toBeDefined();
  });

  /**
   * The lookup sits between a completed handshake and a registered engine, and had no
   * bound: a server that accepts the request and never answers left it unsettled
   * forever, so `ensureThreadBackendReady` hung having reported nothing. Unbounded is
   * not "slow" — it never ends.
   *
   * Asserted on the lookup itself rather than through `ensureThreadBackendReady`,
   * because the failure that follows it (a `project.create` this fake never answers)
   * is bounded by the RPC client's own 30 s timeout, and a 30-second unit test would
   * be measuring that instead of this.
   *
   * `unknown`, not `none`: a request that could not be answered is not a workspace with
   * no project, and the caller's next move differs.
   */
  it('a lookup the server never answers is bounded, and reports `unknown`', async () => {
    fake = await fakeT3(() => [], { hangShellRequest: true });

    const started = Date.now();
    const lookup = await activeProjectForWorkspace(fake.url, 'tok', '/ws', 500);
    const elapsed = Date.now() - started;

    expect(lookup.kind).toBe('unknown');
    // Well inside vitest's own timeout, which is the only thing that ended this before
    // the bound existed.
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  }, 20_000);
});

/**
 * Round 5. Tower's mailbox drainer awaits agents sequentially, and a connect is bounded
 * at 15 s per stage by design — so awaiting one on that path stalled delivery for every
 * agent in every workspace, INCLUDING PTY-ONLY ONES THAT NEVER OPTED IN. An opt-in
 * feature is not opt-in if declining it still costs you your mail.
 *
 * `requestThreadBackend` is the answer and it is synchronous by construction: there is no
 * promise on the delivery path to await.
 */
describe('the drain tick never waits for a connect', () => {
  let fake: Fake | undefined;

  afterEach(async () => {
    clearThreadEngines();
    clearThreadBackendFailures();
    setSpawnThreadFactory(undefined, undefined);
    if (fake) await fake.close();
    fake = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('a workspace with no server named costs the caller nothing and starts nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-219-nothreads-'));
    dirs.push(dir);
    const started = Date.now();
    expect(requestThreadBackend(dir)).toEqual({ kind: 'not-configured' });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('returns `connecting` immediately and is ready by a later call, never blocking', async () => {
    const roots: string[] = [];
    fake = await fakeT3(() => roots.map((root, i) => ({ id: `p-${i}`, workspaceRoot: root })));
    const a = workspaceAt(fake.url);
    roots.push(a);

    const started = Date.now();
    expect(requestThreadBackend(a)).toEqual({ kind: 'connecting' });
    // The whole point: a real connect is happening and this call did not wait for it.
    expect(Date.now() - started).toBeLessThan(100);
    // A second call while it is in flight also does not wait, and does not start a second.
    expect(requestThreadBackend(a)).toEqual({ kind: 'connecting' });

    expect(await until(() => requestThreadBackend(a).kind === 'ready')).toBe(true);
    expect(fake.tokenExchanges()).toBe(1);
  });

  /**
   * Tower ticks every 1.5 s. Without a cooldown, a workspace whose server is down re-ran
   * the whole connect on every tick — a full bootstrap-token exchange each time, against
   * a credential this module's own docs say may be one-time. The retry loop would spend
   * the thing it needs to retry with.
   */
  it('a failed connect is not retried on the next tick, and says why', async () => {
    // Port 1: refuses immediately, so the failure is fast and unambiguous.
    const dir = mkdtempSync(join(tmpdir(), 'air-219-down-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.codev'), { recursive: true });
    writeFileSync(
      join(dir, '.codev', 'config.json'),
      JSON.stringify({ threads: { serverUrl: 'http://127.0.0.1:1', bootstrapToken: 'seed' } }),
    );

    expect(requestThreadBackend(dir)).toEqual({ kind: 'connecting' });
    expect(await until(() => requestThreadBackend(dir).kind === 'cooling-down')).toBe(true);

    const cooling = requestThreadBackend(dir);
    expect(cooling.kind).toBe('cooling-down');
    expect(cooling.kind === 'cooling-down' && cooling.message).toMatch(/could not be reached/);

    // Ten more ticks' worth: still cooling, still no new attempt.
    for (let i = 0; i < 10; i += 1) expect(requestThreadBackend(dir).kind).toBe('cooling-down');

    // And the window is a window, not a permanent stop.
    const later = Date.now() + 61_000;
    expect(requestThreadBackend(dir, later).kind).toBe('connecting');
  }, 20_000);

  /**
   * Round 6. The upgrade timeout closes the socket it gave up on — but a connection that
   * upgraded SUCCESSFULLY and then failed afterwards was simply dropped: the reference
   * went out of scope and the socket stayed open. The 60 s cooldown then retries, and
   * Tower accumulates one live connection per attempt.
   *
   * Nothing owns the socket until an engine is registered on it, so every exit before
   * that has to hang up.
   */
  it('a failure AFTER a successful upgrade hangs up rather than leaking the socket', async () => {
    const http = await import('node:http');
    let ends = 0;
    let upgrades = 0;
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ noServer: true });
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/oauth/token')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      if (req.url?.startsWith('/api/auth/websocket-ticket')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ticket: 't', expires_in: 60 }));
        return;
      }
      if (req.url?.startsWith('/api/orchestration/shell')) {
        // A real answer with no project for this root, so `project.create` is attempted
        // — and this server never answers RPC, so it fails. The socket upgraded fine.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ projects: [], threads: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on('upgrade', (req, socket, head) => {
      upgrades += 1;
      socket.on('end', () => { ends += 1; });
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const { port } = server.address() as { port: number };
    const dir = workspaceAt(`http://127.0.0.1:${port}`);

    try {
      // `project.create` is dispatched over a socket nobody answers; the RPC client's own
      // timeout ends it. A short one keeps this a unit test.
      await expect(ensureThreadBackendReady(dir, { upgradeTimeoutMs: 800 })).rejects.toThrow();
      expect(upgrades).toBe(1);
      expect(tryGetThreadEngine(dir)).toBeUndefined();
      // The FIN. Without the disposer this socket stays open for the life of the process,
      // and the cooldown's retry adds another.
      expect(await until(() => ends === 1, 60_000)).toBe(true);
    } finally {
      wss.close();
      await new Promise<void>((res) => server.close(() => res()));
    }
  }, 90_000);

  /**
   * A bound that does not cancel is not a bound. The upgrade timeout rejected and walked
   * away, leaving a live socket past the advertised deadline — and Tower retries, so it
   * accumulated one orphan per attempt.
   */
  it('the upgrade bound closes the socket it gave up on', async () => {
    const http = await import('node:http');
    const heldSockets: Array<{ destroy(): void }> = [];
    let upgrades = 0;
    let closes = 0;
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/oauth/token')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      if (req.url?.startsWith('/api/auth/websocket-ticket')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ticket: 't', expires_in: 60 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // Accept the upgrade and never complete it. Without an `upgrade` listener node
    // destroys the socket, which is a different state — so hold it deliberately.
    // `end`, not `close`: the client hanging up half-closes the connection, and the
    // server side stays writable until it ends too. `end` is the FIN — the observable
    // fact that the client let go — and `close` would never fire here no matter what
    // the client did.
    server.on('upgrade', (_req, socket) => {
      upgrades += 1;
      socket.resume();
      socket.on('end', () => { closes += 1; });
      heldSockets.push(socket);
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const { port } = server.address() as { port: number };
    const dir = workspaceAt(`http://127.0.0.1:${port}`);

    try {
      await expect(ensureThreadBackendReady(dir, { upgradeTimeoutMs: 400 }))
        .rejects.toThrow(/never completed the WebSocket upgrade/);
      expect(upgrades).toBe(1);
      // The client hung up. Without the close, this socket outlives the bound that was
      // supposed to end it, and every retry adds another.
      expect(await until(() => closes === 1, 5_000)).toBe(true);
    } finally {
      for (const s of heldSockets) { try { s.destroy(); } catch { /* gone */ } }
      await new Promise<void>((res) => server.close(() => res()));
    }
  }, 20_000);
});
