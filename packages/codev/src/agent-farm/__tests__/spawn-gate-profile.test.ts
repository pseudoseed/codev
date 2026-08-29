/**
 * Integration test for Issue #4: a builder spawn whose workspace selects a harness the
 * render gate cannot classify must fail closed at the spawn() dispatcher, BEFORE any
 * worktree / porch / db state is created.
 *
 * Why this needs a guard at all: `afx send` is mailbox-first and delivers only onto a
 * screen the render gate has proven empty. A harness with no profile holds every message
 * forever with reason `no-profile` — and nothing about the spawn looks wrong at the time,
 * so the failure surfaces only when someone first tries to talk to the builder. The
 * check turns that into a loud, immediate abort.
 *
 * Like the retirement preflight it guards (#1338), this drives the REAL spawn() entry
 * point against a REAL temp workspace and the REAL config loader, so it protects the
 * actual invariant — the check runs above every state-creating handler — rather than a
 * mocked stand-in. `fatal` is mocked to throw rather than `process.exit(1)`, the same
 * convention the other spawn suites use.
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

describe('spawn render-gate-profile preflight (Issue #4)', () => {
  let ws: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    ws = mkdtempSync(join(tmpdir(), 'spawn-gate-profile-'));
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
    // workspace's builder config through the shared config loader.
    process.env.HOME = ws;
    process.chdir(ws);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    // `maxRetries` because these tests spawn a real terminal session into
    // `.builders/<id>`, and a session still writing there when the walk reaches
    // it makes rmSync fail with ENOTEMPTY even under `force`. Intermittent, and
    // only under a loaded full-suite run -- it passes every time in isolation.
    //
    // Budget raised from 250ms (5 x 50) to 2s (20 x 100): 250ms was not enough on
    // a loaded machine, and the same ENOTEMPTY came back. The retry is bounded and
    // no assertion changed, so a wider budget costs nothing when the directory is
    // already quiet.
    rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  function writeBuilderCommand(builder: string): void {
    mkdirSync(join(ws, '.codev'), { recursive: true });
    writeFileSync(join(ws, '.codev', 'config.json'), JSON.stringify({ shell: { builder } }));
  }

  function stateLeftBehind(): { builders: string[]; porch: string[] } {
    return {
      builders: existsSync(join(ws, '.builders')) ? readdirSync(join(ws, '.builders')) : [],
      porch: existsSync(join(ws, 'codev', 'projects')) ? readdirSync(join(ws, 'codev', 'projects')) : [],
    };
  }

  it('rejects an unmeasured builder harness and creates NO state', async () => {
    // Resolves fine as a harness (an unrecognized command falls back to claude's role
    // injection), so the retirement preflight passes and this check is the only thing
    // standing between the user and an unmessageable builder.
    writeBuilderCommand('my-custom-agent');

    await expect(spawn({ protocol: 'maintain', force: true }))
      .rejects.toThrow(/has no render-gate profile/);

    expect(stateLeftBehind()).toEqual({ builders: [], porch: [] });
  });

  it('names the harness and the supported set, so the message is actionable', async () => {
    writeBuilderCommand('my-custom-agent');

    const err = await spawn({ protocol: 'maintain', force: true }).catch((e: Error) => e);
    expect(err.message).toContain('my-custom-agent');
    expect(err.message).toContain('no-profile');
    expect(err.message).toMatch(/claude, codex, opencode/);
  });

  it('shell mode is NOT exempt — it also starts the builder command', async () => {
    // `spawnShell` runs `commands.builder` and persists a shell row, so an unmessageable
    // harness must be refused here too. No `force`: it is invalid for shell mode, and the
    // untracked .codev/config.json does not trip the cleanliness check.
    writeBuilderCommand('my-custom-agent');

    await expect(spawn({ shell: true })).rejects.toThrow(/has no render-gate profile/);
    expect(stateLeftBehind()).toEqual({ builders: [], porch: [] });
  });

  it('rejects gemini-as-builder — the documented custom-harness recipe is architect-only now', async () => {
    // README documents a custom `gemini` harness as the escape hatch for retained
    // enterprise/API-key access. That recipe survives for `architectHarness` but NOT for
    // builders: gemini has no measured gate profile, so a builder on it could never be
    // messaged. Pinned here so the docs and this pre-flight cannot drift apart silently —
    // shipping that contradiction is exactly what CMAP caught on this PR.
    mkdirSync(join(ws, '.codev'), { recursive: true });
    writeFileSync(join(ws, '.codev', 'config.json'), JSON.stringify({
      shell: { builder: 'gemini --yolo', builderHarness: 'gemini' },
      harness: { gemini: { roleArgs: [], roleScriptFragment: '' } },
    }));

    await expect(spawn({ protocol: 'maintain', force: true }))
      .rejects.toThrow(/has no render-gate profile/);
    expect(stateLeftBehind()).toEqual({ builders: [], porch: [] });
  });

  it('opencode passes the preflight (Issue #4 gave it a measured profile)', async () => {
    writeBuilderCommand('opencode');

    // It proceeds past this check and fails later for unrelated reasons (no Tower, no
    // GitHub); what matters is that the failure is NOT this preflight.
    const err = await spawn({ protocol: 'maintain', force: true }).catch((e: Error) => e);
    expect(err?.message ?? '').not.toMatch(/has no render-gate profile/);
  });

  it('claude passes the preflight (the default harness is unaffected)', async () => {
    writeBuilderCommand('claude --dangerously-skip-permissions');

    const err = await spawn({ protocol: 'maintain', force: true }).catch((e: Error) => e);
    expect(err?.message ?? '').not.toMatch(/has no render-gate profile/);
  });
});
