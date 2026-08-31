/**
 * Unit tests for tower-routes.ts (Spec 0105 Phase 6)
 *
 * Tests: route dispatch (handleRequest routing), CORS headers, security
 * checks, SSE events wiring, health check, terminal list, dashboard,
 * workspace path decoding, and 404 fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { handleRequest } from '../servers/tower-routes.js';
import type { RouteContext } from '../servers/tower-routes.js';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import { SessionScreen } from '../../terminal/session-screen.js';
// Spec 1313 round 3: the real delayed-send timer registry + per-session submission lock
// (NOT mocked) so the delayed-`--interrupt` reshape is exercised through the same singletons
// handleSend uses. shutdownDelayedSends() models a Tower restart (bumps the liveness
// generation); submitToSession lets a test pre-occupy a session's lock to drive the
// shutdown-during-lock-wait window deterministically.
import { shutdownDelayedSends } from '../servers/delayed-send.js';
import { submitToSession, resetSubmissionChains } from '../servers/session-submit.js';
import { ESCAPE_ENTER_DELAY_MS } from '../servers/message-write.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockGetInstances, mockGetTerminalManager, mockGetSession,
  mockListSessions, mockGetWorkspaceTerminalsEntry, mockGetTerminalsForWorkspace,
  mockGetRehydratedTerminalsEntry,
  mockIsSessionPersistent, mockGetNextShellId,
  mockResolveTarget, mockResolveAgentInRegistry, mockBroadcastMessage, mockIsResolveError,
  mockParseJsonBody,
  mockOverviewGetOverview, mockOverviewInvalidate,
  mockReadCloudConfig,
  mockComputeAnalytics,
  mockGetKnownWorkspacePaths,
  mockIsStartupReconcileSettled,
  sendDbHolder } = vi.hoisted(() => ({
  mockGetInstances: vi.fn(),
  mockGetTerminalManager: vi.fn(),
  mockGetSession: vi.fn(),
  mockListSessions: vi.fn(),
  mockGetWorkspaceTerminalsEntry: vi.fn(),
  mockGetTerminalsForWorkspace: vi.fn(),
  mockGetRehydratedTerminalsEntry: vi.fn(async () => ({
    architects: new Map(),
    builders: new Map(),
    shells: new Map(),
    fileTabs: new Map(),
  })),
  mockIsSessionPersistent: vi.fn(),
  mockGetNextShellId: vi.fn(),
  mockResolveTarget: vi.fn(),
  mockResolveAgentInRegistry: vi.fn(),
  mockBroadcastMessage: vi.fn(),
  mockIsResolveError: vi.fn((r: any) => 'code' in r),
  mockParseJsonBody: vi.fn(async () => ({})),
  mockOverviewGetOverview: vi.fn(async () => ({ builders: [], pendingPRs: [], backlog: [] })),
  mockOverviewInvalidate: vi.fn(),
  mockReadCloudConfig: vi.fn(),
  mockComputeAnalytics: vi.fn(),
  mockGetKnownWorkspacePaths: vi.fn(() => []),
  mockIsStartupReconcileSettled: vi.fn(() => true),
  // Holder for the in-memory global.db used by the Spec 1313 send path (mailbox
  // persist + gate delivery). Re-created per test in beforeEach.
  sendDbHolder: { db: null as unknown as import('better-sqlite3').Database },
}));

vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: (...args: unknown[]) => mockReadCloudConfig(...args),
}));

vi.mock('../servers/tower-instances.js', () => ({
  getInstances: mockGetInstances,
  getKnownWorkspacePaths: (...args: unknown[]) => mockGetKnownWorkspacePaths(...args),
  getDirectorySuggestions: vi.fn(async () => []),
  launchInstance: vi.fn(async () => ({ success: true })),
  killTerminalWithShellper: vi.fn(async () => true),
  // Issue #1261: routes that need the instances module ask this first, so a
  // wired-up Tower is the default for every route test here.
  instancesReady: vi.fn(() => true),
  stopInstance: vi.fn(async () => ({ ok: true })),
  addArchitect: vi.fn(async () => ({ success: true, name: 'sibling', terminalId: 'term-arch-sibling' })),
  removeArchitect: vi.fn(async () => ({ success: true })),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: vi.fn(() => new Map()),
  getTerminalManager: mockGetTerminalManager,
  getWorkspaceTerminalsEntry: mockGetWorkspaceTerminalsEntry,
  getNextShellId: mockGetNextShellId,
  saveTerminalSession: vi.fn(),
  isSessionPersistent: mockIsSessionPersistent,
  deleteTerminalSession: vi.fn(),
  removeTerminalFromRegistry: vi.fn(),
  deleteWorkspaceTerminalSessions: vi.fn(),
  saveFileTab: vi.fn(),
  deleteFileTab: vi.fn(),
  getTerminalsForWorkspace: mockGetTerminalsForWorkspace,
  getRehydratedTerminalsEntry: mockGetRehydratedTerminalsEntry,
  isStartupReconcileSettled: mockIsStartupReconcileSettled,
}));

vi.mock('../servers/tower-tunnel.js', () => ({
  handleTunnelEndpoint: vi.fn(async (_req: unknown, res: any, _sub: string) => {
    res.writeHead(200);
    res.end('tunnel');
  }),
}));

vi.mock('../servers/tower-messages.js', () => ({
  resolveTarget: (...args: unknown[]) => mockResolveTarget(...args),
  resolveAgentInRegistry: (...args: unknown[]) => mockResolveAgentInRegistry(...args),
  broadcastMessage: (...args: unknown[]) => mockBroadcastMessage(...args),
  isResolveError: (r: any) => mockIsResolveError(r),
}));

// Spec 1313: handleSend persists every send to global.db and delivers through the
// gate. Back it with a fresh in-memory DB per test so the mailbox ops are real
// (no over-mocking of the system under test); only the DB handle is injected.
vi.mock('../db/index.js', async (importActual) => ({
  ...(await importActual<typeof import('../db/index.js')>()),
  getGlobalDb: () => sendDbHolder.db,
  // `getDb` too (#219 round 6): `state.js` reads builders and architects through it, and
  // the send path consults those to decide whether a target is thread-backed. Left
  // unmocked it reached the real user-global database, so a route test's answer depended
  // on what happened to be registered on the machine running it.
  getDb: () => sendDbHolder.db,
}));

vi.mock('../servers/tower-utils.js', () => ({
  isRateLimited: vi.fn(() => false),
  normalizeWorkspacePath: (p: string) => p,
  getLanguageForExt: (ext: string) => ext,
  getMimeTypeForFile: () => 'application/octet-stream',
  serveStaticFile: vi.fn(() => false),
}));

// Keep the REAL request-auth helpers (CORS allowlist, key comparison, public-route
// list) under test; only stub isRequestAllowed so route tests need not thread a
// valid key, and parseJsonBody so bodies can be injected.
vi.mock('../utils/server-utils.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/server-utils.js')>()),
  isRequestAllowed: vi.fn(() => true),
  parseJsonBody: (...args: unknown[]) => mockParseJsonBody(...args),
}));

vi.mock('../servers/analytics.js', () => ({
  computeAnalytics: (...args: unknown[]) => mockComputeAnalytics(...args),
  clearAnalyticsCache: vi.fn(),
}));

vi.mock('../servers/overview.js', () => ({
  OverviewCache: class {
    getOverview = mockOverviewGetOverview;
    invalidate = mockOverviewInvalidate;
  },
}));

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    log: vi.fn(),
    port: 4100,
    version: '9.9.9',
    startedAt: '2026-01-01T00:00:00.000Z',
    templatePath: '/tmp/tower.html',
    reactDashboardPath: '/tmp/dashboard/dist',
    hasReactDashboard: false,
    getShellperManager: () => null,
    broadcastNotification: vi.fn(),
    addSseClient: vi.fn(() => true),
    removeSseClient: vi.fn(),
    ...overrides,
  };
}

function makeReq(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:4100', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function makeRes(): { res: http.ServerResponse; body: () => string; statusCode: () => number; headers: () => Record<string, string> } {
  const chunks: string[] = [];
  let code = 200;
  const hdrs: Record<string, string> = {};

  const res = {
    writeHead: vi.fn((status: number, h?: Record<string, string>) => {
      code = status;
      if (h) Object.assign(hdrs, h);
    }),
    setHeader: vi.fn((k: string, v: string) => { hdrs[k] = v; }),
    end: vi.fn((data?: string | Buffer) => {
      if (data) chunks.push(typeof data === 'string' ? data : data.toString());
    }),
    write: vi.fn((data: string) => { chunks.push(data); }),
  } as any;

  return {
    res,
    body: () => chunks.join(''),
    statusCode: () => code,
    headers: () => hdrs,
  };
}

// ============================================================================
/**
 * A mock PtySession the Spec 1313 render-gate can classify. `ring` is the rendered
 * composer content: `'❯ '` is a clean claude prompt (gate → deliver); `'❯ draft'`
 * is an occupied line (gate → hold busy). `command: 'claude'` resolves the profile.
 *
 * Round 2: the gate reads the session's persistent `gateScreen` mirror, not the ring, so the
 * mock feeds the rendered frame into a real {@link SessionScreen} (fed exactly the PTY bytes:
 * the composer line + the bounding rule the TUI draws below the input — the render-gate
 * requires that proven lower bound, else a bare marker is an indeterminate partial and is held).
 * `bytesWritten` is the monotone change token the delivery path samples.
 */
function gateSession(
  mockWrite: (data: string) => void,
  ring: string,
  writable = true,
  command = 'claude',
) {
  const raw = `${ring}\r\n${'─'.repeat(20)}\r\n`;
  const gateScreen = new SessionScreen(80, 24);
  gateScreen.feed(raw);
  return {
    // Model a live PTY: every write lands. The delivery path now threads the write's
    // boolean (Spec 1313 silent-loss fix), so a double whose write returned undefined
    // would read as a DROPPED write and be held. Wrap mockWrite so call-assertions still
    // see it while the write reports success.
    write: (data: string): boolean => { mockWrite(data); return true; },
    pid: 1234,
    writable,
    isUserIdle: () => true,
    composing: false,
    // Issue #196: the interrupt path resolves the harness from this, so a test can
    // present an opencode terminal by passing `command: 'opencode'`.
    command,
    launchArgs: [] as string[],
    cwd: '/tmp/ws',
    info: { cols: 80, rows: 24 },
    bytesWritten: raw.length,
    gateScreen,
  };
}

// Tests
// ============================================================================

describe('tower-routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh in-memory global.db for the Spec 1313 send path (real mailbox ops).
    sendDbHolder.db = new Database(':memory:');
    sendDbHolder.db.exec(GLOBAL_SCHEMA);
    // Default: the registry fallback finds nothing (so a NOT_FOUND target 404s as
    // before, unless a test opts a known offline agent in).
    mockResolveAgentInRegistry.mockReturnValue({ code: 'NOT_FOUND', message: 'not registered' });
    mockGetInstances.mockResolvedValue([]);
    mockGetTerminalManager.mockReturnValue({
      listSessions: mockListSessions.mockReturnValue([]),
      getSession: mockGetSession.mockReturnValue(null),
      assertCanCreateSession: vi.fn(),
    });
    mockGetWorkspaceTerminalsEntry.mockReturnValue({
      architects: new Map(),
      shells: new Map(),
      builders: new Map(),
      fileTabs: new Map(),
    });
    mockGetTerminalsForWorkspace.mockResolvedValue({ terminals: [] });
  });

  // =========================================================================
  // Security / CORS
  // =========================================================================

  describe('security and CORS', () => {
    it('returns 401 when isRequestAllowed returns false', async () => {
      const { isRequestAllowed } = await import('../utils/server-utils.js');
      (isRequestAllowed as any).mockReturnValueOnce(false);

      const req = makeReq('GET', '/api/terminals');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(401);
    });

    it('sets CORS headers for localhost origin', async () => {
      const req = makeReq('GET', '/health', { origin: 'http://localhost:3000' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
      expect(headers()['Access-Control-Allow-Methods']).toBe('GET, POST, PATCH, DELETE, OPTIONS');
    });

    it('does not reflect an arbitrary https origin (allowlist, not reflect-any)', async () => {
      const req = makeReq('GET', '/health', { origin: 'https://example.com' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('does not set CORS origin for non-matching origins', async () => {
      const req = makeReq('GET', '/health', { origin: 'http://evil.com:8080' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('allows the codev-tower-key header in CORS', async () => {
      const req = makeReq('GET', '/health', { origin: 'http://localhost:3000' });
      const { res, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(headers()['Access-Control-Allow-Headers']).toContain('codev-tower-key');
    });

    it('handles OPTIONS preflight', async () => {
      const req = makeReq('OPTIONS', '/api/terminals');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
    });
  });

  // =========================================================================
  // Health check
  // =========================================================================

  describe('GET /health', () => {
    it('returns healthy status with workspace counts', async () => {
      mockGetInstances.mockResolvedValue([
        { running: true, workspacePath: '/a' },
        { running: false, workspacePath: '/b' },
      ]);

      const req = makeReq('GET', '/health');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.status).toBe('healthy');
      expect(parsed.activeWorkspaces).toBe(1);
      expect(parsed.totalWorkspaces).toBe(2);
    });

    it('reports readiness from the startup-reconcile barrier (#997)', async () => {
      mockGetInstances.mockResolvedValue([]);

      // Pre-reconcile: barrier not yet settled → ready:false
      mockIsStartupReconcileSettled.mockReturnValueOnce(false);
      const notReady = makeRes();
      await handleRequest(makeReq('GET', '/health'), notReady.res, makeCtx());
      expect(JSON.parse(notReady.body()).ready).toBe(false);

      // Post-reconcile: barrier settled → ready:true
      mockIsStartupReconcileSettled.mockReturnValueOnce(true);
      const ready = makeRes();
      await handleRequest(makeReq('GET', '/health'), ready.res, makeCtx());
      expect(JSON.parse(ready.body()).ready).toBe(true);
    });
  });

  // =========================================================================
  // Version probe (#983)
  // =========================================================================

  describe('GET /api/version', () => {
    it('returns the running Tower version and start time from context', async () => {
      const req = makeReq('GET', '/api/version');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx({ version: '3.2.1', startedAt: '2026-06-06T12:00:00.000Z' }));

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed).toEqual({ version: '3.2.1', startedAt: '2026-06-06T12:00:00.000Z' });
    });
  });

  // =========================================================================
  // Terminal list
  // =========================================================================

  describe('GET /api/terminals', () => {
    it('returns terminal list', async () => {
      mockListSessions.mockReturnValue([{ id: 'term-1' }]);

      const req = makeReq('GET', '/api/terminals');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.terminals).toEqual([{ id: 'term-1' }]);
    });
  });

  describe('POST /api/terminals capacity ordering (Issue #174)', () => {
    const persistentBody = {
      command: '/bin/bash',
      cwd: '/tmp/workspace',
      persistent: true,
      workspacePath: '/tmp/workspace',
      type: 'builder',
      roleId: '0174',
    };

    it('rejects at capacity before spawning a shellper', async () => {
      mockParseJsonBody.mockResolvedValueOnce(persistentBody);
      const createSession = vi.fn().mockRejectedValue(
        new Error('Maximum 100 sessions reached; Top workspaces: /busy (100)'),
      );
      const manager = {
        assertCanCreateSession: vi.fn(() => {
          throw new Error('Maximum 100 sessions reached; Top workspaces: /busy (100)');
        }),
        createSession,
      };
      mockGetTerminalManager.mockReturnValue(manager);
      const shellperCreate = vi.fn().mockRejectedValue(new Error('spawn should not run'));

      const { res, body } = makeRes();
      await handleRequest(makeReq('POST', '/api/terminals'), res, makeCtx({
        getShellperManager: () => ({ createSession: shellperCreate } as any),
      }));

      expect(shellperCreate).not.toHaveBeenCalled();
      expect(createSession).toHaveBeenCalledTimes(1); // fallback repeats the cap check
      expect(JSON.parse(body()).message).toContain('Top workspaces: /busy (100)');
    });

    it('kills a shellper if the post-spawn adoption check fails', async () => {
      mockParseJsonBody.mockResolvedValueOnce(persistentBody);
      const manager = {
        assertCanCreateSession: vi.fn(),
        createSessionRaw: vi.fn(() => { throw new Error('Maximum 100 sessions reached'); }),
        createSession: vi.fn().mockRejectedValue(new Error('Maximum 100 sessions reached')),
        killSession: vi.fn(),
      };
      mockGetTerminalManager.mockReturnValue(manager);
      const killSession = vi.fn().mockResolvedValue(undefined);
      const shellperManager = {
        createSession: vi.fn().mockResolvedValue({ waitForReplay: vi.fn().mockResolvedValue(Buffer.alloc(0)) }),
        getSessionInfo: vi.fn().mockReturnValue({ pid: 4321, socketPath: '/tmp/session.sock', startTime: 1 }),
        killSession,
      };

      const { res } = makeRes();
      await handleRequest(makeReq('POST', '/api/terminals'), res, makeCtx({
        getShellperManager: () => shellperManager as any,
      }));

      expect(shellperManager.createSession).toHaveBeenCalledTimes(1);
      expect(killSession).toHaveBeenCalledWith(expect.any(String));
      expect(manager.killSession).not.toHaveBeenCalled(); // raw adoption never registered
    });
  });

  // =========================================================================
  // API status
  // =========================================================================

  describe('GET /api/status', () => {
    it('returns instances', async () => {
      mockGetInstances.mockResolvedValue([{ workspacePath: '/p', running: true }]);

      const req = makeReq('GET', '/api/status');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.instances).toHaveLength(1);
    });
  });

  // =========================================================================
  // SSE events
  // =========================================================================

  describe('GET /api/events', () => {
    it('registers SSE client via context callbacks', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();

      await handleRequest(req, res, ctx);

      expect(ctx.addSseClient).toHaveBeenCalledTimes(1);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
      }));
    });

    it('removes SSE client on close', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();

      await handleRequest(req, res, ctx);

      // Simulate client disconnect
      req.emit('close');

      expect(ctx.removeSseClient).toHaveBeenCalledTimes(1);
    });

    it('removes SSE client on res close (Bugfix #580)', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();
      // Make res an EventEmitter so it can emit 'close'
      const resEmitter = new EventEmitter();
      Object.assign(res, { on: resEmitter.on.bind(resEmitter), emit: resEmitter.emit.bind(resEmitter) });

      await handleRequest(req, res, ctx);

      // Simulate response close (without request close)
      resEmitter.emit('close');

      expect(ctx.removeSseClient).toHaveBeenCalledTimes(1);
    });

    it('removes SSE client on res error (Bugfix #580)', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();
      const resEmitter = new EventEmitter();
      Object.assign(res, { on: resEmitter.on.bind(resEmitter), emit: resEmitter.emit.bind(resEmitter) });

      await handleRequest(req, res, ctx);

      // Simulate a write error on the response
      resEmitter.emit('error', new Error('EPIPE'));

      expect(ctx.removeSseClient).toHaveBeenCalledTimes(1);
    });

    it('only cleans up once even if multiple close events fire (Bugfix #580)', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();
      const resEmitter = new EventEmitter();
      Object.assign(res, { on: resEmitter.on.bind(resEmitter), emit: resEmitter.emit.bind(resEmitter) });

      await handleRequest(req, res, ctx);

      // Fire close on both req and res
      req.emit('close');
      resEmitter.emit('close');
      resEmitter.emit('error', new Error('EPIPE'));

      // Should only clean up once despite three events
      expect(ctx.removeSseClient).toHaveBeenCalledTimes(1);
    });

    it('returns 503 when addSseClient rejects at capacity (Bugfix #1124)', async () => {
      const ctx = makeCtx({ addSseClient: vi.fn(() => false) });
      const req = makeReq('GET', '/api/events');
      const { res, statusCode, headers, body } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(503);
      expect(headers()['Retry-After']).toBe('5');
      expect(body()).toContain('capacity');
      expect(ctx.removeSseClient).not.toHaveBeenCalled();
    });

    it('sends retry directive to space out reconnections (Bugfix #1124)', async () => {
      const ctx = makeCtx();
      const req = makeReq('GET', '/api/events');
      const { res, body } = makeRes();

      await handleRequest(req, res, ctx);

      expect(body()).toContain('retry: 5000');
    });

    it('does not register cleanup listeners when rejected (Bugfix #1124)', async () => {
      const ctx = makeCtx({ addSseClient: vi.fn(() => false) });
      const req = makeReq('GET', '/api/events');
      const { res } = makeRes();

      await handleRequest(req, res, ctx);

      // After rejection, close events should not call removeSseClient
      req.emit('close');
      expect(ctx.removeSseClient).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Notify
  // =========================================================================

  describe('POST /api/notify', () => {
    it('broadcasts notification via context', async () => {
      mockParseJsonBody.mockResolvedValueOnce({
        type: 'gate',
        title: 'Gate ready',
        body: 'Spec approval needed',
        workspace: '/my/workspace',
      });

      const ctx = makeCtx();
      const req = makeReq('POST', '/api/notify');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'gate',
        title: 'Gate ready',
        body: 'Spec approval needed',
        workspace: '/my/workspace',
      });
    });

    it('returns 400 when title or body is missing', async () => {
      mockParseJsonBody.mockResolvedValueOnce({ type: 'info' });

      const req = makeReq('POST', '/api/notify');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });
  });

  // =========================================================================
  // Dashboard
  // =========================================================================

  describe('GET /', () => {
    it('returns 500 when template read fails', async () => {
      // Use a non-existent template path — fs.readFileSync will throw
      const req = makeReq('GET', '/');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx({ templatePath: '/nonexistent/tower.html' }));

      expect(statusCode()).toBe(500);
      expect(body()).toContain('Error loading template');
    });

    it('returns 500 when template path is null', async () => {
      const req = makeReq('GET', '/');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx({ templatePath: null }));

      expect(statusCode()).toBe(500);
    });
  });

  // =========================================================================
  // Workspace routes - path decoding
  // =========================================================================

  describe('workspace routes', () => {
    it('returns 400 for missing encoded path', async () => {
      const req = makeReq('GET', '/workspace/');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });

    it('returns 400 for invalid base64url path', async () => {
      // "relative/path" decodes to non-absolute path
      const encoded = Buffer.from('relative/path').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });

    it('dispatches to workspace API state route', async () => {
      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed).toHaveProperty('architect');
      expect(parsed).toHaveProperty('builders');
      expect(parsed).toHaveProperty('utils');
    });

    it('includes lastDataAt in shell entries of /api/state response (Spec 467)', async () => {
      const now = Date.now();
      mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
        architects: new Map(),
        shells: new Map([['shell-1', 'term-abc']]),
        builders: new Map(),
        fileTabs: new Map(),
      });
      mockGetSession.mockReturnValue({
        label: 'Shell 1',
        pid: 1234,
        lastDataAt: now,
      });
      mockIsSessionPersistent.mockReturnValue(false);

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.utils).toHaveLength(1);
      expect(parsed.utils[0]).toMatchObject({
        id: 'shell-1',
        name: 'Shell 1',
        lastDataAt: now,
      });
    });

    it('returns tower_name as hostname instead of os.hostname() (Bugfix #470)', async () => {
      mockReadCloudConfig.mockReturnValue({
        tower_id: 'test-id',
        tower_name: 'mac',
        api_key: 'test-key',
        server_url: 'https://cloud.codevos.ai',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      const parsed = JSON.parse(body());
      expect(parsed.hostname).toBe('mac');
    });

    it('returns undefined hostname when no cloud config (Bugfix #470)', async () => {
      mockReadCloudConfig.mockReturnValue(null);

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      const parsed = JSON.parse(body());
      expect(parsed.hostname).toBeUndefined();
    });

    it('returns undefined hostname when cloud config throws (Bugfix #470)', async () => {
      mockReadCloudConfig.mockImplementation(() => { throw new Error('invalid JSON'); });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/state`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.hostname).toBeUndefined();
    });
  });

  // =========================================================================
  // 404 fallback
  // =========================================================================

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const req = makeReq('GET', '/unknown/path');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
    });
  });

  // =========================================================================
  // API workspaces
  // =========================================================================

  describe('GET /api/workspaces', () => {
    it('returns workspace list', async () => {
      mockGetInstances.mockResolvedValue([
        { workspacePath: '/p1', workspaceName: 'p1', running: true, proxyUrl: null, terminals: [] },
      ]);

      const req = makeReq('GET', '/api/workspaces');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.workspaces).toHaveLength(1);
      expect(parsed.workspaces[0].name).toBe('p1');
    });
  });

  // =========================================================================
  // Rate limiting on activate
  // =========================================================================

  describe('POST /api/workspaces/:path/activate', () => {
    it('returns 429 when rate limited', async () => {
      const { isRateLimited } = await import('../servers/tower-utils.js');
      (isRateLimited as any).mockReturnValueOnce(true);

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/activate`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(429);
      expect(JSON.parse(body()).error).toContain('Too many activations');
    });

    it('launches instance when not rate limited', async () => {
      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/activate`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
    });

    it('returns 400 with error body when launchInstance fails', async () => {
      const { launchInstance } = await import('../servers/tower-instances.js');
      (launchInstance as any).mockResolvedValueOnce({
        success: false,
        error: 'Failed to create architect terminal: spawn claude ENOENT',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/activate`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
      const json = JSON.parse(body());
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/Failed to create architect terminal/);
      expect(json.error).toMatch(/spawn claude ENOENT/);
    });
  });

  // =========================================================================
  // Spec 823: architects-updated SSE emission on add/remove
  // =========================================================================

  describe('Spec 823: architects-updated SSE emission', () => {
    const workspacePath = '/test/workspace';
    const encoded = Buffer.from(workspacePath).toString('base64url');

    it('handleAddArchitect emits architects-updated on success', async () => {
      mockParseJsonBody.mockResolvedValueOnce({ name: 'ob-refine' });
      const ctx = makeCtx();
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      expect(ctx.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
    });

    it('handleAddArchitect does NOT emit on failure', async () => {
      mockParseJsonBody.mockResolvedValueOnce({ name: 'bogus' });
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: false,
        error: 'Workspace not running',
      });

      const ctx = makeCtx();
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      // Failure status comes through, broadcast does NOT fire.
      expect(statusCode()).toBe(404);
      expect(ctx.broadcastNotification).not.toHaveBeenCalled();
    });

    it('handleRemoveArchitect emits architects-updated on success', async () => {
      const ctx = makeCtx();
      const req = makeReq('DELETE', `/api/workspaces/${encoded}/architects/ob-refine`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      expect(ctx.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
    });

    it('handleRemoveArchitect does NOT emit on failure', async () => {
      const { removeArchitect } = await import('../servers/tower-instances.js');
      (removeArchitect as any).mockResolvedValueOnce({
        success: false,
        error: 'Cannot remove main architect',
      });

      const ctx = makeCtx();
      const req = makeReq('DELETE', `/api/workspaces/${encoded}/architects/main`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(400);
      expect(ctx.broadcastNotification).not.toHaveBeenCalled();
    });

    it('emit body carries the workspace path so subscribers can disambiguate', async () => {
      mockParseJsonBody.mockResolvedValueOnce({ name: 'team-a' });
      const ctx = makeCtx();
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      const { res } = makeRes();

      await handleRequest(req, res, ctx);

      const callArg = (ctx.broadcastNotification as any).mock.calls[0][0];
      const parsedBody = JSON.parse(callArg.body);
      expect(parsedBody.workspace).toBe(workspacePath);
      expect(callArg.workspace).toBe(workspacePath);
    });

    // iter-1 review Codex finding: cover the two workspace-scoped remove
    // paths that emit architects-updated. These are the dashboard close-button
    // path (`DELETE /workspace/<encoded>/api/architects/:name`) and the mobile
    // TabBar close path (`DELETE /workspace/<encoded>/api/tabs/architect:<name>`).
    // The /api/workspaces/<encoded>/architects/... routes go through
    // handleRemoveArchitect (tested above); these alternate routes share the
    // same emit contract.

    it('handleWorkspaceRoutes DELETE /api/architects/:name emits architects-updated', async () => {
      const ctx = makeCtx();
      const req = makeReq('DELETE', `/workspace/${encoded}/api/architects/ob-refine`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(200);
      expect(ctx.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
    });

    it('handleWorkspaceRoutes DELETE /api/architects/:name does NOT emit on failure', async () => {
      const { removeArchitect } = await import('../servers/tower-instances.js');
      (removeArchitect as any).mockResolvedValueOnce({
        success: false,
        error: 'Cannot remove main architect',
      });

      const ctx = makeCtx();
      const req = makeReq('DELETE', `/workspace/${encoded}/api/architects/main`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(400);
      expect(ctx.broadcastNotification).not.toHaveBeenCalled();
    });

    it('handleWorkspaceTabDelete /api/tabs/architect:<name> emits architects-updated', async () => {
      // The tabId 'architect:<name>' branch in handleWorkspaceTabDelete (Spec
      // 786 PR iter-1) routes through removeArchitect() and must emit the
      // architects-updated event on success so VSCode refreshes.
      const ctx = makeCtx();
      const req = makeReq('DELETE', `/workspace/${encoded}/api/tabs/architect:ob-refine`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      // handleWorkspaceTabDelete writes 204 (No Content) on success.
      expect(statusCode()).toBe(204);
      expect(ctx.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(ctx.broadcastNotification).toHaveBeenCalledWith({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
    });

    it('handleWorkspaceTabDelete /api/tabs/architect:<name> does NOT emit on failure', async () => {
      const { removeArchitect } = await import('../servers/tower-instances.js');
      (removeArchitect as any).mockResolvedValueOnce({
        success: false,
        error: 'Architect not found',
      });

      const ctx = makeCtx();
      const req = makeReq('DELETE', `/workspace/${encoded}/api/tabs/architect:bogus`);
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(404);
      expect(ctx.broadcastNotification).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Annotate vendor route (Bugfix #269)
  // =========================================================================

  describe('annotate vendor route', () => {
    const workspacePath = '/test/workspace';
    const encoded = Buffer.from(workspacePath).toString('base64url');
    const tabId = 'test-tab';

    beforeEach(() => {
      mockGetWorkspaceTerminalsEntry.mockReturnValue({
        architects: new Map(),
        shells: new Map(),
        builders: new Map(),
        fileTabs: new Map([[tabId, { path: '/test/workspace/src/main.ts' }]]),
      });
    });

    it('serves vendor JS files with correct content type', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/prism.min.js`);
      const { res, statusCode, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(headers()['Content-Type']).toBe('application/javascript');
    });

    it('serves vendor CSS files with correct content type', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/prism-tomorrow.min.css`);
      const { res, statusCode, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(headers()['Content-Type']).toBe('text/css');
    });

    it('blocks path traversal in vendor route', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/..%2F..%2Fpackage.json`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });

    it('returns 404 for non-existent vendor files', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/nonexistent.js`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
    });

    it('rejects vendor files with disallowed extensions', async () => {
      const req = makeReq('GET', `/workspace/${encoded}/api/annotate/${tabId}/vendor/secret.txt`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });
  });

  // =========================================================================
  // GET /api/terminals/:id — the wire contract for quiescence (Spec 1273)
  // =========================================================================

  describe('GET /api/terminals/:id (Spec 1273 — lastDataAt on the wire)', () => {
    // Testing `session.info` alone would not pin this: the whole point of the
    // phase is that the field reaches a *client*, so afx refresh can measure
    // output quiescence instead of assuming a builder's turn has ended before
    // typing /clear into its terminal. This asserts the serialised response.
    it('serialises lastDataAt as an epoch-ms number', async () => {
      const lastDataAt = 1_753_660_000_000;
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({
          info: {
            id: 'term-42', pid: 4242, cols: 80, rows: 24, label: 'builder',
            status: 'running', createdAt: '2026-07-28T00:00:00.000Z', lastDataAt,
          },
        }),
        listSessions: () => [],
      });

      const req = makeReq('GET', '/api/terminals/term-42');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(typeof parsed.lastDataAt).toBe('number');
      expect(parsed.lastDataAt).toBe(lastDataAt);
    });

    it('returns 404 for an unknown terminal rather than a body without lastDataAt', async () => {
      mockGetTerminalManager.mockReturnValue({
        getSession: () => undefined,
        listSessions: () => [],
      });

      const req = makeReq('GET', '/api/terminals/term-gone');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
      expect(JSON.parse(body()).error).toBe('NOT_FOUND');
    });
  });

  // DELETE /api/terminals/:id (Bugfix #290)
  // =========================================================================

  describe('DELETE /api/terminals/:id', () => {
    const terminalId = 'term-123';

    it('removes terminal from both SQLite and in-memory registry on success', async () => {
      const { killTerminalWithShellper } = await import('../servers/tower-instances.js');
      (killTerminalWithShellper as any).mockResolvedValueOnce(true);

      const req = makeReq('DELETE', `/api/terminals/${terminalId}`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(204);
      const { deleteTerminalSession, removeTerminalFromRegistry } = await import('../servers/tower-terminals.js');
      expect(deleteTerminalSession).toHaveBeenCalledWith(terminalId);
      expect(removeTerminalFromRegistry).toHaveBeenCalledWith(terminalId);
    });

    it('does not call cleanup functions when terminal not found', async () => {
      const { killTerminalWithShellper } = await import('../servers/tower-instances.js');
      (killTerminalWithShellper as any).mockResolvedValueOnce(false);

      const req = makeReq('DELETE', `/api/terminals/${terminalId}`);
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
      const { deleteTerminalSession, removeTerminalFromRegistry } = await import('../servers/tower-terminals.js');
      expect(deleteTerminalSession).not.toHaveBeenCalled();
      expect(removeTerminalFromRegistry).not.toHaveBeenCalled();
    });

    // Issue #1261: "Tower isn't wired up yet" is not "no such terminal".
    // Answering 404 sent callers off hunting for a terminal that was there all
    // along; 503 + Retry-After tells them to try again instead.
    it('returns 503 rather than 404 when the instances module is not wired yet', async () => {
      const { instancesReady, killTerminalWithShellper } = await import('../servers/tower-instances.js');
      (instancesReady as any).mockReturnValueOnce(false);

      const req = makeReq('DELETE', `/api/terminals/${terminalId}`);
      const { res, statusCode, body, headers } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(503);
      expect(headers()['Retry-After']).toBe('1');
      expect(JSON.parse(body()).error).toBe('STARTING_UP');
      // And it must not have tried to kill anything on the way out.
      expect(killTerminalWithShellper).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Overview endpoints (Spec 0126 Phase 4)
  // =========================================================================

  describe('GET /api/overview', () => {
    it('returns overview data with workspace from query param', async () => {
      mockOverviewGetOverview.mockResolvedValueOnce({
        builders: [{ id: '42', issueNumber: 42 }],
        pendingPRs: [],
        backlog: [],
      });

      const req = makeReq('GET', '/api/overview?workspace=/test/workspace');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.builders).toHaveLength(1);
      expect(mockOverviewGetOverview).toHaveBeenCalledWith('/test/workspace', expect.any(Set));
    });

    it('returns empty data when no workspace is known', async () => {
      const req = makeReq('GET', '/api/overview');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.builders).toEqual([]);
      expect(parsed.pendingPRs).toEqual([]);
      expect(parsed.backlog).toEqual([]);
      // Issue 1104: the no-workspace branch must still honor the full
      // OverviewData contract — `architects` is required ('never undefined'),
      // and `recentlyClosed` likewise — so consumers don't have to branch.
      expect(parsed.recentlyClosed).toEqual([]);
      expect(parsed.architects).toEqual([]);
    });

    it('works via workspace-scoped route', async () => {
      mockOverviewGetOverview.mockResolvedValueOnce({
        builders: [{ id: '99', issueNumber: 99 }],
        pendingPRs: [],
        backlog: [],
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/workspace/${encoded}/api/overview`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.builders).toHaveLength(1);
    });

    it('refresh works via workspace-scoped route', async () => {
      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/workspace/${encoded}/api/overview/refresh`);
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(JSON.parse(body()).ok).toBe(true);
      expect(mockOverviewInvalidate).toHaveBeenCalled();
    });

    it('falls back to first known workspace when no query param', async () => {
      mockGetKnownWorkspacePaths.mockReturnValueOnce(['/my/workspace']);
      mockOverviewGetOverview.mockResolvedValueOnce({
        builders: [],
        pendingPRs: [],
        backlog: [],
      });

      const req = makeReq('GET', '/api/overview');
      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(mockOverviewGetOverview).toHaveBeenCalledWith('/my/workspace', expect.any(Set));
    });

    it('enriches the payload with the architect roster, main-first, dead sessions skipped (Issue 1104)', async () => {
      // Roster registration order is vscode → main → dead; `main` must surface
      // at index 0 and the dead (sessionless) registration must be dropped.
      mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
        architects: new Map([['vscode', 't-vscode'], ['main', 't-main'], ['dead', 't-dead']]),
        builders: new Map(),
        shells: new Map(),
        fileTabs: new Map(),
      });
      mockGetTerminalManager.mockReturnValue({ getSession: mockGetSession });
      mockGetSession.mockImplementation((id: string) =>
        id === 't-dead' ? undefined : { pid: 100, lastDataAt: 0 });
      mockIsSessionPersistent.mockReturnValue(false);
      mockOverviewGetOverview.mockResolvedValueOnce({ builders: [], pendingPRs: [], backlog: [] });

      const req = makeReq('GET', '/api/overview?workspace=/test/workspace');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.architects.map((a: { name: string }) => a.name)).toEqual(['main', 'vscode']);
    });

    it('emits an empty architect roster when the workspace has no architects (Issue 1104)', async () => {
      mockGetRehydratedTerminalsEntry.mockResolvedValueOnce({
        architects: new Map(),
        builders: new Map(),
        shells: new Map(),
        fileTabs: new Map(),
      });
      mockGetTerminalManager.mockReturnValue({ getSession: mockGetSession });
      mockOverviewGetOverview.mockResolvedValueOnce({ builders: [], pendingPRs: [], backlog: [] });

      const req = makeReq('GET', '/api/overview?workspace=/test/workspace');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(JSON.parse(body()).architects).toEqual([]);
    });
  });

  describe('POST /api/overview/refresh', () => {
    it('invalidates cache and returns ok', async () => {
      const req = makeReq('POST', '/api/overview/refresh');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(JSON.parse(body()).ok).toBe(true);
      expect(mockOverviewInvalidate).toHaveBeenCalledTimes(1);
    });

    it('broadcasts overview-changed SSE event on refresh (Bugfix #388)', async () => {
      const req = makeReq('POST', '/api/overview/refresh');
      const { res } = makeRes();
      const ctx = makeCtx();
      await handleRequest(req, res, ctx);

      expect(ctx.broadcastNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'overview-changed' }),
      );
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('catches and reports errors from route handlers', async () => {
      mockGetInstances.mockRejectedValue(new Error('db error'));

      const ctx = makeCtx();
      const req = makeReq('GET', '/health');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, ctx);

      expect(statusCode()).toBe(500);
      expect(JSON.parse(body()).error).toBe('db error');
      expect(ctx.log).toHaveBeenCalledWith('ERROR', expect.stringContaining('db error'));
    });
  });

  // ==========================================================================
  // POST /api/send — endpoint-level validation and error contract
  // ==========================================================================

  describe('POST /api/send', () => {
    it('returns 400 INVALID_PARAMS when "to" is missing', async () => {
      mockParseJsonBody.mockResolvedValue({ message: 'hello' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
      expect(JSON.parse(body()).message).toContain('to');
    });

    it('returns 400 INVALID_PARAMS when "message" is missing', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
      expect(JSON.parse(body()).message).toContain('message');
    });

    it('returns 400 INVALID_PARAMS when "to" is empty string', async () => {
      mockParseJsonBody.mockResolvedValue({ to: '  ', message: 'hello' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
    });

    it('returns 404 NOT_FOUND when target agent not found', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'unknown', message: 'test', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'Agent not found' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(404);
      expect(JSON.parse(body()).error).toBe('NOT_FOUND');
    });

    it('returns 409 AMBIGUOUS when multiple agents match', async () => {
      mockParseJsonBody.mockResolvedValue({ to: '42', message: 'test', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'AMBIGUOUS', message: 'Multiple matches' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(409);
      expect(JSON.parse(body()).error).toBe('AMBIGUOUS');
    });

    it('returns 400 INVALID_PARAMS when no workspace context (NO_CONTEXT)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'test' });
      mockResolveTarget.mockReturnValue({ code: 'NO_CONTEXT', message: 'No project context' });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(400);
      // NO_CONTEXT is mapped to INVALID_PARAMS per plan's error contract
      expect(JSON.parse(body()).error).toBe('INVALID_PARAMS');
    });

    // Spec 755 Phase 3: `from` must be forwarded to resolveTarget so the
    // resolver can apply affinity-aware architect routing. Without this
    // assertion a future refactor could drop sender-awareness silently.
    it('forwards `from` (sender) to resolveTarget for affinity-aware routing (Spec 755)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect',
        message: 'hi',
        from: 'spir-100',
        workspace: '/tmp/ws',
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-arch-sibling',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: vi.fn(), pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockResolveTarget).toHaveBeenCalledWith('architect', '/tmp/ws', 'spir-100', { exact: false });
    });

    it('forwards undefined `from` when sender is not supplied (non-builder send)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'cron', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-arch-main',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: vi.fn(), pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockResolveTarget).toHaveBeenCalledWith('architect', '/tmp/ws', undefined, { exact: false });
    });

    it('returns 200 delivered:true on a successful send to a clean prompt (Spec 1313)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ '), // clean, render-verified empty
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.resolvedTo).toBe('architect');
      expect(parsed.terminalId).toBe('term-001');
      expect(parsed.delivered).toBe(true);
      expect(parsed.held).toBe(false);
      expect(parsed.deferred).toBe(false);
      expect(typeof parsed.mailboxId).toBe('string');
      expect(mockWrite).toHaveBeenCalled();
    });

    it('holds (no-live-pty) instead of dropping when the shellper connection is down (#1198, Spec 1313)', async () => {
      // Pre-1313 this returned 503 and dropped the message. Now the send is
      // persisted and held; the backstop redelivers when the connection recovers.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-zombie',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ ', /* writable */ false),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.held).toBe(true);
      expect(parsed.reason).toBe('no-live-pty');
      expect(typeof parsed.mailboxId).toBe('string');
      expect(mockWrite).not.toHaveBeenCalled(); // never written to a dead line
    });

    /**
     * Issue #219 round 6 — the route-level lie.
     *
     * `deliverAgentMail` ends a `--no-enter` row to a thread-backed agent TERMINALLY: a
     * thread has no composer, `thread.turn.start` is the submit, and holding it would
     * raise a starvation notice with no remedy. The route reported that row as
     * `held: true, reason: 'no-live-pty'` — promising the sender a retry that cannot
     * happen, and handing back a mailbox id that lists nowhere.
     *
     * It is not enough to answer `delivered: false, held: false` either: the CLI's final
     * branch reads that as delivered. The refusal needs its own word.
     */
    it('reports a terminally refused --no-enter to a thread-backed agent as refused, not held', async () => {
      sendDbHolder.db
        .prepare(
          `INSERT INTO builders (id, workspace_path, name, status, phase, worktree, branch, type, thread_id, started_at)
           VALUES (?, ?, ?, 'implementing', 'implement', ?, ?, 'task', ?, ?)`,
        )
        .run('spir-thread', '/tmp/ws', 'spir-thread', '/tmp/ws/.builders/spir-thread', 'builder/spir-thread', 'thr-9', new Date().toISOString());
      // `--no-enter` arrives under `options`, which is where the route reads it.
      mockParseJsonBody.mockResolvedValue({
        to: 'spir-thread', message: 'gate reached', workspace: '/tmp/ws', options: { noEnter: true },
      });
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
      mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-thread', kind: 'builder' });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.refused).toBe(true);
      expect(parsed.held).toBe(false);
      expect(parsed.delivered).toBe(false);
      expect(parsed.refusedReason).toMatch(/no composer/);
      expect(parsed.refusedReason).toMatch(/Re-send without --no-enter/);
      // The row really is terminal, so the mailbox id the sender was handed lists nowhere
      // — which is exactly why calling it "held" was a lie.
      expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.status).toBe('dismissed');
      expect(mailbox.findHeldForAgent(sendDbHolder.db, '/tmp/ws', 'spir-thread')).toHaveLength(0);
    });

    /**
     * Round 8. The drainer writes a reason when it REFUSES something and deliberately
     * leaves it null when nothing was refused — a thread submission in flight is "pending,
     * not stuck". The route substituted a PTY word for that state, so `afx send` to a
     * HEALTHY thread-backed agent reported `no-live-pty`: a diagnosis from a vocabulary
     * that does not apply, for a state that already had a true answer.
     */
    it('a held row with no reason is reported with no reason, not a PTY word', async () => {
      sendDbHolder.db
        .prepare(
          `INSERT INTO builders (id, workspace_path, name, status, phase, worktree, branch, type, thread_id, started_at)
           VALUES (?, ?, ?, 'implementing', 'implement', ?, ?, 'task', ?, ?)`,
        )
        .run('spir-thread', '/tmp/ws', 'spir-thread', '/tmp/ws/.builders/spir-thread', 'builder/spir-thread', 'thr-9', new Date().toISOString());
      mockParseJsonBody.mockResolvedValue({ to: 'spir-thread', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
      mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-thread', kind: 'builder' });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.held).toBe(true);
      // Let the un-awaited submission's continuation run: the tick does not wait for it,
      // so without this the row is read before the delivery path has finished with it and
      // the assertion would pass for the wrong reason.
      await new Promise((r) => setTimeout(r, 10));
      // The row genuinely carries no reason — nothing refused it.
      expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.reason).toBeNull();
      // So neither does the report. The CLI renders this as "pending".
      expect(parsed.reason).toBeNull();
      expect(parsed.reason).not.toBe('no-live-pty');
    });

    it('a genuinely PTY-held row still reports its PTY reason', async () => {
      // The control. Without it the assertion above would hold just as well if every
      // held report had been emptied of its reason.
      mockParseJsonBody.mockResolvedValue({ to: 'spir-9', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
      mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-9', kind: 'builder' });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(JSON.parse(body()).reason).toBe('no-live-pty');
    });

    it('an ordinary send to the same thread-backed agent is still held, not refused', async () => {
      // The control. Without it the assertion above would hold just as well if every
      // thread-backed send had been turned into a refusal.
      sendDbHolder.db
        .prepare(
          `INSERT INTO builders (id, workspace_path, name, status, phase, worktree, branch, type, thread_id, started_at)
           VALUES (?, ?, ?, 'implementing', 'implement', ?, ?, 'task', ?, ?)`,
        )
        .run('spir-thread', '/tmp/ws', 'spir-thread', '/tmp/ws/.builders/spir-thread', 'builder/spir-thread', 'thr-9', new Date().toISOString());
      mockParseJsonBody.mockResolvedValue({ to: 'spir-thread', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
      mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-thread', kind: 'builder' });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.refused).toBeUndefined();
      expect(parsed.held).toBe(true);
      expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.status).toBe('held');
    });

    it('holds (no-live-pty) a normal send to a known offline agent instead of 404ing (Spec 1313 dead-session seam)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'spir-9', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
      // The registry knows this builder even though it has no live PTY.
      mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-9', kind: 'builder' });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.held).toBe(true);
      expect(parsed.reason).toBe('no-live-pty');
      expect(parsed.resolvedTo).toBe('spir-9');
      expect(typeof parsed.mailboxId).toBe('string');
      // And it is really persisted (drain-order query finds it).
      expect(mailbox.findHeldForAgent(sendDbHolder.db, '/tmp/ws', 'spir-9')).toHaveLength(1);
    });

    // Spec 1273: `escape` delivers a bare ESC keystroke straight to the PTY.
    // The buffer-bypass assertion is the load-bearing one — an interrupt that can
    // be deferred because someone recently typed in that terminal is not an
    // interrupt, and a wedged builder is precisely the case where you cannot wait.
    it('writes a bare ESC and never defers it, even when the user is actively typing (Spec 1273)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: '1273', message: '\x1b', workspace: '/tmp/ws', options: { escape: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-wedged',
        workspacePath: '/tmp/ws',
        agent: 'builder-aspir-1273',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        // isUserIdle() === false is what forces deferral on the normal send path.
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => false, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.deferred).toBe(false);
      // ESC written immediately and unformatted — no header/wrapper text.
      expect(mockWrite).toHaveBeenCalledWith('\x1b');
      expect(mockWrite.mock.calls[0][0]).toBe('\x1b');
    });

    it('accepts a lone ESC message body without tripping the non-empty guard (Spec 1273)', async () => {
      // The ESC recovery depends on `\x1b` surviving handleSend's trim(); a 400
      // here would mean the only mid-turn recovery had been silently broken.
      mockParseJsonBody.mockResolvedValue({
        to: '1273', message: '\x1b', workspace: '/tmp/ws', options: { escape: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-wedged',
        workspacePath: '/tmp/ws',
        agent: 'builder-aspir-1273',
      });
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: vi.fn(), pid: 1234, writable: true, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
    });

    it('fails loudly on a non-writable terminal instead of reporting a delivered ESC (Spec 1273)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: '1273', message: '\x1b', workspace: '/tmp/ws', options: { escape: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-zombie',
        workspacePath: '/tmp/ws',
        agent: 'builder-aspir-1273',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: false, isUserIdle: () => true, composing: false }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(503);
      expect(JSON.parse(body()).error).toBe('TERMINAL_NOT_WRITABLE');
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('leaves normal sends unaffected when escape is absent (Spec 1273 regression guard)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ '), // clean prompt → delivers
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode } = makeRes();

      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      // Formatted message, not a bare ESC.
      expect(mockWrite).toHaveBeenCalled();
      expect(mockWrite.mock.calls[0][0]).not.toBe('\x1b');
    });

    it('holds (busy) when the composer is occupied, writing nothing (Spec 1313)', async () => {
      // Pre-1313 this deferred on a 3s idle timer; now it holds on the render-gate
      // verdict — a draft in the composer means the line is occupied.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ half-typed draft'), // occupied → busy
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.held).toBe(true);
      expect(parsed.reason).toBe('busy');
      expect(parsed.deferred).toBe(true); // back-compat: held ⇒ deferred
      // The draft is never touched — nothing is written to an occupied line.
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('delivers immediately when interrupt:true even if user is typing (Spec 403)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect', message: 'urgent', workspace: '/tmp/ws',
        options: { interrupt: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => ({ write: mockWrite, pid: 1234, writable: true, isUserIdle: () => false, composing: true }),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.deferred).toBe(false);
      // Should have written Ctrl+C and the message
      expect(mockWrite).toHaveBeenCalled();
    });

    it('writes the message as one un-split write, Enter separate (Bugfix #481, via the gate)', async () => {
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ '),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res } = makeRes();

      await handleRequest(req, res, ctx);
      // The delivery awaits the paced write's completion, so both the message and
      // its trailing Enter have landed: the message is ONE un-split write, and the
      // Enter is a separate `\r` (Bugfix #481: never fused, never split mid-message).
      const writeCalls = mockWrite.mock.calls;
      expect(writeCalls[0][0]).toContain('hello');
      expect(writeCalls[0][0]).not.toContain('\r');
      expect(writeCalls[writeCalls.length - 1][0]).toBe('\r');
    });

    it('writes the message without Enter when noEnter is set (Bugfix #481)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect', message: 'hello', workspace: '/tmp/ws',
        options: { noEnter: true },
      });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ '),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res } = makeRes();

      await handleRequest(req, res, ctx);
      const writeCalls = mockWrite.mock.calls;
      expect(writeCalls.length).toBe(1); // message only — no trailing Enter write
      expect(writeCalls[0][0]).not.toMatch(/\r$/);
    });

    it('delivers when the composer renders a clean empty prompt (Spec 1313 gate)', async () => {
      // The pre-1313 idle/composing heuristics are gone; the render-gate is the
      // sole authority. A clean, verified-empty composer delivers immediately.
      mockParseJsonBody.mockResolvedValue({ to: 'architect', message: 'hello', workspace: '/tmp/ws' });
      mockResolveTarget.mockReturnValue({
        terminalId: 'term-001',
        workspacePath: '/tmp/ws',
        agent: 'architect',
      });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({
        getSession: () => gateSession(mockWrite, '❯ '),
        listSessions: () => [],
      });
      const req = makeReq('POST', '/api/send');
      const ctx = makeCtx();
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, ctx);
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.ok).toBe(true);
      expect(parsed.delivered).toBe(true);
      expect(parsed.deferred).toBe(false);
      // Message SHOULD be written — user is idle (Bugfix #492)
      expect(mockWrite).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /api/send — durable `--delay` (Spec 1313 round 3, changes 1 & 2)
  //
  // Change 1: a delayed send is RESOLVED, authorized, and PERSISTED at request time
  // with `not_before`, then deferred through the gate — uniform across live / offline
  // (registry-only) / unwritable targets, and durable across a Tower restart. Change 2:
  // a delayed `--interrupt` writes NO body here and marks nothing delivered; it keeps only
  // an in-memory timer for the ^C, guarded by `isStillLive` before AND inside the lock.
  // ==========================================================================
  describe('POST /api/send — durable --delay (Spec 1313 round 3)', () => {
    it('persists a scheduled row for a --delay to an offline (registry-only) agent and writes nothing now', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'spir-9', message: 'later', workspace: '/tmp/ws', options: { deliverAfter: 30 },
      });
      // No live terminal, but the registry knows the builder → a delayed send schedules against it.
      mockResolveTarget.mockReturnValue({ code: 'NOT_FOUND', message: 'no live terminal' });
      mockResolveAgentInRegistry.mockReturnValue({ workspacePath: '/tmp/ws', agent: 'spir-9', kind: 'builder' });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({ getSession: () => gateSession(mockWrite, '❯ '), listSessions: () => [] });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      const before = Date.now();
      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.scheduled).toBe(true);
      expect(parsed.resolvedTo).toBe('spir-9');
      expect(typeof parsed.mailboxId).toBe('string');
      expect(parsed.notBefore).toBeGreaterThanOrEqual(before + 30_000);
      expect(mockWrite).not.toHaveBeenCalled(); // deferred — nothing on the wire at request time

      // The row is really persisted with its due time, and is NOT eligible until due.
      const row = mailbox.getById(sendDbHolder.db, parsed.mailboxId);
      expect(row?.status).toBe('held');
      expect(row?.not_before).toBe(parsed.notBefore);
      expect(row?.terminal_id).toBeNull(); // registry-only target → no live terminal id
      expect(mailbox.findHeldForAgent(sendDbHolder.db, '/tmp/ws', 'spir-9', parsed.notBefore - 1)).toHaveLength(0);
      expect(mailbox.findHeldForAgent(sendDbHolder.db, '/tmp/ws', 'spir-9', parsed.notBefore)).toHaveLength(1);
    });

    it('schedules a --delay to a live target at request time without writing (durable, deferred to the gate)', async () => {
      mockParseJsonBody.mockResolvedValue({
        to: 'architect', message: 'later', workspace: '/tmp/ws', options: { deliverAfter: 10 },
      });
      mockResolveTarget.mockReturnValue({ terminalId: 'term-live', workspacePath: '/tmp/ws', agent: 'architect' });
      const mockWrite = vi.fn();
      mockGetTerminalManager.mockReturnValue({ getSession: () => gateSession(mockWrite, '❯ '), listSessions: () => [] });
      const req = makeReq('POST', '/api/send');
      const { res, statusCode, body } = makeRes();

      await handleRequest(req, res, makeCtx());
      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.scheduled).toBe(true);
      expect(typeof parsed.mailboxId).toBe('string');
      expect(mockWrite).not.toHaveBeenCalled(); // delivery is deferred to the gated drainer at due time
      expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.not_before).toBe(parsed.notBefore);
    });

    describe('delayed --interrupt: the ^C timer is guarded by isStillLive (change 2)', () => {
      afterEach(() => {
        shutdownDelayedSends();
        resetSubmissionChains();
        vi.useRealTimers();
      });

      it('Tower shutdown BEFORE the due time fires no ^C and marks nothing delivered (outer guard)', async () => {
        vi.useFakeTimers();
        mockParseJsonBody.mockResolvedValue({
          to: 'architect', message: 'urgent', workspace: '/tmp/ws', options: { interrupt: true, deliverAfter: 5 },
        });
        mockResolveTarget.mockReturnValue({ terminalId: 'term-i', workspacePath: '/tmp/ws', agent: 'architect' });
        const mockWrite = vi.fn();
        mockGetTerminalManager.mockReturnValue({ getSession: () => gateSession(mockWrite, '❯ '), listSessions: () => [] });
        const req = makeReq('POST', '/api/send');
        const { res, statusCode, body } = makeRes();

        await handleRequest(req, res, makeCtx());
        expect(statusCode()).toBe(200);
        const parsed = JSON.parse(body());
        expect(parsed.scheduled).toBe(true);
        expect(mockWrite).not.toHaveBeenCalled(); // nothing written at request time (change 2)

        shutdownDelayedSends();                 // Tower restarts while the ^C timer is pending
        await vi.advanceTimersByTimeAsync(5000); // the due time arrives on the (now dead) timer

        expect(mockWrite).not.toHaveBeenCalled(); // no ^C — the guard bailed; only the nudge is lost
        expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.status).toBe('held'); // never falsely delivered
      });

      it('Tower shutdown WHILE the submission lock is held fires no ^C (inner re-check)', async () => {
        vi.useFakeTimers();
        // Pre-occupy term-i's submission lock with a manually-released promise, so the ^C
        // submission chains BEHIND it — reproducing the shutdown-during-lock-wait window.
        let releaseLock!: () => void;
        const lockHeld = new Promise<void>((r) => { releaseLock = r; });
        submitToSession('term-i', () => 1, { sleep: () => lockHeld });

        mockParseJsonBody.mockResolvedValue({
          to: 'architect', message: 'urgent', workspace: '/tmp/ws', options: { interrupt: true, deliverAfter: 5 },
        });
        mockResolveTarget.mockReturnValue({ terminalId: 'term-i', workspacePath: '/tmp/ws', agent: 'architect' });
        const mockWrite = vi.fn();
        mockGetTerminalManager.mockReturnValue({ getSession: () => gateSession(mockWrite, '❯ '), listSessions: () => [] });
        const req = makeReq('POST', '/api/send');
        const { res, body } = makeRes();

        await handleRequest(req, res, makeCtx());
        const parsed = JSON.parse(body());

        // Due time: the ^C timer fires while still live → its outer check passes and it QUEUES
        // the ^C submission behind the held lock (which has not released yet).
        await vi.advanceTimersByTimeAsync(5000);
        expect(mockWrite).not.toHaveBeenCalled(); // still waiting for the lock

        // Now Tower shuts down (generation bump) DURING the lock-wait, then the lock drains.
        shutdownDelayedSends();
        releaseLock();
        for (let i = 0; i < 20; i++) await Promise.resolve(); // flush the queued submission

        expect(mockWrite).not.toHaveBeenCalled(); // the inside-the-lock isStillLive() re-check bailed
        expect(mailbox.getById(sendDbHolder.db, parsed.mailboxId)?.status).toBe('held'); // not falsely delivered
      });
    });

    // =====================================================================
    // Issue #196: --interrupt resolves its byte from the target's harness.
    // Asserted on the BYTES WRITTEN, not on a return value — the bug was a
    // successful call that put a fatal byte on the wire.
    // =====================================================================
    describe('--interrupt resolves the signal per harness (#196)', () => {
      const CTRL_C = '\x03';
      const ESC = '\x1b';
      const CTRL_U = '\x15';

      afterEach(() => {
        shutdownDelayedSends();
        resetSubmissionChains();
        vi.useRealTimers();
      });

      /** Drive one immediate `--interrupt` against a session running `command`. */
      async function interruptSessionRunning(command: string): Promise<string[]> {
        const written: string[] = [];
        mockParseJsonBody.mockResolvedValue({
          to: 'builder-x', message: 'stop', workspace: '/tmp/ws',
          options: { interrupt: true },
        });
        mockResolveTarget.mockReturnValue({
          terminalId: 'term-001', workspacePath: '/tmp/ws', agent: 'builder-x',
        });
        mockGetTerminalManager.mockReturnValue({
          getSession: () => gateSession((d) => written.push(d), '\u276f ', true, command),
          listSessions: () => [],
        });
        const { res, statusCode } = makeRes();
        await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
        expect(statusCode()).toBe(200);
        return written;
      }

      it('sends Ctrl+C to a ctrl-c harness (claude)', async () => {
        const written = await interruptSessionRunning('claude');
        expect(written).toContain(CTRL_C);
        expect(written).not.toContain(ESC);
      });

      it('sends Ctrl+C to a ctrl-c harness (codex)', async () => {
        expect(await interruptSessionRunning('codex')).toContain(CTRL_C);
      });

      it('NEVER sends Ctrl+C to an esc harness (opencode quits on it)', async () => {
        const written = await interruptSessionRunning('opencode');
        // The load-bearing assertion: not one byte written is \x03.
        expect(written).not.toContain(CTRL_C);
        expect(written.join('')).not.toContain(CTRL_C);
        // Both halves of --interrupt's contract still land, as two bytes rather than one:
        // ESC ends the turn (opencode's session_interrupt) and Ctrl+U clears the composer
        // (input_delete_to_line_start). Sending only ESC would leave the flag safe but
        // useless for the job #21 documents it for.
        expect(written).toContain(ESC);
        expect(written).toContain(CTRL_U);
        expect(written.indexOf(ESC)).toBeLessThan(written.indexOf(CTRL_U));
      });

      it('sends ONE byte to claude/codex, where Ctrl+C is both halves', async () => {
        // Deduplication: the pre-fix behaviour is preserved byte-for-byte on the harnesses
        // that were never broken.
        for (const command of ['claude', 'codex']) {
          const written = await interruptSessionRunning(command);
          expect(written.filter((byte) => byte === CTRL_C)).toHaveLength(1);
          expect(written).not.toContain(ESC);
          expect(written).not.toContain(CTRL_U);
        }
      });

      it('writes EXACTLY one \\x03 and no other control byte on claude', async () => {
        // The load-bearing claim of this change for the harnesses that were never broken:
        // their behaviour does not change. Asserted as a byte comparison rather than
        // inferred from a passing suite — a spurious ESC here would trade a bug nobody
        // has for a bug everybody has.
        const written = await interruptSessionRunning('claude');

        // Nothing goes out before the interrupt.
        expect(written[0]).toBe(CTRL_C);

        // And across the WHOLE exchange exactly one control byte goes out: that \\x03.
        // Not "at least one" — the dedup must not let a second byte ride along.
        const controls = written.filter(
          (byte) => byte === CTRL_C || byte === ESC || byte === CTRL_U,
        );
        expect(controls).toEqual([CTRL_C]);
      });

      it('NEVER sends Ctrl+C to a session whose agent cannot be identified', async () => {
        // Fail-safe: an unresolvable command must not inherit claude's default, and gets
        // NO guessed clear key either — just the safe interrupt.
        const written = await interruptSessionRunning('/usr/local/bin/some-new-tui');
        expect(written).not.toContain(CTRL_C);
        expect(written).not.toContain(CTRL_U);
        expect(written).toContain(ESC);
      });

      it('reports the keystrokes it actually sent', async () => {
        mockParseJsonBody.mockResolvedValue({
          to: 'builder-x', message: 'stop', workspace: '/tmp/ws', options: { interrupt: true },
        });
        mockResolveTarget.mockReturnValue({
          terminalId: 'term-001', workspacePath: '/tmp/ws', agent: 'builder-x',
        });
        mockGetTerminalManager.mockReturnValue({
          getSession: () => gateSession(vi.fn(), '\u276f ', true, 'opencode'),
          listSessions: () => [],
        });
        const { res, body } = makeRes();
        await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
        expect(JSON.parse(body()).interruptKeys).toEqual(['ESC', 'Ctrl+U']);
      });

      it('applies the same table on the DELAYED interrupt path', async () => {
        vi.useFakeTimers();
        const written: string[] = [];
        mockParseJsonBody.mockResolvedValue({
          to: 'builder-x', message: 'stop', workspace: '/tmp/ws',
          options: { interrupt: true, deliverAfter: 5 },
        });
        mockResolveTarget.mockReturnValue({
          terminalId: 'term-i', workspacePath: '/tmp/ws', agent: 'builder-x',
        });
        mockGetTerminalManager.mockReturnValue({
          getSession: () => gateSession((d) => written.push(d), '\u276f ', true, 'opencode'),
          listSessions: () => [],
        });
        const { res, statusCode } = makeRes();
        await handleRequest(makeReq('POST', '/api/send'), res, makeCtx());
        expect(statusCode()).toBe(200);
        expect(written).toEqual([]); // nothing at request time

        await vi.advanceTimersByTimeAsync(5000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // ESC is on the wire at once; Ctrl+U is DEFERRED by the settle, so it is not here
        // yet. That gap is the fix — an unspaced pair is read as Alt+u and clears nothing
        // (verified live: codev/research/196-esc-alt-encoding-probe.mjs).
        expect(written).toEqual([ESC]);

        await vi.advanceTimersByTimeAsync(ESCAPE_ENTER_DELAY_MS);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(written).toEqual([ESC, CTRL_U]);
        expect(written).not.toContain(CTRL_C);
      });
    });
  });

  // =========================================================================
  // GET /api/analytics (Spec 456)
  // =========================================================================

  describe('GET /api/analytics', () => {
    const fakeStats = {
      timeRange: '7d',
      activity: { prsMerged: 5, medianTimeToMergeHours: 2.5, issuesClosed: 4, medianTimeToCloseBugsHours: 1.2, projectsByProtocol: { spir: { count: 2, avgWallClockHours: 36 }, bugfix: { count: 1, avgWallClockHours: 2.5 } } },
      consultation: { totalCount: 10, totalCostUsd: 0.5, costByModel: {}, avgLatencySeconds: 12, successRate: 90, byModel: [], byReviewType: {}, byProtocol: {} },
    };

    beforeEach(() => {
      mockComputeAnalytics.mockResolvedValue(fakeStats);
      mockGetKnownWorkspacePaths.mockReturnValue(['/tmp/workspace']);
    });

    it('dispatches GET /api/analytics and returns JSON', async () => {
      const req = makeReq('GET', '/api/analytics?range=7');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.activity.prsMerged).toBe(5);
      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', '7', false);
    });

    it('returns 400 for invalid range', async () => {
      const req = makeReq('GET', '/api/analytics?range=999');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
      expect(JSON.parse(body()).error).toMatch(/Invalid range/);
      expect(mockComputeAnalytics).not.toHaveBeenCalled();
    });

    it('defaults range to 7 when omitted', async () => {
      const req = makeReq('GET', '/api/analytics');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', '7', false);
    });

    it('passes refresh=true when refresh=1 query param is set', async () => {
      const req = makeReq('GET', '/api/analytics?range=30&refresh=1');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', '30', true);
    });

    it('returns default empty response when no workspace is available', async () => {
      mockGetKnownWorkspacePaths.mockReturnValue([]);

      const req = makeReq('GET', '/api/analytics?range=30');
      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed.timeRange).toBe('30d');
      expect(parsed.activity.prsMerged).toBe(0);
      expect(parsed.activity).not.toHaveProperty('activeBuilders');
      expect(mockComputeAnalytics).not.toHaveBeenCalled();
    });

    it('accepts range=all', async () => {
      const req = makeReq('GET', '/api/analytics?range=all');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', 'all', false);
    });

    it('accepts range=1 (24h)', async () => {
      const req = makeReq('GET', '/api/analytics?range=1');
      const { res } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(mockComputeAnalytics).toHaveBeenCalledWith('/tmp/workspace', '1', false);
    });
  });

  // Spec 755: POST /api/workspaces/:encodedPath/architects
  describe('POST /api/workspaces/:path/architects (Spec 755)', () => {
    it('returns 200 with success body when addArchitect succeeds', async () => {
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: true,
        name: 'sibling',
        terminalId: 'term-arch-sibling',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      mockParseJsonBody.mockResolvedValueOnce({ name: 'sibling' });

      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      const parsed = JSON.parse(body());
      expect(parsed).toEqual({ success: true, name: 'sibling', terminalId: 'term-arch-sibling' });
      expect(addArchitect).toHaveBeenCalledWith('/test/workspace', 'sibling');
    });

    it('passes through undefined name to auto-number', async () => {
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: true,
        name: 'architect-2',
        terminalId: 'term-arch-2',
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      mockParseJsonBody.mockResolvedValueOnce({});

      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(200);
      expect(addArchitect).toHaveBeenCalledWith('/test/workspace', undefined);
    });

    it('returns 404 when workspace is not running', async () => {
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: false,
        error: "Workspace '/test/workspace' is not running. Start it with 'afx workspace start' first.",
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      mockParseJsonBody.mockResolvedValueOnce({});

      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(404);
    });

    it('returns 400 on validation error (e.g., collision)', async () => {
      const { addArchitect } = await import('../servers/tower-instances.js');
      (addArchitect as any).mockResolvedValueOnce({
        success: false,
        error: "Architect 'sibling' is already registered in this workspace.",
      });

      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('POST', `/api/workspaces/${encoded}/architects`);
      mockParseJsonBody.mockResolvedValueOnce({ name: 'sibling' });

      const { res, statusCode, body } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
      const parsed = JSON.parse(body());
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('already registered');
    });

    it('returns 405 for non-POST methods', async () => {
      const encoded = Buffer.from('/test/workspace').toString('base64url');
      const req = makeReq('GET', `/api/workspaces/${encoded}/architects`);

      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(405);
    });

    it('returns 400 for malformed workspace path encoding', async () => {
      const req = makeReq('POST', `/api/workspaces/relative-path/architects`);

      const { res, statusCode } = makeRes();
      await handleRequest(req, res, makeCtx());

      expect(statusCode()).toBe(400);
    });
  });
});
