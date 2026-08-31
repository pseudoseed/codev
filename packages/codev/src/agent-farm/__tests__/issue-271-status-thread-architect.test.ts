/**
 * Issue #271 — `afx status` can see a thread-backed architect.
 *
 * `afx workspace add-architect --name lan` created the thread, wrote the row, and
 * printed its success line. `afx status` then listed only the terminal-backed
 * `main`, which read as "the command did nothing" — the report on the issue says
 * exactly that, and it was wrong: the architect was registered the whole time.
 *
 * The cause is that the Architects section was built entirely from Tower's
 * terminal list, and a thread-backed architect has no terminal. Nothing was
 * missing from state; nothing looked there.
 *
 * The assertions below are on the ARCHITECTS section, not on the fact that some
 * line somewhere mentions the name. A run whose builder table happened to name
 * `lan` would satisfy a looser check while the section stayed empty.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLoadState = vi.fn();
const mockIsRunning = vi.fn();
const mockGetHealth = vi.fn();
const mockGetWorkspaceStatus = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLog = vi.fn();

vi.mock('../utils/config.js', () => ({
  getConfig: vi.fn(() => ({ workspaceRoot: '/fake/workspace' })),
}));

vi.mock('../state.js', () => ({
  loadState: (...args: any[]) => mockLoadState(...args),
}));

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({
    isRunning: (...a: any[]) => mockIsRunning(...a),
    getHealth: (...a: any[]) => mockGetHealth(...a),
    getWorkspaceStatus: (...a: any[]) => mockGetWorkspaceStatus(...a),
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
    info: (...args: any[]) => mockLoggerInfo(...args),
    kv: vi.fn(),
    blank: vi.fn(),
    row: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

import { status } from '../commands/status.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '');

/**
 * The lines under the `Architects:` heading, up to the next heading.
 *
 * Scoped deliberately. Reading the whole log would let a name printed anywhere
 * else stand in for a section that never rendered.
 */
function architectSection(): string[] {
  const lines = mockLoggerInfo.mock.calls.map((c: any[]) => stripAnsi(String(c[0])));
  const start = lines.indexOf('Architects:');
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith('  '));
  return end === -1 ? rest : rest.slice(0, end);
}

function architectTerminal(name: string) {
  return {
    id: `architect:${name}`,
    terminalId: `term-${name}`,
    type: 'architect',
    label: name,
    architectName: name,
    pid: 4242,
    active: true,
  };
}

describe('issue 271: afx status shows thread-backed architects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockGetHealth.mockResolvedValue({ ok: true });
  });

  it('lists an architect that has a thread and no terminal', async () => {
    mockGetWorkspaceStatus.mockResolvedValue({
      name: 'codev-1455',
      active: true,
      terminals: [architectTerminal('main')],
    });
    mockLoadState.mockReturnValue({
      architect: null,
      architects: [
        { name: 'main', cmd: 'claude', startedAt: 'now', terminalId: 'term-main' },
        {
          name: 'lan',
          cmd: '',
          startedAt: 'now',
          threadId: '2e2bd2c7-3ae7-4582-9d60-673da525a93f',
          harness: 'claude',
          model: 'claude-haiku-4-5',
        },
      ],
      builders: [],
      utils: [],
      annotations: [],
    });

    await status();

    const section = architectSection();
    expect(section.some((line) => line.includes('main'))).toBe(true);
    const lan = section.find((line) => line.includes('lan'));
    expect(lan, 'the thread-backed architect is absent from the Architects section').toBeDefined();
    expect(lan).toContain('thread=2e2bd2c7-3ae7-4582-9d60-673da525a93f');
    expect(lan).toContain('model=claude-haiku-4-5');
    // A thread has no pid and no port. Printing `pid=?` would report a value this
    // command failed to read, when there was never one to read.
    expect(lan).not.toContain('pid=');
  });

  /**
   * The workspace whose ONLY architect is thread-backed. The section used to be
   * nested inside a check on the terminal list, so this case printed nothing at
   * all — the emptier the workspace, the more complete the silence.
   */
  it('renders the section when there are no architect terminals at all', async () => {
    mockGetWorkspaceStatus.mockResolvedValue({ name: 'codev-1455', active: true, terminals: [] });
    mockLoadState.mockReturnValue({
      architect: null,
      architects: [{ name: 'lan', cmd: '', startedAt: 'now', threadId: 'thr-1' }],
      builders: [],
      utils: [],
      annotations: [],
    });

    await status();

    expect(architectSection()).toEqual([expect.stringContaining('lan')]);
  });

  /**
   * An architect Tower already listed must not appear twice. Tower is the source
   * for a terminal-backed one; state carries a row for it too.
   */
  it('does not print an architect twice when Tower already listed it', async () => {
    mockGetWorkspaceStatus.mockResolvedValue({
      name: 'codev-1455',
      active: true,
      terminals: [architectTerminal('main')],
    });
    mockLoadState.mockReturnValue({
      architect: null,
      // A row carrying BOTH is the dual-identity state the codebase forbids; it is
      // used here because a duplicate can only be produced by one, and this test
      // is about the de-duplication rather than about how the row got that way.
      architects: [{ name: 'main', cmd: 'claude', startedAt: 'now', terminalId: 'term-main', threadId: 'thr-1' }],
      builders: [],
      utils: [],
      annotations: [],
    });

    await status();

    expect(architectSection().filter((line) => line.includes('main'))).toHaveLength(1);
  });

  /**
   * The Tower-down fallback renders the same rows through different code. It
   * printed `cmd= started=…` for a thread-backed architect — `cmd` is empty
   * because there is no process — so the two paths disagreed about the same row:
   * one named the thread, the other named nothing.
   */
  it('names the thread in the Tower-down fallback too, instead of an empty cmd', async () => {
    mockIsRunning.mockResolvedValue(false);
    mockLoadState.mockReturnValue({
      architect: null,
      architects: [
        { name: 'main', cmd: 'claude', startedAt: 'T0', terminalId: 'term-main' },
        { name: 'lan', cmd: '', startedAt: 'T0', threadId: 'thr-1' },
      ],
      builders: [],
      utils: [],
      annotations: [],
    });

    await status();

    const lines = mockLoggerInfo.mock.calls.map((c: any[]) => stripAnsi(String(c[0])));
    const lan = lines.find((line) => line.includes('lan:'));
    expect(lan, 'the thread-backed architect is absent from the Tower-down listing').toBeDefined();
    expect(lan).toContain('thread=thr-1');
    expect(lan).not.toContain('cmd=');
    // The PTY-backed row is unchanged: it has a command, and that is what it says.
    expect(lines.find((line) => line.includes('main:'))).toContain('cmd=claude');
  });

  it('carries threadId into the --json payload, null for a PTY-backed architect', async () => {
    mockGetWorkspaceStatus.mockResolvedValue({ name: 'codev-1455', active: true, terminals: [] });
    mockLoadState.mockReturnValue({
      architect: null,
      architects: [
        { name: 'main', cmd: 'claude', startedAt: 'now', terminalId: 'term-main' },
        { name: 'lan', cmd: '', startedAt: 'now', threadId: 'thr-1' },
      ],
      builders: [],
      utils: [],
      annotations: [],
    });
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: any[]) => { mockLog(...args); });

    await status({ json: true });

    spy.mockRestore();
    const payload = JSON.parse(String(mockLog.mock.calls[0]?.[0]));
    expect(payload.architects).toEqual([
      { name: 'main', threadId: null },
      { name: 'lan', threadId: 'thr-1' },
    ]);
  });
});
