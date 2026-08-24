/**
 * Issue #109: `afx status --json` must report porch phase/completion, not
 * the spawn snapshot. Fails if status() skips overlayBuilderFromPorch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockLoadState = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('../utils/config.js', () => ({
  getConfig: vi.fn(() => ({ workspaceRoot: '/fake/workspace' })),
}));

vi.mock('../state.js', () => ({
  loadState: (...args: unknown[]) => mockLoadState(...args),
}));

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({
    isRunning: (...a: unknown[]) => mockIsRunning(...a),
    getHealth: async () => null,
    getWorkspaceStatus: async () => null,
    getOverview: async () => null,
  }),
}));

vi.mock('../../lib/config.js', () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    kv: vi.fn(),
    blank: vi.fn(),
    row: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

import { status } from '../commands/status.js';

describe('afx status overlays porch state (issue #109)', () => {
  let worktree: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(false);
    worktree = join(tmpdir(), `bugfix-109-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const projectDir = join(worktree, 'codev', 'projects', 'bugfix-147-done');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'status.yaml'), 'id: bugfix-147\nphase: verified\nbuild_complete: true\n');
    mockLoadState.mockReturnValue({
      architect: null,
      architects: [],
      builders: [{
        id: 'builder-bugfix-147',
        name: 'bugfix-147',
        type: 'bugfix',
        status: 'implementing',
        phase: 'init',
        worktree,
        branch: 'builder/bugfix-147',
        terminalId: 'term-1',
        spawnedByArchitect: 'main',
      }],
      utils: [],
      annotations: [],
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(worktree, { recursive: true, force: true });
  });

  it('reports complete/verified for a finished builder whose db row is still implementing/init', async () => {
    await status({ json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(payload.builders).toHaveLength(1);
    expect(payload.builders[0].status).toBe('complete');
    expect(payload.builders[0].phase).toBe('verified');
  });
});
