/**
 * Regression test for issue #102:
 *   `porch done <id> --help` executed `done` (advanced the phase, hung on
 *   checks) instead of printing usage. --help must be parsed before dispatch
 *   for every subcommand, exit 0, and leave status.yaml untouched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { cli } from '../index.js';
import { writeState, getStatusPath } from '../state.js';
import type { ProjectState } from '../types.js';

const SUBCOMMANDS = [
  'next',
  'status',
  'check',
  'done',
  'gate',
  'pending',
  'approve',
  'verify',
  'rollback',
  'init',
] as const;

function createTestDir(prefix: string): string {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  const now = new Date().toISOString();
  return {
    id: '0001',
    title: 'help-flag',
    protocol: 'bugfix',
    phase: 'investigate',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: now,
    updated_at: now,
    ...overrides,
  };
}

function writeProject(workspaceRoot: string, state: ProjectState): string {
  const statusPath = getStatusPath(workspaceRoot, state.id, state.title);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, state);
  return statusPath;
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return fn()
    .then(() => lines.join('\n'))
    .finally(() => {
      spy.mockRestore();
      errSpy.mockRestore();
    });
}

describe('porch --help before dispatch (issue #102)', () => {
  let testDir: string;
  let originalCwd: string;
  let statusPath: string;
  let statusBefore: Buffer;

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = createTestDir('porch-102-help');
    statusPath = writeProject(testDir, makeState());
    statusBefore = fs.readFileSync(statusPath);
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('porch --help prints usage and does not mutate status.yaml', async () => {
    const stdout = await captureStdout(() => cli(['--help']));
    expect(stdout).toContain('Protocol Orchestrator');
    expect(stdout).toContain('done [id]');
    expect(fs.readFileSync(statusPath).equals(statusBefore)).toBe(true);
  });

  it('porch -h prints usage', async () => {
    const stdout = await captureStdout(() => cli(['-h']));
    expect(stdout).toContain('Protocol Orchestrator');
    expect(fs.readFileSync(statusPath).equals(statusBefore)).toBe(true);
  });

  it.each(SUBCOMMANDS)('%s --help prints usage, exits 0, leaves status.yaml byte-identical', async (cmd) => {
    const stdout = await captureStdout(() => cli([cmd, '--help']));
    expect(stdout).toContain('Protocol Orchestrator');
    expect(stdout).toContain('done [id]');
    expect(fs.readFileSync(statusPath).equals(statusBefore)).toBe(true);
  });

  it.each(SUBCOMMANDS)('%s <id> --help does not dispatch', async (cmd) => {
    const stdout = await captureStdout(() => cli([cmd, '0001', '--help']));
    expect(stdout).toContain('Protocol Orchestrator');
    expect(stdout).not.toContain('ADVANCING TO');
    expect(stdout).not.toContain('RUNNING CHECKS');
    expect(fs.readFileSync(statusPath).equals(statusBefore)).toBe(true);
  });

  it('done <id> -h does not advance investigate → fix', async () => {
    const stdout = await captureStdout(() => cli(['done', '0001', '-h']));
    expect(stdout).toContain('Protocol Orchestrator');
    const after = fs.readFileSync(statusPath, 'utf-8');
    expect(after).toContain('phase: investigate');
    expect(after).not.toContain('phase: fix');
    expect(fs.readFileSync(statusPath).equals(statusBefore)).toBe(true);
  });
});
