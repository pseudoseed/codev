/** Regression coverage for issue #93's destructive `afx interrupt` default. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInterrupt } = vi.hoisted(() => ({
  mockInterrupt: vi.fn(async () => {}),
}));

vi.mock('../commands/interrupt.js', () => ({ interrupt: mockInterrupt }));

const { runAgentFarm } = await import('../cli.js');

describe('afx interrupt Enter opt-in (Bugfix #93)', () => {
  beforeEach(() => mockInterrupt.mockClear());

  async function optionsFor(args: string[]): Promise<Record<string, unknown>> {
    await runAgentFarm(['interrupt', '1273', ...args]);
    expect(mockInterrupt).toHaveBeenCalledTimes(1);
    return mockInterrupt.mock.calls[0][0] as Record<string, unknown>;
  }

  it('sends ESC alone by default', async () => {
    expect((await optionsFor([])).noEnter).toBe(true);
  });

  it('sends Enter only when explicitly requested', async () => {
    expect((await optionsFor(['--enter'])).noEnter).toBe(false);
  });

  it('keeps the old safe flag working for existing scripts', async () => {
    expect((await optionsFor(['--no-enter'])).noEnter).toBe(true);
  });
});
