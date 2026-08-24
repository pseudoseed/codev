/**
 * Is this branch actually landed? (issue #57)
 *
 * `porch done` writes its own state commits AFTER the PR it was tracking has
 * merged -- `done --merged N` runs by definition after the merge, and the
 * terminal transition commits `protocol complete` immediately before printing
 * the completion banner. Those commits can never be in that PR, so the branch
 * is ahead of its base at the exact moment porch says the work is done.
 *
 * The banner is the builder's done signal. A builder that trusts it stops with
 * work unlanded; a builder that does not trust it improvises a second,
 * unmodelled PR that no phase owns, no gate covers, and -- the part that costs
 * real time -- that no notification step is attached to, so the architect is
 * never told anyone is waiting.
 *
 * This module answers the question the banner should have been asking. It is a
 * LEAF: `node:child_process` and `node:path` only. Reaching `porch/state.js`
 * from here would pull in its module-load `promisify(execFile)` and break the
 * doctor tests that mock `node:child_process`.
 */

import { execFileSync } from 'node:child_process';

/** One commit on this branch that is not on the base. */
export interface UnlandedCommit {
  sha: string;
  subject: string;
}

export interface LandingStatus {
  /** The ref compared against, e.g. `origin/main`. */
  base: string;
  /** Commits on HEAD that are not on `base`. Empty means landed. */
  commits: UnlandedCommit[];
}

/**
 * Commits on HEAD that are not on `origin/<base>`.
 *
 * Returns `null` when the question could not be ANSWERED -- no remote, the base
 * ref not fetched, not a repository, git missing. That is deliberately a third
 * outcome and not an empty list: "I could not check" and "nothing is unlanded"
 * lead to opposite actions, and collapsing them into one value is how a branch
 * with unlanded work gets a clean bill of health. Callers must render it as its
 * own case.
 */
export function findUnlandedCommits(
  worktreeRoot: string,
  base: string,
): LandingStatus | { error: string } {
  const baseRef = base.startsWith('origin/') ? base : `origin/${base}`;

  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: worktreeRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  // Resolve the base ref first, so "the ref is missing" is reported as itself
  // rather than as a rev-list that silently returned nothing.
  try {
    git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  } catch {
    return { error: `${baseRef} is not available locally (never fetched, or no remote)` };
  }

  let out: string;
  try {
    out = git(['log', '--format=%h %s', `${baseRef}..HEAD`]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg.split('\n')[0] };
  }

  const commits = out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const sp = line.indexOf(' ');
      return sp === -1
        ? { sha: line, subject: '' }
        : { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
    });

  return { base: baseRef, commits };
}

/** Narrowing helper — `findUnlandedCommits` returns one or the other. */
export function isLandingError(
  r: LandingStatus | { error: string },
): r is { error: string } {
  return 'error' in r;
}

/**
 * The lines the completion banner prints, as data (issue #57).
 *
 * Built here rather than inline at the console.log site so the wording -- which
 * IS the fix, since a builder acts on what this says -- can be asserted rather
 * than eyeballed.
 *
 * `chalk` is deliberately absent: colour is applied by the caller, so a test
 * compares text and not escape sequences.
 */
export function completionReport(
  projectId: string,
  protocolName: string,
  base: string,
  landing: LandingStatus | { error: string },
): { severity: 'complete' | 'unlanded' | 'unverified'; lines: string[] } {
  if (isLandingError(landing)) {
    return {
      severity: 'unverified',
      lines: [
        'PROTOCOL COMPLETE — LANDING NOT VERIFIED',
        '',
        `  Project ${projectId} has completed the ${protocolName} protocol.`,
        '',
        `  Could not check whether this branch is landed: ${landing.error}`,
        '  Verify by hand before cleaning up the worktree:',
        `    git log --oneline origin/${base}..HEAD`,
      ],
    };
  }

  if (landing.commits.length === 0) {
    return {
      severity: 'complete',
      lines: [
        '🎉 PROTOCOL COMPLETE',
        '',
        `  Project ${projectId} has completed the ${protocolName} protocol.`,
        `  Nothing unlanded — this branch matches ${landing.base}.`,
      ],
    };
  }

  const n = landing.commits.length;
  const s = n === 1 ? '' : 's';
  return {
    severity: 'unlanded',
    lines: [
      `PROTOCOL COMPLETE — ${n} COMMIT${s.toUpperCase()} NOT LANDED`,
      '',
      `  Project ${projectId} has completed the ${protocolName} protocol, but this`,
      `  branch is ahead of ${landing.base}, so ${n === 1 ? 'this commit is' : 'these commits are'} in no PR:`,
      '',
      ...landing.commits.map(c => `    ${c.sha} ${c.subject}`),
      '',
      '  Porch writes its own state commits after the PR merges, so they cannot be',
      '  in it. This is expected — it is being reported rather than hidden.',
      '',
      '  Do NOT open a follow-up PR on your own. Tell your architect and wait:',
      `    afx send architect "${projectId} complete; ${n} porch state commit${s} unlanded on this branch, need a decision"`,
      '',
      '  An unmodelled follow-up PR has no phase, no gate and no notification',
      '  attached, so nobody is told you are waiting on it (#57).',
    ],
  };
}
