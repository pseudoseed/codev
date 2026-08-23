/**
 * Deriving a porch project id from a builder worktree path.
 *
 * Split out of `state.ts` (issue #41) so that callers who need only this rule
 * do not drag in the rest of that module. `state.ts` promisifies `execFile` at
 * module load for `writeStateAndCommit`, which makes importing it from a leaf
 * utility surprisingly expensive — and, in one case, breaking: `doctor.test.ts`
 * partially mocks `node:child_process` without `execFile`, so any new import
 * edge that reaches `state.ts` fails 24 of its tests with
 * `No "execFile" export is defined on the "node:child_process" mock`.
 *
 * This module has no imports beyond `node:path` and must stay that way.
 * `state.ts` re-exports from here, so existing importers are unaffected.
 */

import * as path from 'node:path';

/**
 * Derive the porch project id from a path inside a builder worktree.
 *
 * Returns null when the path is not a recognized builder worktree — callers
 * treat that as "cannot tell", never as a default.
 */
export function detectProjectIdFromCwd(cwd: string): string | null {
  const normalized = path.resolve(cwd).split(path.sep).join('/');
  // bugfix worktrees: .builders/bugfix-{N}-{slug} (slug optional)
  //   porch project ID is "bugfix-{N}" — historical convention, kept untouched.
  // PIR / SPIR / ASPIR / AIR worktrees: .builders/{prefix}-{N}-{slug} (slug optional)
  //   porch project ID is the bare numeric ID.
  // Spec worktrees (legacy): .builders/{NNNN} (bare 4-digit ID, no slug)
  const match = normalized.match(
    /\/\.builders\/(bugfix-(\d+)(?:-[^/]*)?|(?:aspir|spir|air|pir)-(\d+)(?:-[^/]*)?|(\d{4}))(\/|$)/,
  );
  if (!match) return null;
  // bugfix uses "bugfix-N" as the porch project ID
  if (match[2]) return `bugfix-${match[2]}`;
  // Protocol worktrees (aspir, spir, air, pir) use the bare numeric ID
  if (match[3]) return match[3];
  // Spec worktrees use zero-padded numeric IDs
  return match[4];
}
