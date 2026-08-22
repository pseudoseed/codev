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
import {
  PHASE_STOP_GUARD_SCRIPT,
  STOP_GUARD_SCRIPT_RELPATH,
  TERMINAL_PHASES,
  buildPhaseStopGuardCommand,
} from '../agent-farm/utils/phase-stop-guard.js';
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

const MID_PHASE = `id: '77'
title: test
protocol: pir
phase: implement
plan_phases: []
gates:
  plan-approval:
    status: approved
build_complete: false
`;

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

  it('allows when ANY gate is pending', () => {
    // The one way this guard can do real harm: nudging a builder parked at a
    // human approval gate is pushing it past a decision only a human may make.
    writeStatus(
      '77',
      'test',
      MID_PHASE.replace('    status: approved\n', '    status: approved\n  dev-approval:\n    status: pending\n'),
    );
    const r = runGuard(STOP);
    expect(r.blocked).toBe(false);
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
