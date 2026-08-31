/**
 * Issue #219 — `afx workspace add-architect` reaches the thread path.
 *
 * #179 item 3 says "an architect is a thread whose worktree is the workspace
 * root". The branch that makes that true has existed since PR #177 and was
 * unreachable: `workspaceAddArchitect` gates on `tryGetThreadEngine()`, and
 * nothing in the command registered an engine. Every `afx` invocation is a fresh
 * process, so the gate was always false and a workspace configured for threads
 * still got a Tower terminal.
 *
 * The ordering is the assertion. A test that only checked "a thread was created
 * when an engine happened to be registered" would pass against the broken
 * version, because the broken version also works if some earlier line in the same
 * process installed one — which nothing does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureThreadBackendReady = vi.fn();
const closeThreadBackend = vi.fn();
const createArchitectThread = vi.fn();
const tryGetThreadEngine = vi.fn();
const architectThreadDefaults = vi.fn();
const setArchitectByName = vi.fn();
const addArchitect = vi.fn();

vi.mock('../thread-backend.js', () => ({
  ensureThreadBackendReady: (...args: unknown[]) => ensureThreadBackendReady(...args),
  closeThreadBackend: (...args: unknown[]) => closeThreadBackend(...args),
}));

vi.mock('../thread-runtime.js', () => ({
  createArchitectThread: (...args: unknown[]) => createArchitectThread(...args),
  tryGetThreadEngine: () => tryGetThreadEngine(),
  architectThreadDefaults: (...args: unknown[]) => architectThreadDefaults(...args),
}));

let architects: Array<{ name: string }> = [];

vi.mock('../state.js', () => ({
  getArchitects: () => architects,
  setArchitectByName: (...args: unknown[]) => setArchitectByName(...args),
}));

vi.mock('../utils/index.js', () => ({
  getConfig: () => ({ workspaceRoot: '/ws' }),
}));

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({
    isRunning: async () => true,
    addArchitect: (...args: unknown[]) => addArchitect(...args),
  }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { error: vi.fn(), success: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { workspaceAddArchitect } = await import('../commands/workspace-add-architect.js');

describe('workspace add-architect — the thread path is reachable in a fresh process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    architects = [];
    addArchitect.mockResolvedValue({ ok: true, name: 'main', terminalId: 't1' });
  });

  function threadEngineInstalled() {
    let installed = false;
    ensureThreadBackendReady.mockImplementation(async () => {
      installed = true;
      return 'installed';
    });
    tryGetThreadEngine.mockImplementation(() => (installed ? {} : undefined));
    createArchitectThread.mockResolvedValue('thr-architect-1');
    // #227 item 3: the pair the engine would resolve, which is what the row must record.
    architectThreadDefaults.mockReturnValue({ harness: 'claude', model: 'claude-opus-5' });
  }

  it('registers the backend BEFORE reading the engine, so a configured workspace gets a thread', async () => {
    // The engine only exists because `ensureThreadBackendReady` ran. This is the
    // production sequence: nothing else in an `afx` process installs one.
    let installed = false;
    ensureThreadBackendReady.mockImplementation(async () => {
      installed = true;
      return 'installed';
    });
    tryGetThreadEngine.mockImplementation(() => (installed ? {} : undefined));
    createArchitectThread.mockResolvedValue('thr-architect-1');
    architectThreadDefaults.mockReturnValue({ harness: 'claude', model: 'claude-opus-5' });

    await workspaceAddArchitect({ name: 'uiv2' });

    expect(ensureThreadBackendReady).toHaveBeenCalledWith('/ws');
    expect(createArchitectThread).toHaveBeenCalledWith({ name: 'uiv2', workspaceRoot: '/ws' });
    expect(setArchitectByName).toHaveBeenCalledWith(
      '/ws',
      'uiv2',
      // #227 item 3: harness and model are pinned on the row here, so the `attach` that
      // resumes this thread does not re-read them from a config that may have moved.
      expect.objectContaining({
        name: 'uiv2',
        threadId: 'thr-architect-1',
        harness: 'claude',
        model: 'claude-opus-5',
      }),
    );
    // Not both. A thread-backed architect that also took a Tower terminal would
    // be the dual-identity state `assertExclusiveIdentity` exists to forbid.
    expect(addArchitect).not.toHaveBeenCalled();
  });

  /**
   * The Tower path refuses a name already registered. This one consulted the
   * existing set only when auto-numbering, so an explicit collision created a
   * SECOND thread and `setArchitectByName` overwrote the row — leaving the first
   * thread alive on the server with nothing pointing at it. Two paths, one
   * contract, and only one of them destroyed state.
   */
  it('refuses an explicit name that is already registered, exactly as Tower does', async () => {
    threadEngineInstalled();
    architects = [{ name: 'uiv2' }];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(workspaceAddArchitect({ name: 'uiv2' })).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(1);
    // The two failures that matter: no second thread, and no row overwritten.
    expect(createArchitectThread).not.toHaveBeenCalled();
    expect(setArchitectByName).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('auto-numbers past the reserved default instead of colliding with it', async () => {
    threadEngineInstalled();
    architects = [{ name: 'main' }];

    await workspaceAddArchitect({});

    expect(createArchitectThread).toHaveBeenCalledWith({ name: 'architect-2', workspaceRoot: '/ws' });
  });

  it('the first architect on the thread path is the reserved default', async () => {
    threadEngineInstalled();

    await workspaceAddArchitect({});

    expect(createArchitectThread).toHaveBeenCalledWith({ name: 'main', workspaceRoot: '/ws' });
  });

  it('an unconfigured workspace is byte-for-byte unchanged — Tower, no thread', async () => {
    ensureThreadBackendReady.mockResolvedValue('not-configured');
    tryGetThreadEngine.mockReturnValue(undefined);

    await workspaceAddArchitect({ name: 'uiv2' });

    expect(createArchitectThread).not.toHaveBeenCalled();
    expect(addArchitect).toHaveBeenCalledWith('/ws', 'uiv2');
  });

  /**
   * Issue #271. The command hung past two minutes on real hardware, having
   * already created the thread AND written the row: an open WebSocket keeps the
   * event loop alive, and nothing closed it.
   *
   * Asserted AFTER `setArchitectByName`, not merely "was called". Closing the
   * socket before the row is written would exit a process whose registration had
   * not landed, which is a worse bug than the hang it replaces.
   */
  it('closes the thread backend after registering, so the process can exit', async () => {
    threadEngineInstalled();
    const order: string[] = [];
    setArchitectByName.mockImplementation(() => { order.push('register'); });
    closeThreadBackend.mockImplementation(() => { order.push('close'); });

    await workspaceAddArchitect({ name: 'uiv2' });

    expect(closeThreadBackend).toHaveBeenCalledWith('/ws');
    expect(order).toEqual(['register', 'close']);
  });

  /**
   * A create that throws must still close. Otherwise the failure path is the
   * hang: an error printed, and a process that never returns to print it from.
   */
  it('closes the thread backend even when the create fails', async () => {
    threadEngineInstalled();
    createArchitectThread.mockRejectedValue(new Error('server refused'));

    await expect(workspaceAddArchitect({ name: 'uiv2' })).rejects.toThrow('server refused');

    expect(closeThreadBackend).toHaveBeenCalledWith('/ws');
  });

  /**
   * A server that was named and could not be reached must not fall through to
   * Tower. `ensureThreadBackendReady` throws for exactly this reason, and
   * swallowing it here would restore the confusion it was written to remove.
   */
  it('a configured but unreachable server propagates rather than silently using Tower', async () => {
    ensureThreadBackendReady.mockRejectedValue(new Error('could not be reached: ECONNREFUSED'));
    tryGetThreadEngine.mockReturnValue(undefined);

    await expect(workspaceAddArchitect({ name: 'uiv2' })).rejects.toThrow(/could not be reached/);
    expect(addArchitect).not.toHaveBeenCalled();
    expect(createArchitectThread).not.toHaveBeenCalled();
  });
});
