/**
 * Bugfix #278 — "is this checkout observable right now?", answered in three states.
 *
 * A handful of assertions in the spec 250 suite must run against the REAL
 * checkouts rather than a fixture, because they are claims about what ships. But
 * those checkouts are working trees that people edit: the fork at
 * `DEFAULT_FORK_ROOT` is a single worktree on `codev` with no per-builder
 * isolation, so while fork work is in flight it carries modified and untracked
 * files that have nothing to do with the assertion.
 *
 * `t3-server verify` exits 1 on any uncommitted change (`DIRTY_FORK_CHECKOUT`),
 * which means a test asserting "only `contractSource` changed, so only the exit
 * code may" was being decided by whatever someone had left in the tree. That is
 * the "could not tell" spelled as "no" that the third exit code exists to
 * prevent — one level up, in the test rather than the tool.
 *
 * So: `clean` (the assertion can be made), `dirty` (it cannot, and here is what
 * is in the way), `unknown` (nobody could even look). Callers skip on the last
 * two with the reason attached, never pass.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const CLEAN = 'clean';
export const DIRTY = 'dirty';
export const UNKNOWN = 'unknown';

/** How many porcelain entries a one-line reason names before it says "and N more". */
const NAMED_ENTRIES = 4;

const runGitStatus = (root) =>
  spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });

/**
 * Summarize the entries on ONE line, because the reason's destination is a test
 * name. Truncation is stated rather than silent: a list that stops at four
 * without saying so reads as a complete list of four.
 */
function summarize(root, entries) {
  const named = entries.slice(0, NAMED_ENTRIES).join(', ');
  const rest = entries.length - NAMED_ENTRIES;
  return `${root} has ${entries.length} uncommitted ${entries.length === 1 ? 'entry' : 'entries'}: ` +
    `${named}${rest > 0 ? `, and ${rest} more` : ''}`;
}

/**
 * @param {string} root  the checkout to inspect
 * @param {(root: string) => { status: number|null, stdout: string, stderr: string, error?: Error }} run
 *        injectable for tests that must exercise the "git itself failed" branch
 * @returns {{ state: 'clean'|'dirty'|'unknown', reason: string|null, entries: string[] }}
 *          `reason` is null only when the state is `clean`.
 */
export function inspectCheckoutTree(root, run = runGitStatus) {
  if (typeof root !== 'string' || root === '') {
    return { state: UNKNOWN, reason: 'no checkout path given, so its tree state is unknown', entries: [] };
  }
  if (!existsSync(root)) {
    return { state: UNKNOWN, reason: `nothing at ${root}, so its tree state is unknown`, entries: [] };
  }

  const result = run(root);
  if (!result || result.status !== 0) {
    const detail = (result?.stderr ?? result?.error?.message ?? '').trim() || 'no output';
    return {
      state: UNKNOWN,
      reason: `\`git status --porcelain\` failed in ${root}: ${detail.split('\n')[0]}. ` +
        'Whether the tree is clean is unknown, and unknown is not clean',
      entries: [],
    };
  }

  const entries = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0) return { state: CLEAN, reason: null, entries: [] };
  return { state: DIRTY, reason: summarize(root, entries), entries };
}

/**
 * The first checkout that cannot be observed, or null when all of them can.
 *
 * Named separately so a caller depending on two checkouts reports WHICH one is in
 * the way rather than "one of them".
 */
export function firstUnobservable(roots, run = runGitStatus) {
  for (const root of roots) {
    const seen = inspectCheckoutTree(root, run);
    if (seen.state !== CLEAN) return seen;
  }
  return null;
}
