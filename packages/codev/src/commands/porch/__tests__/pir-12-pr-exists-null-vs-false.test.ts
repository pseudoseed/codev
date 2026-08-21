/**
 * PIR #12 — `null` from the pr-exists concept is not `false`.
 *
 * `executeForgeCommand` returns `null` when the command failed, timed out (it
 * imposes a 30s ceiling on every concept), was disabled for the provider, or
 * printed something unparseable. None of those mean "there is no PR". The
 * check used to report all of them as a plain failed check carrying
 * `output: "null"`, which reads as "no PR found" — so a builder at the pr gate
 * would be told its PR does not exist and go create a duplicate.
 *
 * This mattered concretely: before this PR the gitea `pr-exists` script took
 * ~17 minutes against a real Forgejo, so the 30s ceiling fired on every run and
 * `null` was the *normal* outcome on that provider.
 *
 * The gitea script is fixed, but the misreading was general — any provider, any
 * cause. Raised by the claude review lane as a behaviour change with no test.
 *
 * These tests mock the forge layer, which is why they live in their own file:
 * `checks.test.ts` deliberately avoids that mock so its other cases exercise
 * the real dispatcher.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeForgeCommandMock = vi.fn();
vi.mock('../../../lib/forge.js', () => ({
  executeForgeCommand: (...args: unknown[]) => executeForgeCommandMock(...args),
  loadForgeConfig: () => ({ provider: 'gitea' }),
  getForgeCommand: () => '/scripts/forge/gitea/pr-exists.sh',
  isConceptDisabled: () => false,
}));

const { runPhaseChecks } = await import('../checks.js');

describe('#12 — pr_exists distinguishes "no PR" from "could not answer"', () => {
  // A real git checkout, not tmpdir: the check reads the current branch with
  // `git branch --show-current` before it ever calls the concept, and that
  // throws outside a repository — masking every assertion below.
  const cwd = process.cwd();
  const env = { PROJECT_ID: '12', PROJECT_TITLE: 'test-project' };
  const checks = { pr_exists: 'unused — the concept is intercepted' };

  beforeEach(() => {
    executeForgeCommandMock.mockReset();
  });

  it('passes when the concept answers true', async () => {
    executeForgeCommandMock.mockResolvedValue('true');
    const [result] = await runPhaseChecks(checks, cwd, env);
    expect(result.passed).toBe(true);
  });

  it('fails with output "false" when the concept answers false', async () => {
    executeForgeCommandMock.mockResolvedValue('false');
    const [result] = await runPhaseChecks(checks, cwd, env);
    expect(result.passed).toBe(false);
    expect(result.output).toBe('false');
    // A real answer carries no error — the check failed because there is no PR,
    // which is a legitimate, actionable state.
    expect(result.error).toBeUndefined();
  });

  it('fails with a DISTINCT error when the concept returns null', async () => {
    executeForgeCommandMock.mockResolvedValue(null);
    const [result] = await runPhaseChecks(checks, cwd, env);

    expect(result.passed).toBe(false);
    // The load-bearing assertion: it must not present as the string "null",
    // which is what made this indistinguishable from an answer of false.
    expect(result.output).not.toBe('null');
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/no usable answer/);
    expect(result.error).toMatch(/failed, timed out, or is disabled/);
    expect(result.error, 'the error must deny the "no PR exists" reading outright')
      .toMatch(/NOT the same as "no PR exists"/);
  });
});
