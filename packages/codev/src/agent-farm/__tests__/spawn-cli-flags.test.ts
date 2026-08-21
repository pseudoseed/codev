/**
 * Issue #2: `--harness` / `--model` must actually REACH SpawnOptions.
 *
 * This test exists because of a specific, already-shipped bug rather than a
 * hypothetical one. `--model-id` on `consult` once shipped registered, parsed,
 * documented in `--help`, and covered by passing unit tests at the runner
 * level — and was completely inert, because the action built its options object
 * field-by-field and simply didn't copy it across (see
 * commands/consult/cli-options.ts). Nothing failed loudly; the flag just did
 * nothing.
 *
 * `afx spawn`'s action builds its options the same field-by-field way, so the
 * same gap is one forgotten line away. This asserts the flags arrive.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn(async () => {});
vi.mock('../commands/spawn.js', () => ({ spawn: spawnMock }));

const { runAgentFarm } = await import('../cli.js');

describe('afx spawn flag forwarding (Issue #2)', () => {
  beforeEach(() => spawnMock.mockClear());

  async function optionsFor(args: string[]): Promise<Record<string, unknown>> {
    await runAgentFarm(args);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    return spawnMock.mock.calls[0][0] as unknown as Record<string, unknown>;
  }

  it('forwards --harness and --model', async () => {
    const opts = await optionsFor(['spawn', '42', '--protocol', 'air', '--harness', 'opencode', '--model', 'x-ai/grok-4.6']);
    expect(opts.harness).toBe('opencode');
    expect(opts.model).toBe('x-ai/grok-4.6');
  });

  it('leaves both undefined when not passed, so config stays the fallback', async () => {
    const opts = await optionsFor(['spawn', '42', '--protocol', 'air']);
    expect(opts.harness).toBeUndefined();
    expect(opts.model).toBeUndefined();
  });

  it('forwards each flag independently', async () => {
    expect((await optionsFor(['spawn', '42', '--protocol', 'air', '--model', 'sonnet'])).model).toBe('sonnet');
    spawnMock.mockClear();
    expect((await optionsFor(['spawn', '42', '--protocol', 'air', '--harness', 'codex'])).harness).toBe('codex');
  });
});
