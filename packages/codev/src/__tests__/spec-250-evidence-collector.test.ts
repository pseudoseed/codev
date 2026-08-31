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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const collector = join(repoRoot, 'tools', 't3-server', 'collect-spec-250-evidence.mjs');

/**
 * Everything the collector reads, relative to the root it derives from its own
 * location. Kept as one list because a scratch root that is missing one of them
 * makes the collector exit 3 for `MISSING_RUN` — the right code for the wrong
 * reason, which would let a broken fixture masquerade as the refusal under test.
 */
const COLLECTOR_INPUTS = [
  'codev/resources/250-acceptance-evidence.md',
  'codev/research/250-rebase-drill.json',
  'codev/research/250-criterion-8b-evidence.json',
  'codev/research/250-hierarchy-wire-evidence.json',
  'codev/research/250-upstream-movement.json',
  'packages/types/src/t3/pin.json',
] as const;

const run = (root: string, ...args: string[]) =>
  spawnSync(
    process.execPath,
    [join(root, 'tools', 't3-server', 'collect-spec-250-evidence.mjs'), ...args],
    { encoding: 'utf8', cwd: root },
  );

/**
 * A throwaway tree the collector can be made to fail in.
 *
 * The five refusal tests below all work by DAMAGING an input, and the earlier
 * version of this file damaged the committed file in place and restored it in a
 * `finally`. Two things were wrong with that. A killed run left a mutated
 * tracked file and a stray `.spec250-test-backup` behind; and
 * `spec-250-vendoring-identities.test.ts` reads
 * `codev/research/250-criterion-8b-evidence.json` in its module body, so a
 * parallel vitest worker collecting that file while this one held the mutation
 * would fail on corrupted data, for reasons nothing in its own output would
 * explain.
 *
 * The collector resolves its root from `import.meta.url`, so a COPY of the
 * script under a scratch tree reads that tree's inputs — the same technique
 * `rebase-drill.mjs` uses to regenerate the contract without moving the pin. No
 * flag is added to the tool to suit a test, and nothing tracked is written.
 *
 * `agrees with the committed evidence` still runs the REAL collector against the
 * REAL repository, because that is the assertion whose value depends on the
 * actual committed files. Only the damage cases are relocated.
 */
function withScratchRoot<T>(body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'spec250-evidence-'));
  try {
    mkdirSync(join(root, 'tools', 't3-server'), { recursive: true });
    copyFileSync(collector, join(root, 'tools', 't3-server', 'collect-spec-250-evidence.mjs'));
    for (const relative of COLLECTOR_INPUTS) {
      const destination = join(root, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(repoRoot, relative), destination);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Read one of the collector's inputs out of a scratch root. */
const scratch = (root: string, relative: string) => join(root, relative);

describe('spec 250 phase 11: the acceptance evidence collector', () => {
  it('agrees with the committed evidence', () => {
    // The one case that must use the REAL tree: it is asserting that the numbers
    // committed to this repository still match the runs behind them.
    const result = run(repoRoot, '--check');
    expect(result.status, result.stderr).toBe(0);
  });

  /**
   * The failure this exists to prevent: numbers that describe a fork nobody is
   * looking at any more, in the same shape as numbers that describe this one.
   */
  it('refuses evidence describing a different fork, with its own exit code', () => {
    const result = withScratchRoot(root => {
      const criterion8b = scratch(root, 'codev/research/250-criterion-8b-evidence.json');
      const evidence = JSON.parse(readFileSync(criterion8b, 'utf8')) as Record<string, unknown>;
      evidence.forkCommit = '0'.repeat(40);
      writeFileSync(criterion8b, `${JSON.stringify(evidence, null, 2)}\n`);
      return run(root, '--check');
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('STALE_RUN');
  });

  it('fails a drifted evidence block, and not with the unreadable code', () => {
    const result = withScratchRoot(root => {
      const evidenceMd = scratch(root, 'codev/resources/250-acceptance-evidence.md');
      const markdown = readFileSync(evidenceMd, 'utf8');
      writeFileSync(
        evidenceMd,
        markdown.replace('| customization commits carried |', '| customization commits carried x |'),
      );
      return run(root, '--check');
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
    const result = withScratchRoot(root => {
      const movement = scratch(root, 'codev/research/250-upstream-movement.json');
      const parsed = JSON.parse(readFileSync(movement, 'utf8'));
      parsed.range = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..origin/main';
      writeFileSync(movement, JSON.stringify(parsed, null, 2));
      return run(root, '--check');
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
    const result = withScratchRoot(root => {
      const movement = scratch(root, 'codev/research/250-upstream-movement.json');
      const parsed = JSON.parse(readFileSync(movement, 'utf8'));
      parsed.identity = 'fork';
      writeFileSync(movement, JSON.stringify(parsed, null, 2));
      return run(root, '--check');
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('WRONG_IDENTITY');
  });

  it('refuses to guess where the block goes', () => {
    const result = withScratchRoot(root => {
      const evidenceMd = scratch(root, 'codev/resources/250-acceptance-evidence.md');
      const markdown = readFileSync(evidenceMd, 'utf8');
      writeFileSync(evidenceMd, markdown.replace('<!-- spec-250-evidence:begin -->', ''));
      return run(root, '--check');
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('NO_MARKERS');
  });
});
