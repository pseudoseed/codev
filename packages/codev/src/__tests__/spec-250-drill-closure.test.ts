/**
 * Spec 250 phase 11 — the drill's measurability guard, reached directly.
 *
 * `rebase-drill.mjs` is a script: importing it runs a drill against two real
 * checkouts. So every branch inside it is covered only by whatever the last real
 * run happened to take — which is exactly the wrong coverage for a guard that
 * exists to fire on cases a normal run never reaches.
 *
 * The case that matters is a `git merge` that neither completes nor conflicts.
 * The worktree is then the UNMERGED fork, and the closure would be compared to
 * the contract generated from that same fork: `moved: []`, on every run, forever,
 * looking exactly like good news. A guard that only asks "did the closure
 * conflict" is vacuously satisfied there — zero conflicts, because there was no
 * merge to conflict.
 *
 * **The order of the two checks is NOT asserted here, and the comment where the
 * assertion would go explains why.** An earlier draft of this header said it was;
 * that sentence outlived the test it described by one commit, which is the
 * iteration 1 defect in miniature — a comment claiming a check that is not
 * there. The opencode lane caught it.
 */

import { describe, expect, it } from 'vitest';

import { closureMeasurability } from '../../../../tools/t3-fork/drill-closure.mjs';

describe('spec 250 phase 11: the drill closure measurability guard', () => {
  it('measures when the merge produced a tree and the closure came through clean', () => {
    expect(closureMeasurability({
      mergeOk: false,
      conflictedFiles: ['apps/server/src/server.test.ts'],
      closureConflicts: [],
    })).toEqual({ measurable: true });
  });

  it('measures when the merge completed outright', () => {
    expect(closureMeasurability({
      mergeOk: true,
      conflictedFiles: [],
      closureConflicts: [],
    })).toEqual({ measurable: true });
  });

  /**
   * THE BRANCH NO REAL RUN REACHES.
   *
   * `mergeOk: false` with nothing conflicted is a merge that did not happen. Note
   * that `closureConflicts` is empty here, which is what makes this dangerous:
   * the closure question answers "clean" for the wrong reason.
   */
  it('refuses when the merge neither completed nor conflicted', () => {
    const verdict = closureMeasurability({
      mergeOk: false,
      conflictedFiles: [],
      closureConflicts: [],
      gitSaid: 'Already up to date.\nfatal: something else\nthird line\nfourth line',
    });
    expect(verdict.measurable).toBe(false);
    expect(verdict.reason).toContain('neither completed nor conflicted');
    expect(verdict.reason).toContain('compare the fork to itself');
    // git's own words are carried, capped at three lines so a wall of output
    // cannot bury the reason.
    expect(verdict.reason).toContain('Already up to date.');
    expect(verdict.reason).not.toContain('fourth line');
  });

  /** A refusal must still be a refusal when git said nothing at all. */
  it('refuses without git output, and does not emit a dangling "git said"', () => {
    const verdict = closureMeasurability({
      mergeOk: false,
      conflictedFiles: [],
      closureConflicts: [],
    });
    expect(verdict.measurable).toBe(false);
    expect(verdict.reason).not.toContain('git said');
  });

  it('refuses when the generator\'s own source conflicted, and names the files', () => {
    const verdict = closureMeasurability({
      mergeOk: false,
      conflictedFiles: ['packages/contracts/src/orchestration.ts', 'apps/web/src/x.ts'],
      closureConflicts: ['packages/contracts/src/orchestration.ts'],
    });
    expect(verdict.measurable).toBe(false);
    expect(verdict.reason).toContain('packages/contracts/src/orchestration.ts');
    expect(verdict.reason).toContain('no single');
  });

  /*
   * NO ORDER TEST, AND THE REASON IS THE INTERESTING PART.
   *
   * A first draft asserted that the no-merge check runs before the closure-
   * conflict check. Swapping the two in the module left it passing, which is the
   * signal that it was not a test: `closureConflicts` is a subset of
   * `conflictedFiles`, so a non-empty closure conflict implies a non-empty
   * conflict list, and the no-merge branch requires that list to be EMPTY. The
   * two conditions cannot both hold for well-formed input, so there is no order
   * to assert and no input that could distinguish one ordering from the other.
   *
   * The comment in the module still explains why the no-merge check is written
   * first — it reads as the safer arrangement and it is free — but "reads safer"
   * is not a property, and a test that cannot fail claiming otherwise is worse
   * than no test.
   */
});
