/**
 * Issue #8 — a passing suite reported as a failed check.
 *
 * `runCheck` bounds every check at 300 seconds. This repo's suite takes about
 * 305s under load, so `porch done` killed a green run (5443 passed, 0 failed,
 * exit 0) and reported it as a failure. That blocked every project in the
 * workspace, not just the one that found it.
 *
 * The available workaround was worse than the bug. `porch.checks` accepted only
 * `command`, `cwd` and `skip`, so the only way past a slow-but-passing suite was:
 *
 *     { "porch": { "checks": { "tests": { "skip": true } } } }
 *
 * which lives at the workspace root, is symlinked into every builder worktree,
 * and turns test checking off for every future project — silently, permanently,
 * and for a reason (a timeout) that has nothing to do with wanting the check
 * gone. It was set that way in this repo.
 *
 * `timeout` lets a slow check raise its own bound instead of being disabled.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveCheckTimeoutMs, getPhaseChecks } from '../protocol.js';
import { runPhaseChecks } from '../checks.js';
import type { Protocol } from '../types.js';

const protocol = {
  name: 'test-protocol',
  phases: [{ id: 'implement', checks: ['tests', 'build'] }],
  checks: {
    tests: { command: 'npm test' },
    build: { command: 'npm run build' },
  },
} as unknown as Protocol;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Silence + capture the stderr warnings the resolver writes. */
function captureStderr(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines };
}

describe('#8: a slow suite can raise its own bound', () => {
  it('converts the override from seconds to the milliseconds the runner takes', () => {
    // Seconds, because the config file is hand-authored. 1200 meaning 1.2s
    // would be a footgun of exactly the kind this key exists to remove.
    expect(resolveCheckTimeoutMs('tests', 1200, undefined)).toBe(1_200_000);
  });

  it('carries the bound onto the resolved check, where the runner reads it', () => {
    const checks = getPhaseChecks(protocol, 'implement', { tests: { timeout: 1200 } });

    expect(checks.tests.timeout_ms).toBe(1_200_000);
    expect(checks.tests.command).toBe('npm test');
  });

  it('leaves every other check on the default', () => {
    const checks = getPhaseChecks(protocol, 'implement', { tests: { timeout: 1200 } });

    expect(checks.build.timeout_ms).toBeUndefined();
  });

  it('composes with the other override keys rather than replacing them', () => {
    const checks = getPhaseChecks(protocol, 'implement', {
      tests: { command: 'uv run pytest', cwd: 'py', timeout: 900 },
    });

    expect(checks.tests).toEqual({ command: 'uv run pytest', cwd: 'py', timeout_ms: 900_000 });
  });

  it('still omits a check that asked to be skipped', () => {
    const checks = getPhaseChecks(protocol, 'implement', { tests: { skip: true, timeout: 900 } });

    expect(checks.tests).toBeUndefined();
  });
});

describe('#8: a rejected value must not read as an accepted one', () => {
  // The defect being fixed is a bound that silently differs from the one the
  // operator set. Swallowing a malformed value and quietly using 300s would
  // reproduce it with a config file that looks correct.
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1200' as unknown as number],
    ['null', null as unknown as number],
  ])('warns and keeps the default for %s', (_label, value) => {
    const { lines } = captureStderr();

    expect(resolveCheckTimeoutMs('tests', value, undefined)).toBeUndefined();
    expect(lines.join('')).toContain('Ignoring invalid timeout for check "tests"');
  });

  it('does not clamp — a clamp would apply a bound nobody asked for', () => {
    captureStderr();

    // -5 does not become 5, or 1, or the minimum. It is refused.
    expect(resolveCheckTimeoutMs('tests', -5, undefined)).toBeUndefined();
  });

  it('says nothing at all when no timeout was set', () => {
    const { lines } = captureStderr();

    expect(resolveCheckTimeoutMs('tests', undefined, undefined)).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('falls back to the protocol default rather than to nothing', () => {
    captureStderr();

    expect(resolveCheckTimeoutMs('tests', -1, 600_000)).toBe(600_000);
  });
});

describe('#8: the runner honours the per-check bound', () => {
  // These drive real processes. `runCheck` sends SIGTERM at the bound and only
  // SIGKILLs 5s later, and under `shell: true` the child can outlive the
  // SIGTERM, so a timing-out check can take the full 5s escalation to close.
  // Vitest's 5s default sits exactly on that edge and failed in CI while
  // passing locally — hence an explicit bound well clear of it.
  const KILL_ESCALATION_HEADROOM_MS = 20_000;

  it('kills a check at ITS bound, not at the phase default', async () => {
    // A 30s sleep under a 100ms bound. If the per-check value were dropped on
    // the way to `runCheck`, this would run to completion and pass.
    const results = await runPhaseChecks(
      { slow: { command: 'sleep 30', timeout_ms: 100 } },
      process.cwd(),
      { PROJECT_ID: '8', PROJECT_TITLE: 'timeout' },
    );

    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain('Timed out');
  }, KILL_ESCALATION_HEADROOM_MS);

  it('lets a check outlive the phase default when it raises its own bound', async () => {
    // The whole point: a 100ms phase default, a check that needs longer, and it
    // is allowed to finish rather than being reported as a failure.
    const results = await runPhaseChecks(
      { slow: { command: 'sleep 1', timeout_ms: 15_000 } },
      process.cwd(),
      { PROJECT_ID: '8', PROJECT_TITLE: 'timeout' },
      100,
    );

    expect(results[0].passed).toBe(true);
  }, KILL_ESCALATION_HEADROOM_MS);

  it('kills a check whose shell FORKED, which is every real check command', async () => {
    // The CI failure that found this. A pipeline makes the shell fork rather
    // than exec, so signalling the child pid reaches `sh` and not `sleep`; the
    // grandchild holds the stdio pipes open and `close` never fires. That is
    // the shape of every real check -- `npm test` forks a runner -- so before
    // the process-group kill, a timed-out check ran to completion regardless of
    // its bound.
    //
    // 30s of sleep under a 100ms bound, asserted inside 15s: passing means it
    // was killed, not that it finished.
    const started = Date.now();
    const results = await runPhaseChecks(
      { forking: { command: 'sleep 30 | cat', timeout_ms: 100 } },
      process.cwd(),
      { PROJECT_ID: '8', PROJECT_TITLE: 'timeout' },
    );

    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain('Timed out');
    expect(Date.now() - started).toBeLessThan(15_000);
  }, KILL_ESCALATION_HEADROOM_MS);

  it('still applies the phase default to a check with no bound of its own', async () => {
    const results = await runPhaseChecks(
      { slow: { command: 'sleep 30' } },
      process.cwd(),
      { PROJECT_ID: '8', PROJECT_TITLE: 'timeout' },
      100,
    );

    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain('Timed out');
  }, KILL_ESCALATION_HEADROOM_MS);
});
