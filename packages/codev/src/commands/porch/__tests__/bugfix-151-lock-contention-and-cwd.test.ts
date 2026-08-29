/**
 * Issue #151: porch must not spell suite-lock contention as CHECKS FAILED,
 * and must not treat a subdirectory cwd as "project not found" / success.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../lib/github.js', () => ({
  fetchIssue: vi.fn().mockResolvedValue(null),
}));
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import {
  runCheck,
  formatCheckResults,
  anyCheckBlocked,
  isSuiteLockContention,
  type CheckEnv,
} from '../checks.js';
import { check, cli } from '../index.js';
import { writeState, getStatusPath, resolvePorchWorkspaceRoot, findStatusPath } from '../state.js';
import { SUITE_LOCK_BUSY_EXIT, SUITE_LOCK_TIMEOUT_NEEDLE } from '../../../lib/suite-lock.js';
import type { ProjectState } from '../types.js';

const env: CheckEnv = { PROJECT_ID: '151', PROJECT_TITLE: 'suite-lock' };

function createTestDir(prefix: string): string {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  const now = new Date().toISOString();
  return {
    id: 'bugfix-151',
    title: 'suite-lock',
    protocol: 'bugfix',
    phase: 'fix',
    plan_phases: [],
    current_plan_phase: null,
    gates: { pr: { status: 'pending' } },
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: now,
    updated_at: now,
    ...overrides,
  };
}

function writeProject(workspaceRoot: string, state: ProjectState, checks: Record<string, { command: string }>): void {
  const statusPath = getStatusPath(workspaceRoot, state.id, state.title);
  mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, state);
  const protocolDir = path.join(workspaceRoot, 'codev', 'protocols', 'bugfix');
  mkdirSync(protocolDir, { recursive: true });
  writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify({
    name: 'bugfix',
    version: '1.0.0',
    phases: [
      { id: 'investigate', name: 'Investigate', type: 'once' },
      { id: 'fix', name: 'Fix', type: 'once', checks },
    ],
  }, null, 2));
}

async function captureCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  const originalCwd = process.cwd();
  process.chdir(cwd);
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__process_exit__');
  }) as never);
  try {
    await cli(args);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode };
}

describe('issue #151 suite lock contention is not a failed check', () => {
  const cwd = tmpdir();

  it('treats exit 75 as blocked, not failed', async () => {
    const cmd = script(cwd, `i151-busy-${Date.now()}.sh`, 'exit 75');
    const result = await runCheck('tests', cmd, cwd, env);
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(anyCheckBlocked([result])).toBe(true);
  });

  it('treats the lock-timeout needle plus a non-zero exit as blocked', async () => {
    const cmd = script(cwd, `i151-timeout-${Date.now()}.sh`, `echo ${SUITE_LOCK_TIMEOUT_NEEDLE} >&2\nexit 1`);
    const result = await runCheck('tests', cmd, cwd, env);
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it('does not treat a normal test failure as blocked', async () => {
    const result = await runCheck('tests', 'false', cwd, env);
    expect(result.passed).toBe(false);
    expect(result.blocked).toBeUndefined();
    expect(anyCheckBlocked([result])).toBe(false);
  });

  it('does not treat a wait message plus a later real failure as blocked', async () => {
    const cmd = script(cwd, `i151-waitfail-${Date.now()}.sh`, 'echo "Another Vitest run owns shared Tower state; waiting." >&2\nexit 1');
    const result = await runCheck('tests', cmd, cwd, env);
    expect(result.passed).toBe(false);
    expect(result.blocked).toBeUndefined();
  });

  it('isSuiteLockContention matches only busy-exit or the timeout needle', () => {
    expect(isSuiteLockContention(SUITE_LOCK_BUSY_EXIT, '', '')).toBe(true);
    expect(isSuiteLockContention(1, '', SUITE_LOCK_TIMEOUT_NEEDLE)).toBe(true);
    expect(isSuiteLockContention(1, '', 'AssertionError')).toBe(false);
    expect(isSuiteLockContention(0, '', SUITE_LOCK_TIMEOUT_NEEDLE)).toBe(false);
  });

  it('formatCheckResults marks blocked distinctly from failed', () => {
    const blocked = formatCheckResults([
      { name: 'tests', command: 'npm test', passed: false, blocked: true, error: 'suite lock', duration_ms: 1000 },
    ]);
    const failed = formatCheckResults([
      { name: 'tests', command: 'npm test', passed: false, error: '3 failed', duration_ms: 1000 },
    ]);
    expect(blocked).toContain('⚠ tests');
    expect(blocked).not.toContain('✗ tests');
    expect(failed).toContain('✗ tests');
    expect(failed).not.toContain('⚠ tests');
  });

  it('porch check prints CHECKS BLOCKED instead of CHECKS FAILED', async () => {
    const dir = createTestDir('porch-151-check');
    try {
      const busy = script(dir, 'busy.sh', 'exit 75');
      writeProject(dir, makeState(), { tests: { command: busy } });
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
      });
      try {
        await check(dir, 'bugfix-151');
      } finally {
        spy.mockRestore();
      }
      const out = lines.join('\n');
      expect(out).toContain('CHECKS BLOCKED');
      expect(out).not.toContain('CHECKS FAILED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('issue #151 porch cwd is the workspace root, not packages/codev', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir('porch-151-cwd');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('resolvePorchWorkspaceRoot walks up to codev/projects', () => {
    writeProject(testDir, makeState({ phase: 'investigate' }), {});
    const nested = path.join(testDir, 'packages', 'codev');
    mkdirSync(nested, { recursive: true });
    expect(findStatusPath(nested, 'bugfix-151')).toBeNull();
    expect(resolvePorchWorkspaceRoot(nested)).toBe(testDir);
    expect(findStatusPath(resolvePorchWorkspaceRoot(nested), 'bugfix-151')).toBeTruthy();
  });

  it('porch next from a subdirectory finds the project', async () => {
    writeProject(testDir, makeState({ phase: 'investigate' }), {});
    const nested = path.join(testDir, 'packages', 'codev');
    mkdirSync(nested, { recursive: true });
    const { stdout, exitCode } = await captureCli(['next', 'bugfix-151'], nested);
    expect(stdout).not.toContain('Project bugfix-151 not found');
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(stdout)).toMatchObject({ status: 'tasks', phase: 'investigate' });
  });

  it('porch next exits 1 when the project really is missing', async () => {
    const empty = createTestDir('porch-151-missing');
    try {
      const { stdout, exitCode } = await captureCli(['next', '9999'], empty);
      expect(stdout).toContain('not found');
      expect(exitCode).toBe(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
