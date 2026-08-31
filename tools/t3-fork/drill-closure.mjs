/**
 * Spec 250 phase 11 — the drill's one decision that is worth testing on its own.
 *
 * `rebase-drill.mjs` is a script with top-level side effects: importing it runs a
 * drill. Nothing inside it can be reached from a unit test, so every branch there
 * is covered only by whatever the last real run happened to take. That is fine
 * for measurements — a run either produced the number or it did not — and it is
 * NOT fine for the guard below, whose whole job is to fire on cases a normal run
 * never reaches.
 *
 * ## The failure it exists to prevent
 *
 * The drill hashes the pinned contract closure off the MERGED worktree and
 * compares it to `generated/source-hash.json`. That comparison is only meaningful
 * while a merge is actually on disk. Two ways it stops being:
 *
 *   1. `git merge --abort` has already run. The worktree is the fork again, so
 *      the closure is compared to the contract generated FROM that same fork, and
 *      the answer is `moved: []` on every run forever. That one is prevented by
 *      call ORDER in the drill, and checked by hashing the unmerged fork directly.
 *   2. The merge never produced a tree at all — already up to date, a wedged
 *      index, a git that failed for its own reasons. The worktree is *also* the
 *      unmerged fork, and there are no conflicts to notice, so a guard that only
 *      asks "did the closure conflict" waves it through into exactly the same
 *      tautology by a different door.
 *
 * The second is what this module decides, separately, so a test can reach it.
 * Neither case may report a comparison: they report `checked: false` and a
 * reason, because "I could not compare" must never be spelled like "nothing
 * moved".
 */

/**
 * Can the merged closure be compared to the vendored contract, and if not, why?
 *
 * @param {object} args
 * @param {boolean} args.mergeOk        did `git merge --no-commit` exit zero
 * @param {string[]} args.conflictedFiles  every file the merge left conflicted
 * @param {string[]} args.closureConflicts  the subset of those inside the closure
 * @param {string} [args.gitSaid]       git's output, for the refusal's reason
 * @returns {{measurable: true} | {measurable: false, reason: string}}
 */
export function closureMeasurability({ mergeOk, conflictedFiles, closureConflicts, gitSaid = '' }) {
  /*
   * A merge that neither completed nor conflicted did not happen. Checked FIRST,
   * because the closure-conflict question below is vacuously satisfied in exactly
   * this case — zero conflicts, because there was no merge to conflict.
   */
  if (!mergeOk && conflictedFiles.length === 0) {
    const said = gitSaid.split('\n').filter(Boolean).slice(0, 3).join(' / ');
    return {
      measurable: false,
      reason: 'the probe merge neither completed nor conflicted, so the worktree is still the '
        + 'unmerged fork and hashing it would compare the fork to itself.'
        + (said ? ` git said: ${said}` : ''),
    };
  }
  if (closureConflicts.length > 0) {
    return {
      measurable: false,
      reason: `${closureConflicts.join(', ')} conflicted, so the merged tree holds no single `
        + "version of the generator's source to hash.",
    };
  }
  return { measurable: true };
}
