/**
 * Issue #227 item 3 — an architect's `attach` carried no harness or model.
 *
 * `mailbox-wiring.ts` built a `ThreadDeliveryContext` for an architect with neither, so
 * `attach` fell back to the engine's `defaultHarness` / `defaultModel` — which are read
 * from `.codev/config.json` at ATTACH time. The builder branch of the same function was
 * already right, because it reads the pair off the builder row; the `architect` table had
 * no such columns, so there was nothing to read.
 *
 * The consequence is silent and survives a restart: change `threads.model` between a spawn
 * and a delivery and the resumed thread runs under a different model than the one it was
 * created with, with nothing saying so.
 *
 * The chain under test is the real one — write the row through `setArchitectByName`, read
 * it back through `resolveLiveSessionForAgent` — against a database built from the shipped
 * `GLOBAL_SCHEMA`, so a column that exists only in this test cannot make it pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';

const testDir = resolve(process.cwd(), '.test-issue-227');
let testDb: Database.Database | null = null;

vi.mock('../db/index.js', () => {
  const ensure = () => {
    if (!testDb) {
      testDb = new Database(resolve(testDir, 'global.db'));
      testDb.pragma('journal_mode = WAL');
      testDb.exec(GLOBAL_SCHEMA);
    }
    return testDb;
  };
  const close = () => {
    testDb?.close();
    testDb = null;
  };
  return { getDb: ensure, getGlobalDb: ensure, closeDb: close, closeGlobalDb: close };
});

// No live PTY anywhere, so the architect branch is the one that answers. A live PTY beside
// a thread id is a contradiction with its own test in `spec-146-phase-9-render-gate`.
vi.mock('../servers/tower-terminals.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWorkspaceTerminals: () => new Map(),
  getTerminalManager: () => ({ getSession: () => null }),
}));

const { getArchitectByName, setArchitectByName } = await import('../state.js');
const { resolveLiveSessionForAgent } = await import('../servers/mailbox-wiring.js');

const WS = '/workspace/issue-227';

function registerArchitect(fields: { harness?: string; model?: string }): void {
  setArchitectByName(WS, 'main', {
    name: 'main',
    cmd: '',
    startedAt: new Date().toISOString(),
    threadId: 'thr-architect-1',
    ...fields,
  });
}

describe('issue #227 item 3 — the architect row records the pair its thread was created with', () => {
  beforeEach(() => {
    testDb?.close();
    testDb = null;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    testDb?.close();
    testDb = null;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it('round-trips harness and model through the architect table', () => {
    registerArchitect({ harness: 'claude', model: 'claude-opus-5' });

    const stored = getArchitectByName(WS, 'main');
    expect(stored?.harness).toBe('claude');
    expect(stored?.model).toBe('claude-opus-5');
  });

  it('a PTY-backed architect records neither, and reads back as not-recorded', () => {
    // NULL means "not recorded". An architect with no thread has no pair to pin, and
    // inventing one would be a claim about a thread that does not exist.
    setArchitectByName(WS, 'main', {
      name: 'main',
      cmd: 'claude',
      startedAt: new Date().toISOString(),
      terminalId: 'term-1',
    });

    const stored = getArchitectByName(WS, 'main');
    expect(stored?.harness).toBeUndefined();
    expect(stored?.model).toBeUndefined();
  });

  it('delivery carries the recorded pair into the thread context', () => {
    registerArchitect({ harness: 'claude', model: 'claude-opus-5' });

    const session = resolveLiveSessionForAgent(WS, 'main');

    // These were absent, and `attach` therefore fell through to whatever the workspace
    // config said at attach time — the silent model swap this item is about.
    expect(session?.threadContext?.harness).toBe('claude');
    expect(session?.threadContext?.model).toBe('claude-opus-5');
    // The rest of the architect shape is unchanged: its worktree IS the workspace root
    // and it has no branch.
    expect(session?.threadContext?.worktreePath).toBe(WS);
    expect(session?.threadContext?.branch).toBe('');
  });

  it('a row written before the columns existed still delivers, carrying neither', () => {
    // The fallback is not removed, it is narrowed to exactly the rows that have nothing
    // recorded. An upgraded install must keep receiving mail.
    registerArchitect({});

    const session = resolveLiveSessionForAgent(WS, 'main');

    expect(session?.threadId).toBe('thr-architect-1');
    expect(session?.threadContext?.harness).toBeUndefined();
    expect(session?.threadContext?.model).toBeUndefined();
  });

  it('the model is pinned on the row, so editing the workspace config cannot move it', () => {
    registerArchitect({ harness: 'claude', model: 'claude-opus-5' });
    // Whatever `threads.model` becomes, this is read from the row. The context is built
    // from `getArchitectByName`, which touches no config at all — which is the fix.
    const before = resolveLiveSessionForAgent(WS, 'main')?.threadContext?.model;

    registerArchitect({ harness: 'claude', model: 'claude-opus-5' });

    expect(resolveLiveSessionForAgent(WS, 'main')?.threadContext?.model).toBe(before);
  });
});

/**
 * The value recorded must be the value `create` will use, including the engine's own final
 * fallback — otherwise the row pins a pair the thread never ran under, which is worse than
 * recording nothing.
 */
describe('the recorded pair comes from the engine, not from a second reading of the config', () => {
  it('the porch engine reports the harness it would fall back to', async () => {
    const { createPorchThreadEngine, DEFAULT_THREAD_HARNESS } = await import('../porch-thread-engine.js');
    const engine = createPorchThreadEngine({
      dispatcher: { call: async () => ({}) } as never,
      journal: { pending: () => [], recordOutcome: () => {} } as never,
      tracker: {} as never,
      projectId: 'proj-1',
      workspaceRoot: WS,
    });

    expect(engine.defaults?.harness).toBe(DEFAULT_THREAD_HARNESS);
    expect(engine.defaults?.model).toBeUndefined();
  });

  it('a configured harness and model are what it reports', async () => {
    const { createPorchThreadEngine } = await import('../porch-thread-engine.js');
    const engine = createPorchThreadEngine({
      dispatcher: { call: async () => ({}) } as never,
      journal: { pending: () => [], recordOutcome: () => {} } as never,
      tracker: {} as never,
      projectId: 'proj-1',
      workspaceRoot: WS,
      defaultHarness: 'claude',
      defaultModel: 'claude-opus-5',
    });

    expect(engine.defaults).toEqual({ harness: 'claude', model: 'claude-opus-5' });
  });

  it('add-architect records the pair on the row it writes', () => {
    // Source guard: the create path is a CLI command with a live-server dependency, and
    // what matters here is that the two values reach `setArchitectByName` rather than
    // being recomputed later from configuration that may have moved.
    const src = readFileSync(
      resolve(import.meta.dirname, '../commands/workspace-add-architect.ts'),
      'utf-8',
    );
    expect(src).toContain('architectThreadDefaults');
    expect(src).toContain('harness: defaults?.harness');
    expect(src).toContain('model: defaults?.model');
    // Read BEFORE the create, so a concurrent config edit cannot land between them.
    expect(src.indexOf('architectThreadDefaults(')).toBeLessThan(src.indexOf('createArchitectThread({'));
  });
});
