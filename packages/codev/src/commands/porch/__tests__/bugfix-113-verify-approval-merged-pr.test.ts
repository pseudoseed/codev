/**
 * Regression test for issue #113: porch approve verify-approval cannot pass
 * after a normal merge because it re-runs review's pr_exists.
 *
 * Reproduction:
 *   1. SPIR project is still in review. The pr gate is already approved.
 *   2. The PR is merged (closed). That is how you get to verify-approval.
 *   3. `porch approve <id> verify-approval` runs checks for state.phase
 *      (review), whose first check is pr_exists.
 *   4. pr_exists keys off `git branch --show-current` in whichever worktree
 *      findStatusPath returns. After merge that is almost never the PR head,
 *      so the check fails and the gate cannot be approved.
 *
 * A test that stops at the pr gate cannot catch this.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { approve } from '../index.js';
import { writeState, getStatusPath, readState } from '../state.js';
import type { ProjectState } from '../types.js';

function createTestDir(): string {
  const dir = path.join(tmpdir(), `porch-113-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setupProtocol(testDir: string, protocol: object): void {
  const protocolDir = path.join(testDir, 'codev', 'protocols', 'spir');
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(path.join(protocolDir, 'protocol.json'), JSON.stringify(protocol, null, 2));
}

function setupState(testDir: string, state: ProjectState): string {
  const statusPath = getStatusPath(testDir, state.id, state.title);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  writeState(statusPath, state);
  return statusPath;
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: '83',
    title: 'merged-pr-project',
    protocol: 'spir',
    phase: 'review',
    plan_phases: [],
    current_plan_phase: null,
    gates: {
      'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
      'plan-approval': { status: 'approved', approved_at: new Date().toISOString() },
      pr: { status: 'approved', approved_at: new Date().toISOString() },
      'verify-approval': { status: 'pending' },
    },
    iteration: 1,
    build_complete: true,
    history: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Review's pr_exists is a guaranteed fail. Without the fix, approve
// verify-approval runs this check and cannot pass. With the fix, approve
// enters verify first and never runs it.
const spirProtocol = {
  name: 'spir',
  version: '1.0.0',
  phases: [
    {
      id: 'review',
      name: 'Review',
      type: 'once',
      checks: {
        pr_exists: {
          command: 'false',
          description: 'Would fail after merge when the current branch is not the PR head',
        },
      },
      gate: 'pr',
      next: 'verify',
    },
    {
      id: 'verify',
      name: 'Verify',
      type: 'once',
      gate: 'verify-approval',
      next: null,
    },
  ],
};

describe('bugfix #113 — verify-approval after merged PR', () => {
  let testDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = createTestDir();
    setupProtocol(testDir, spirProtocol);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('approve verify-approval succeeds after pr is approved even when pr_exists would fail', async () => {
    const statusPath = setupState(testDir, makeState());

    await approve(testDir, '83', 'verify-approval', true);

    const updated = readState(statusPath);
    expect(updated.gates['verify-approval'].status).toBe('approved');
    expect(updated.gates['verify-approval'].approved_at).toBeDefined();
    expect(updated.phase).toBe('verified');
  });

  it('approve verify-approval refuses when the pr gate is not approved', async () => {
    const statusPath = setupState(testDir, makeState({
      gates: {
        'spec-approval': { status: 'approved', approved_at: new Date().toISOString() },
        'plan-approval': { status: 'approved', approved_at: new Date().toISOString() },
        pr: { status: 'pending' },
        'verify-approval': { status: 'pending' },
      },
    }));

    await expect(approve(testDir, '83', 'verify-approval', true)).rejects.toThrow(
      /pr gate must be approved first/,
    );

    const updated = readState(statusPath);
    expect(updated.gates['verify-approval'].status).toBe('pending');
    expect(updated.phase).toBe('review');
  });

  it('approve verify-approval still works when already in verify', async () => {
    const statusPath = setupState(testDir, makeState({ phase: 'verify' }));

    await approve(testDir, '83', 'verify-approval', true);

    const updated = readState(statusPath);
    expect(updated.gates['verify-approval'].status).toBe('approved');
    expect(updated.phase).toBe('verified');
  });
});
