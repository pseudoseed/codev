/**
 * Issue #2: per-spawn `(harness, model)` resolution, and the pre-flight that
 * refuses a bad pair.
 *
 * Two properties matter more than the rest, and both are asserted against the
 * REAL spawn() entry point and the REAL config loader rather than mocks:
 *
 *  1. A bad pair fails BEFORE any worktree / porch / db state exists. Issue #4
 *     set that precedent for an unprofiled harness with no bypass flag; a model
 *     that no harness can honour must not get further than that did.
 *  2. With neither flag, everything is byte-identical to before. This change
 *     threads a new parameter through the highest-churn file in the repo, so
 *     "nothing moved unless you asked it to" is the regression that matters.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fatal: (msg: string) => { throw new Error(msg); },
  };
});

const { spawn } = await import('../commands/spawn.js');
const { resolveBuilderSelection, assertHarnessCommandAgrees } = await import('../utils/config.js');

describe('per-spawn (harness, model) selection (Issue #2)', () => {
  let ws: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    ws = mkdtempSync(join(tmpdir(), 'spawn-model-'));
    const git = (c: string) => execSync(c, { cwd: ws, stdio: 'pipe' });
    git('git init -q');
    git('git config user.email test@test.local');
    git('git config user.name Test');
    git('git config commit.gpgsign false');
    mkdirSync(join(ws, 'codev'), { recursive: true });
    writeFileSync(join(ws, 'codev', '.keep'), '');
    git('git add codev/.keep');
    git('git commit -q -m init');
    // Isolate HOME so a developer's global ~/.codev/config.json cannot mask the
    // workspace config through the shared loader.
    process.env.HOME = ws;
    process.chdir(ws);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(ws, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): void {
    mkdirSync(join(ws, '.codev'), { recursive: true });
    writeFileSync(join(ws, '.codev', 'config.json'), JSON.stringify(config));
  }

  function stateLeftBehind(): { builders: string[]; porch: string[] } {
    return {
      builders: existsSync(join(ws, '.builders')) ? readdirSync(join(ws, '.builders')) : [],
      porch: existsSync(join(ws, 'codev', 'projects')) ? readdirSync(join(ws, 'codev', 'projects')) : [],
    };
  }

  describe('resolveBuilderSelection', () => {
    it('with no flags, resolves exactly what config alone resolved', () => {
      writeConfig({ shell: { builder: '/opt/bin/claude' } });
      const s = resolveBuilderSelection({}, ws);
      expect(s.command).toBe('/opt/bin/claude');
      expect(s.harnessName).toBe('claude');
      expect(s.modelId).toBeUndefined();
      expect(s.modelScriptFragment).toBe('');
    });

    it('--harness naming the SAME harness keeps the configured path', () => {
      // The config value stays the fallback (Issue #2 scope item 2): asking for
      // claude on a claude workspace must not silently downgrade a pinned
      // absolute path to a bare `claude` off PATH.
      writeConfig({ shell: { builder: '/opt/bin/claude' } });
      expect(resolveBuilderSelection({ harness: 'claude' }, ws).command).toBe('/opt/bin/claude');
    });

    it('--harness naming a DIFFERENT harness resolves that binary', () => {
      writeConfig({ shell: { builder: '/opt/bin/claude' } });
      const s = resolveBuilderSelection({ harness: 'opencode' }, ws);
      expect(s.command).toBe('opencode');
      expect(s.harnessName).toBe('opencode');
    });

    it('a custom harness can name its own command', () => {
      writeConfig({
        shell: { builder: 'claude' },
        harness: { mine: { roleArgs: [], roleScriptFragment: '', command: '/opt/bin/mine' } },
      });
      expect(resolveBuilderSelection({ harness: 'mine' }, ws).command).toBe('/opt/bin/mine');
    });

    it('produces the harness-specific model fragment', () => {
      writeConfig({ shell: { builder: 'claude' } });
      expect(resolveBuilderSelection({ model: 'sonnet' }, ws).modelScriptFragment)
        .toBe("--model 'sonnet'");
    });

    it('rejects a syntactically invalid model id', () => {
      // Syntax only — existence is the provider's call. Same validator, same
      // rule, as spec 1286's --model-id.
      writeConfig({ shell: { builder: 'claude' } });
      expect(() => resolveBuilderSelection({ model: '--sneaky' }, ws)).toThrow(/model id/i);
    });

    it('rejects a model for a harness with no model selector', () => {
      writeConfig({
        shell: { builder: 'claude' },
        harness: { mine: { roleArgs: [], roleScriptFragment: '', command: 'mine' } },
      });
      expect(() => resolveBuilderSelection({ harness: 'mine', model: 'x' }, ws))
        .toThrow(/no model selector/);
    });

    it('rejects an unknown harness', () => {
      writeConfig({ shell: { builder: 'claude' } });
      expect(() => resolveBuilderSelection({ harness: 'nope' }, ws)).toThrow(/Unknown harness/);
    });

    it('a retired harness still fails closed through this path', () => {
      writeConfig({ shell: { builder: 'claude' } });
      expect(() => resolveBuilderSelection({ harness: 'gemini' }, ws)).toThrow(/retired/i);
    });
  });

  describe('assertHarnessCommandAgrees', () => {
    it('refuses a built-in harness whose command is a different binary', () => {
      // The render gate identifies a running agent by command basename. If
      // `--harness opencode` resolved a `claude` binary, the spawn-time checks
      // and the live gate would be judging two different agents.
      writeConfig({
        shell: { builder: 'claude' },
        harness: { opencode: { roleArgs: [], roleScriptFragment: '', command: '/opt/bin/claude' } },
      });
      const s = resolveBuilderSelection({ harness: 'opencode' }, ws);
      expect(() => assertHarnessCommandAgrees(s)).toThrow(/render gate/);
    });

    it('allows a custom harness to wrap another binary — that is what makes it custom', () => {
      writeConfig({
        shell: { builder: 'claude' },
        harness: { mine: { roleArgs: [], roleScriptFragment: '', command: '/opt/bin/claude' } },
      });
      const s = resolveBuilderSelection({ harness: 'mine' }, ws);
      expect(() => assertHarnessCommandAgrees(s)).not.toThrow();
    });

    it('does NOT fire for an INFERRED harness whose command is unrecognized', () => {
      // Regression: an unrecognized builder command has always fallen back to the
      // claude harness, and Issue #4's suite depends on `my-custom-agent` reaching
      // the gate-profile check rather than being rejected earlier. Asserting
      // agreement on an inferred name broke three of those tests. Only a name the
      // user explicitly asked for is a promise the command has to keep.
      writeConfig({ shell: { builder: 'my-custom-agent' } });
      const s = resolveBuilderSelection({}, ws);
      expect(s.explicit).toBe(false);
      expect(s.harnessName).toBe('claude');
      expect(() => assertHarnessCommandAgrees(s)).not.toThrow();
    });

    it('marks an explicit --harness as explicit', () => {
      writeConfig({ shell: { builder: 'claude' } });
      expect(resolveBuilderSelection({ harness: 'claude' }, ws).explicit).toBe(true);
    });

    it('passes for every ordinary built-in selection', () => {
      writeConfig({ shell: { builder: 'claude' } });
      for (const h of ['claude', 'codex', 'opencode']) {
        expect(() => assertHarnessCommandAgrees(resolveBuilderSelection({ harness: h }, ws))).not.toThrow();
      }
    });
  });

  describe('spawn() pre-flight — a bad pair creates NO state', () => {
    it('refuses an unknown harness before any worktree exists', async () => {
      writeConfig({ shell: { builder: 'claude' } });
      await expect(spawn({ protocol: 'maintain', force: true, harness: 'nope' }))
        .rejects.toThrow(/Unknown harness/);
      expect(stateLeftBehind()).toEqual({ builders: [], porch: [] });
    });

    it('refuses an invalid model id before any worktree exists', async () => {
      writeConfig({ shell: { builder: 'claude' } });
      await expect(spawn({ protocol: 'maintain', force: true, model: 'bad id!' }))
        .rejects.toThrow(/model id/i);
      expect(stateLeftBehind()).toEqual({ builders: [], porch: [] });
    });

    it('refuses --harness for an unprofiled harness, keeping Issue #4 fail-closed', async () => {
      // Per-spawn selection must not become a way around the gate-profile
      // check — that check is the only thing preventing a builder that runs but
      // can never be messaged.
      writeConfig({
        shell: { builder: 'claude' },
        harness: { mine: { roleArgs: [], roleScriptFragment: '', command: 'my-unmeasured-agent' } },
      });
      await expect(spawn({ protocol: 'maintain', force: true, harness: 'mine' }))
        .rejects.toThrow(/has no render-gate profile/);
      expect(stateLeftBehind()).toEqual({ builders: [], porch: [] });
    });

    it('checks the SELECTION, not the workspace default', async () => {
      // The workspace default is profiled (claude); the requested harness is not.
      // Reading the config command here would wrongly let this through.
      writeConfig({
        shell: { builder: '/opt/bin/claude' },
        harness: { mine: { roleArgs: [], roleScriptFragment: '', command: 'unmeasured' } },
      });
      await expect(spawn({ protocol: 'maintain', force: true, harness: 'mine' }))
        .rejects.toThrow(/has no render-gate profile/);
    });

    it('a shell-mode spawn is not exempt from model validation', async () => {
      writeConfig({ shell: { builder: 'claude' } });
      await expect(spawn({ shell: true, model: 'bad id!' })).rejects.toThrow(/model id/i);
      expect(stateLeftBehind()).toEqual({ builders: [], porch: [] });
    });
  });
});
