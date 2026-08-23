/**
 * Tests for the builder phase stop-guard (Issue #41).
 *
 * Like the write-guard tests, these exercise the EXACT emitted artifact: the
 * script constant is written to a temp .cjs and spawned with fixture stdin, so
 * the tested behavior is the behavior builders get.
 *
 * The ordering below is deliberate. The allow-paths come first and outnumber
 * the block-path, because that is the risk profile: a guard that fails to block
 * costs one idle builder, and a guard that blocks when it should not can trap a
 * session or push a builder past a human approval gate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  PHASE_STOP_GUARD_SCRIPT,
  STOP_GUARD_SCRIPT_RELPATH,
  TERMINAL_PHASES,
  buildPhaseStopGuardCommand,
} from '../agent-farm/utils/phase-stop-guard.js';
import { createInitialState } from '../commands/porch/state.js';
import {
  buildWorktreeGuardFiles,
  GUARD_SCRIPT_RELPATH,
  GUARD_SETTINGS_RELPATH,
} from '../agent-farm/utils/worktree-write-guard.js';

const FIXTURE_HOME = path.join(path.resolve(__dirname, '..', '..'), 'node_modules', '.sguard-fixtures');

let base: string;
let worktree: string;
let scriptPath: string;

beforeAll(() => {
  fs.mkdirSync(FIXTURE_HOME, { recursive: true });
  base = fs.mkdtempSync(path.join(FIXTURE_HOME, 'sguard-'));
  worktree = path.join(base, 'main', '.builders', 'pir-77');
  fs.mkdirSync(worktree, { recursive: true });
  scriptPath = path.join(base, 'stop-guard.cjs');
  fs.writeFileSync(scriptPath, PHASE_STOP_GUARD_SCRIPT);
});

afterAll(() => {
  fs.rmSync(FIXTURE_HOME, { recursive: true, force: true });
});

/** Write a status.yaml for project `id` inside the fixture worktree. */
function writeStatus(id: string, slug: string, body: string): void {
  const dir = path.join(worktree, 'codev', 'projects', `${id}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.yaml'), body);
}

function clearProjects(): void {
  fs.rmSync(path.join(worktree, 'codev', 'projects'), { recursive: true, force: true });
}

interface GuardResult {
  status: number | null;
  blocked: boolean;
  reason: string;
}

function runGuard(
  stdin: string,
  env: Record<string, string | undefined> = {},
): GuardResult {
  const res = spawnSync(process.execPath, [scriptPath], {
    input: stdin,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CODEV_WORKTREE_ROOT: worktree,
      CODEV_PROJECT_ID: '77',
      ...env,
    },
  });
  const out = (res.stdout || '').trim();
  if (!out) return { status: res.status, blocked: false, reason: '' };
  try {
    const parsed = JSON.parse(out);
    return { status: res.status, blocked: parsed.decision === 'block', reason: parsed.reason ?? '' };
  } catch {
    return { status: res.status, blocked: false, reason: out };
  }
}

/**
 * A SPIR-shaped project mid-implement, produced by porch's OWN state factory
 * and YAML writer.
 *
 * The previous fixture was hand-typed and carried a single approved gate --
 * a shape porch never writes. That is why 24 green tests covered a guard that
 * was a total no-op in production: `createInitialState` pre-seeds EVERY gate
 * as `{ status: 'pending' }` at creation, so the "is a gate pending?" check
 * always said yes and the guard always allowed.
 */
const FIXTURE_PROTOCOL = {
  name: 'fixture-spir',
  version: '1.0.0',
  description: 'f',
  phases: [
    { id: 'implement', name: 'Implement', type: 'per_plan_phase' },
    { id: 'pr', name: 'PR', gate: 'pr' },
    { id: 'verify', name: 'Verify', gate: 'verify-approval' },
  ],
} as never;

function porchState(overrides: Record<string, unknown> = {}): string {
  const state = createInitialState(FIXTURE_PROTOCOL, '77', 'test');
  return yaml.dump({ ...state, phase: 'implement', ...overrides });
}

const MID_PHASE = porchState();

const STOP = JSON.stringify({ stop_hook_active: false });

describe('phase stop-guard: paths that must ALLOW the stop', () => {
  it('allows when the hook has already nudged this cycle', () => {
    // Without this the guard fights the model forever over a stop it cannot
    // talk its way out of. One nudge, then the model's judgment wins.
    writeStatus('77', 'test', MID_PHASE);
    const r = runGuard(JSON.stringify({ stop_hook_active: true }));
    expect(r.blocked).toBe(false);
    expect(r.status).toBe(0);
  });

  it.each(TERMINAL_PHASES)('allows at the terminal phase %s', (phase) => {
    writeStatus('77', 'test', MID_PHASE.replace('phase: implement', `phase: ${phase}`));
    expect(runGuard(STOP).blocked).toBe(false);
  });

  it('allows when a gate is genuinely awaiting a human', () => {
    // The one way this guard can do real harm: nudging a builder parked at a
    // human approval gate is pushing it past a decision only a human may make.
    // "Genuinely" means BOTH keys — porch sets requested_at only in requestGate.
    writeStatus('77', 'test', porchState({
      gates: {
        pr: { status: 'pending', requested_at: '2026-08-22T00:00:00Z' },
        'verify-approval': { status: 'pending' },
      },
    }));

    expect(runGuard(STOP).blocked).toBe(false);
  });

  it('allows when the status file cannot be read at all', () => {
    // "I could not tell" must not be spelled the same way as "no gate here".
    clearProjects();
    expect(runGuard(STOP).blocked).toBe(false);
  });

  it('allows when the project id matches no project directory', () => {
    writeStatus('77', 'test', MID_PHASE);
    expect(runGuard(STOP, { CODEV_PROJECT_ID: '999' }).blocked).toBe(false);
  });

  it('allows when the baked env vars are missing', () => {
    writeStatus('77', 'test', MID_PHASE);
    expect(runGuard(STOP, { CODEV_WORKTREE_ROOT: undefined }).blocked).toBe(false);
    expect(runGuard(STOP, { CODEV_PROJECT_ID: undefined }).blocked).toBe(false);
  });

  it('allows on malformed stdin', () => {
    writeStatus('77', 'test', MID_PHASE);
    expect(runGuard('not json at all').blocked).toBe(false);
  });

  it('allows on empty stdin', () => {
    writeStatus('77', 'test', MID_PHASE);
    expect(runGuard('').blocked).toBe(false);
  });

  it('allows when status.yaml has no phase key', () => {
    writeStatus('77', 'test', "id: '77'\ntitle: test\n");
    expect(runGuard(STOP).blocked).toBe(false);
  });

  it('exits 0 on every allow path, so a hook failure can never wedge a session', () => {
    clearProjects();
    for (const input of ['', 'garbage', STOP]) {
      expect(runGuard(input).status).toBe(0);
    }
  });
});

describe('phase stop-guard: the path that must BLOCK', () => {
  it('BLOCKS on a gate that is seeded pending but never requested', () => {
    // This is the case that made the guard a no-op. createInitialState seeds
    // every gate as { status: 'pending' } at project creation, so treating bare
    // `pending` as "a human is waiting" means a human is always waiting and the
    // guard never fires. Verified against a real committed status.yaml before
    // this test was written.
    writeStatus('77', 'test', porchState());

    expect(runGuard(STOP).blocked).toBe(true);
  });

  it('is not fooled by a requested_at on a DIFFERENT gate', () => {
    // The two keys arrive on separate lines, so a scanner that does not close
    // each gate block would pair `pending` from one gate with `requested_at`
    // from another and allow every stop again.
    writeStatus('77', 'test', porchState({
      gates: {
        pr: { status: 'pending' },
        'verify-approval': { status: 'approved', requested_at: '2026-08-22T00:00:00Z' },
      },
    }));

    expect(runGuard(STOP).blocked).toBe(true);
  });

  it('blocks a mid-phase stop with no gate pending', () => {
    writeStatus('77', 'test', MID_PHASE);
    const r = runGuard(STOP);
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(0);
  });

  it('names the phase, so the nudge is about this project and not a generic scold', () => {
    writeStatus('77', 'test', MID_PHASE);
    expect(runGuard(STOP).reason).toMatch(/phase "implement"/);
  });

  it('explains the mechanism, not just the rule', () => {
    // The builder in the second incident knew what to do next and said so. It
    // did not know that saying so was the act of stopping. A nudge that only
    // repeats "do not stop" leaves that misunderstanding intact.
    writeStatus('77', 'test', MID_PHASE);
    const reason = runGuard(STOP).reason;
    expect(reason).toMatch(/IS the act of ending the turn/);
    expect(reason).toMatch(/afx send architect/);
  });

  it('tells the builder how to stop anyway, and that it will not be blocked twice', () => {
    writeStatus('77', 'test', MID_PHASE);
    expect(runGuard(STOP).reason).toMatch(/will not block you twice/);
  });
});

describe('phase stop-guard: id matching', () => {
  it('does not let project 77 match project 7713', () => {
    // The zero-strip collision that bit artifact lookup in #9. A guard watching
    // the wrong project nudges about a phase that is not open.
    clearProjects();
    writeStatus('7713', 'other', MID_PHASE);
    expect(runGuard(STOP).blocked).toBe(false);
  });

  it('matches an exact directory name with no slug', () => {
    clearProjects();
    const dir = path.join(worktree, 'codev', 'projects', '77');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.yaml'), MID_PHASE);
    expect(runGuard(STOP).blocked).toBe(true);
  });
});

describe('worktree wiring', () => {
  it('emits the stop-guard script and a Stop hook for a builder worktree', () => {
    const files = buildWorktreeGuardFiles('/x/main/.builders/pir-42');
    const paths = files.map(f => f.relativePath);
    expect(paths).toContain(GUARD_SCRIPT_RELPATH);
    expect(paths).toContain(STOP_GUARD_SCRIPT_RELPATH);

    const settings = JSON.parse(files.find(f => f.relativePath === GUARD_SETTINGS_RELPATH)!.content);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("CODEV_PROJECT_ID='42'");
    // Both guards must survive in one settings file — this function is the
    // single owner of it, and dropping either is silent.
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('derives bugfix project ids the way porch does', () => {
    const files = buildWorktreeGuardFiles('/x/main/.builders/bugfix-9-some-slug');
    const settings = JSON.parse(files.find(f => f.relativePath === GUARD_SETTINGS_RELPATH)!.content);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("CODEV_PROJECT_ID='bugfix-9'");
  });

  it('installs NO Stop hook when the path is not a recognized builder worktree', () => {
    // Fail open: an unrecognized path means the guard cannot know which project
    // it would be watching, and a guard that guesses nudges about the wrong one.
    const files = buildWorktreeGuardFiles('/some/random/dir');
    const settings = JSON.parse(files.find(f => f.relativePath === GUARD_SETTINGS_RELPATH)!.content);
    expect(settings.hooks.Stop).toBeUndefined();
    expect(files.map(f => f.relativePath)).not.toContain(STOP_GUARD_SCRIPT_RELPATH);
    // The write-guard must still be installed — the two are independent.
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('bakes an absolute, shell-safe command', () => {
    const cmd = buildPhaseStopGuardCommand('/x/main/.builders/pir-42', '42');
    expect(cmd).toContain("CODEV_WORKTREE_ROOT='/x/main/.builders/pir-42'");
    expect(cmd).toContain('/x/main/.builders/pir-42/.claude/hooks/phase-stop-guard.cjs');
  });
});

describe('against REAL committed status.yaml files', () => {
  // The reviewer found the no-op by running the guard against a real file
  // rather than a fixture. That check belongs in the suite, because a
  // hand-typed fixture is a guess at porch's output and this is a sample of it.
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

  function runAgainstRealProject(projectDirName: string, projectId: string): GuardResult {
    const src = path.join(repoRoot, 'codev', 'projects', projectDirName, 'status.yaml');
    if (!fs.existsSync(src)) return { status: 0, blocked: false, reason: 'FIXTURE-MISSING' };

    const dest = path.join(worktree, 'codev', 'projects', projectDirName);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(src, path.join(dest, 'status.yaml'));

    return runGuard(STOP, { CODEV_PROJECT_ID: projectId });
  }

  it('BLOCKS a real mid-phase project whose gates are only seeded', () => {
    clearProjects();
    const r = runAgainstRealProject('bugfix-1137-gitea-forge-preset-is-broken-a', 'bugfix-1137');
    if (r.reason === 'FIXTURE-MISSING') return;

    // phase: fix, gates: { merge-approval: { status: pending } } and no
    // requested_at. Under the original `pending`-only scan this allowed, which
    // made the guard a no-op for the whole BUGFIX protocol.
    expect(r.blocked).toBe(true);
  });

  it('ALLOWS a real completed project', () => {
    clearProjects();
    const r = runAgainstRealProject('13-add-ci-concepts-to-the-forge-l', '13');
    if (r.reason === 'FIXTURE-MISSING') return;

    // phase: verified — terminal, nothing left to drive.
    expect(r.blocked).toBe(false);
  });
});

describe('the nudge names where the builder actually stopped', () => {
  it('names the PLAN phase, not just the protocol phase', () => {
    // Mid-implement in SPIR the protocol phase is "implement" for the whole
    // build, while the builder is on plan phase 2 of 5 — which is the exact
    // incident this guard exists for. "You stopped during implement" is not
    // actionable; "implement / phase_2_seam_harness" is.
    writeStatus('77', 'test', porchState({ current_plan_phase: 'phase_2_seam_harness' }));

    expect(runGuard(STOP).reason).toMatch(/implement \/ phase_2_seam_harness/);
  });

  it('falls back to the protocol phase when there is no plan phase', () => {
    writeStatus('77', 'test', porchState({ current_plan_phase: null }));

    const reason = runGuard(STOP).reason;
    expect(reason).toMatch(/phase "implement"/);
    expect(reason).not.toMatch(/null/);
  });
});
