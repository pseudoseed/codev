/**
 * Issue #2 §5: `afx spawn --resume` must relaunch on the pair the builder was
 * spawned with.
 *
 * Every spawn path recomputes its agent from workspace config, resume included.
 * That was harmless while the agent WAS the config value. Once `(harness, model)`
 * is chosen per spawn, a resume that recomputes silently drops it and brings the
 * builder back on the workspace default — no error, no warning, just a different
 * model than it has been working with. A flag that quietly stops applying is
 * worse than no flag, which is why the pair is persisted and read back here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getBuilderMock = vi.fn();
vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getBuilder: getBuilderMock, upsertBuilder: vi.fn() };
});

const { selectionForResume } = await import('../commands/spawn.js');
const { resolveBuilderSelection } = await import('../utils/config.js');

describe('selectionForResume (Issue #2 §5)', () => {
  let ws: string;

  beforeEach(() => {
    getBuilderMock.mockReset();
    ws = mkdtempSync(join(tmpdir(), 'resume-sel-'));
    mkdirSync(join(ws, '.codev'), { recursive: true });
    writeFileSync(join(ws, '.codev', 'config.json'), JSON.stringify({ shell: { builder: 'claude' } }));
  });

  const config = () => ({ workspaceRoot: ws }) as never;
  const fresh = () => resolveBuilderSelection({}, ws);

  it('recovers the stored model when resuming with no flags', () => {
    // The core property: the builder comes back on sonnet even though the
    // workspace default names no model at all.
    getBuilderMock.mockReturnValue({ harness: 'claude', model: 'sonnet' });

    const out = selectionForResume({ resume: true }, config(), 'pir-2', fresh());

    expect(out.modelId).toBe('sonnet');
    expect(out.modelScriptFragment).toBe("--model 'sonnet'");
  });

  it('recovers the stored harness with no model, tolerating a raw null', () => {
    // `null` is the raw column value for a builder spawned with a harness but no
    // model. It must read as "no model requested", not be validated as a model id.
    getBuilderMock.mockReturnValue({ harness: 'opencode', model: null });
    const out = selectionForResume({ resume: true }, config(), 'pir-2', fresh());
    expect(out.harnessName).toBe('opencode');
    expect(out.command).toBe('opencode');
  });

  it('an explicit flag on the resume command WINS over the stored pair', () => {
    // That is how you deliberately move a running builder onto a different pair.
    getBuilderMock.mockReturnValue({ harness: 'claude', model: 'sonnet' });
    const explicit = resolveBuilderSelection({ model: 'opus' }, ws);

    const out = selectionForResume({ resume: true, model: 'opus' }, config(), 'pir-2', explicit);

    expect(out.modelId).toBe('opus');
    expect(getBuilderMock).not.toHaveBeenCalled();
  });

  it('is a no-op when not resuming', () => {
    getBuilderMock.mockReturnValue({ harness: 'opencode', model: 'x' });
    const original = fresh();
    expect(selectionForResume({}, config(), 'pir-2', original)).toBe(original);
    expect(getBuilderMock).not.toHaveBeenCalled();
  });

  it('a legacy row with neither value keeps todays behaviour', () => {
    // Rows written before v18 carry NULL for both. "Not recorded" must mean
    // "resolve from config", not "invent a pair".
    getBuilderMock.mockReturnValue({ harness: null, model: null });
    const original = fresh();
    expect(selectionForResume({ resume: true }, config(), 'pir-2', original)).toBe(original);
  });

  it('a missing row keeps todays behaviour', () => {
    getBuilderMock.mockReturnValue(null);
    const original = fresh();
    expect(selectionForResume({ resume: true }, config(), 'pir-2', original)).toBe(original);
  });

  it('re-validates the recovered pair rather than trusting it', () => {
    // A stored harness can be retired between spawn and resume. Failing loudly on
    // relaunch beats resurrecting a builder onto an agent that no longer resolves.
    getBuilderMock.mockReturnValue({ harness: 'gemini', model: null });
    expect(() => selectionForResume({ resume: true }, config(), 'pir-2', fresh())).toThrow(/retired/i);
  });
});
