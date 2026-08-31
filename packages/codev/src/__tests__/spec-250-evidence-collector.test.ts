/**
 * Spec 250 phase 11 — the evidence collector, and the two ways it must refuse.
 *
 * The collector fills the numbers in `250-acceptance-evidence.md` from the
 * machine-readable runs, because a hand-typed "3 of 35 files conflict" is true
 * on the day it is typed and silently wrong after the next drill — and it is the
 * sentence a reader will quote.
 *
 * What is asserted here is not that it can fill a table. It is that its two
 * refusals are DIFFERENT, and that neither is spelled like success:
 *
 *   exit 3  the runs could not be read, or describe a different fork. Nothing
 *           is claimed about what they would have said.
 *   exit 1  the runs are fine and the committed evidence has drifted from them.
 *
 * Collapsing those would make "the evidence is stale" and "I could not check"
 * the same answer, on the file whose whole job is to be trustworthy.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const collector = join(repoRoot, 'tools', 't3-server', 'collect-spec-250-evidence.mjs');
const evidenceMd = join(repoRoot, 'codev', 'resources', '250-acceptance-evidence.md');
const criterion8b = join(repoRoot, 'codev', 'research', '250-criterion-8b-evidence.json');
const movement = join(repoRoot, 'codev', 'research', '250-upstream-movement.json');

const run = (...args: string[]) =>
  spawnSync(process.execPath, [collector, ...args], { encoding: 'utf8', cwd: repoRoot });

/** Restore a file from a snapshot taken before the test mutated it. */
function withRestored<T>(path: string, body: () => T): T {
  const backup = `${path}.spec250-test-backup`;
  copyFileSync(path, backup);
  try {
    return body();
  } finally {
    copyFileSync(backup, path);
    spawnSync('rm', ['-f', backup]);
  }
}

describe('spec 250 phase 11: the acceptance evidence collector', () => {
  it('agrees with the committed evidence', () => {
    const result = run('--check');
    expect(result.status, result.stderr).toBe(0);
  });

  /**
   * The failure this exists to prevent: numbers that describe a fork nobody is
   * looking at any more, in the same shape as numbers that describe this one.
   */
  it('refuses evidence describing a different fork, with its own exit code', () => {
    const result = withRestored(criterion8b, () => {
      const evidence = JSON.parse(readFileSync(criterion8b, 'utf8')) as Record<string, unknown>;
      evidence.forkCommit = '0'.repeat(40);
      writeFileSync(criterion8b, `${JSON.stringify(evidence, null, 2)}\n`);
      return run('--check');
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('STALE_RUN');
  });

  it('fails a drifted evidence block, and not with the unreadable code', () => {
    const result = withRestored(evidenceMd, () => {
      const markdown = readFileSync(evidenceMd, 'utf8');
      writeFileSync(
        evidenceMd,
        markdown.replace('| customization commits carried |', '| customization commits carried x |'),
      );
      return run('--check');
    });
    expect(result.status).toBe(1);
    // The two refusals must not be spelled the same way.
    expect(result.status).not.toBe(3);
  });

  /**
   * Without markers the collector would have to guess where the block goes, and
   * a guess produces a SECOND, contradictory table rather than an error.
   */
  /**
   * TWO RUNS, ONE RANGE.
   *
   * The churn totals come from the drill and the verdict split from
   * `classify-churn`. If those two describe different ranges the table pairs
   * "5 commits touch the closure" with a conflict surface measured across a
   * different span, and nothing in the rendered output would say so — every cell
   * is individually correct.
   *
   * Exit 3, not 1: a mismatched range is "I cannot make this claim", not "the
   * committed evidence has drifted".
   */
  it('refuses a churn classification covering a different range', () => {
    const result = withRestored(movement, () => {
      const parsed = JSON.parse(readFileSync(movement, 'utf8'));
      parsed.range = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..origin/main';
      writeFileSync(movement, JSON.stringify(parsed, null, 2));
      return run('--check');
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('STALE_RUN');
    expect(result.stderr).toContain('Two ranges in one table');
  });

  /**
   * Criterion 9 asks what UPSTREAM did. `classify-churn` will happily run
   * `--fork-drift` over the fork and emit the same JSON shape, and the fork
   * answering "what changed upstream" is a tautology that reports our own work
   * back to us.
   */
  it('refuses a churn classification run against the fork', () => {
    const result = withRestored(movement, () => {
      const parsed = JSON.parse(readFileSync(movement, 'utf8'));
      parsed.identity = 'fork';
      writeFileSync(movement, JSON.stringify(parsed, null, 2));
      return run('--check');
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('WRONG_IDENTITY');
  });

  it('refuses to guess where the block goes', () => {
    const result = withRestored(evidenceMd, () => {
      const markdown = readFileSync(evidenceMd, 'utf8');
      writeFileSync(evidenceMd, markdown.replace('<!-- spec-250-evidence:begin -->', ''));
      return run('--check');
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('NO_MARKERS');
  });
});
