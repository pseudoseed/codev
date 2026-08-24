/**
 * Issue #57 — `PROTOCOL COMPLETE` printed over unlanded work.
 *
 * `porch done` writes its own state commits AFTER the PR it was tracking has
 * merged. `done --merged N` runs by definition after the merge, and the terminal
 * transition commits `protocol complete` immediately before the banner. Neither
 * can be in that PR, so the branch is ahead of its base at the exact moment
 * porch says the work is done:
 *
 *     $ git log --oneline origin/main..HEAD
 *     9bef385 chore(porch): bugfix-109 protocol complete
 *     d93585d chore(porch): bugfix-109 PR #116 merged
 *
 * The banner is the builder's done signal. One builder trusted it and stopped
 * with work unlanded; another did not, and improvised a second PR that no phase
 * owned, no gate covered, and — the part that cost real time — that no
 * notification was attached to, so the architect was never told anyone was
 * waiting.
 *
 * These tests drive real git repositories. The answer depends entirely on what
 * git reports, and a mock would only assert that the code calls the functions it
 * calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { findUnlandedCommits, isLandingError, completionReport, type LandingStatus } from '../unlanded.js';

let root: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(cwd: string, file: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', message);
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'i57-'));
  root = path.join(base, 'origin');
  clone = path.join(base, 'work');
  fs.mkdirSync(root, { recursive: true });

  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'test');
  commit(root, 'README.md', 'initial');

  execFileSync('git', ['clone', root, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(clone, 'config', 'user.email', 't@example.com');
  git(clone, 'config', 'user.name', 'test');
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

/** Narrow to the success shape, failing loudly rather than silently skipping. */
function landed(r: ReturnType<typeof findUnlandedCommits>): LandingStatus {
  if (isLandingError(r)) throw new Error(`expected a landing status, got error: ${r.error}`);
  return r;
}

describe('#57: the situation the banner was printing over', () => {
  it('reports the porch state commits that the merged PR could not contain', () => {
    // Exactly the reported reproduction: the PR has merged, and porch then
    // writes two commits that by definition are not in it.
    commit(clone, 'a.txt', 'chore(porch): bugfix-109 PR #116 merged');
    commit(clone, 'b.txt', 'chore(porch): bugfix-109 protocol complete');

    const status = landed(findUnlandedCommits(clone, 'main'));

    expect(status.commits).toHaveLength(2);
    expect(status.commits.map(c => c.subject)).toEqual([
      'chore(porch): bugfix-109 protocol complete',
      'chore(porch): bugfix-109 PR #116 merged',
    ]);
  });

  it('reports nothing unlanded when the branch really is landed', () => {
    const status = landed(findUnlandedCommits(clone, 'main'));

    expect(status.commits).toEqual([]);
    expect(status.base).toBe('origin/main');
  });

  it('carries a short sha and a subject per commit, which is what the banner prints', () => {
    commit(clone, 'a.txt', 'chore(porch): bugfix-109 protocol complete');

    const [c] = landed(findUnlandedCommits(clone, 'main')).commits;

    expect(c.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(c.subject).toBe('chore(porch): bugfix-109 protocol complete');
  });

  it('accepts a base that already carries the origin/ prefix', () => {
    commit(clone, 'a.txt', 'unlanded');

    expect(landed(findUnlandedCommits(clone, 'origin/main')).base).toBe('origin/main');
    expect(landed(findUnlandedCommits(clone, 'main')).base).toBe('origin/main');
  });

  it('counts only what is ahead, not what the base has moved on to', () => {
    // The base gaining commits does not make this branch unlanded. Using a
    // symmetric range here would report the base's own work as the builder's.
    commit(root, 'upstream.txt', 'someone else landed this');
    commit(clone, 'mine.txt', 'mine');
    git(clone, 'fetch', 'origin');

    const status = landed(findUnlandedCommits(clone, 'main'));

    expect(status.commits.map(c => c.subject)).toEqual(['mine']);
  });
});

describe('#57: "could not check" is not "nothing unlanded"', () => {
  // The two lead to opposite actions. Collapsing them is how a branch with
  // unlanded work gets a clean bill of health.
  it('reports an error, not an empty list, when the base ref was never fetched', () => {
    const solo = fs.mkdtempSync(path.join(tmpdir(), 'i57-solo-'));
    git(solo, 'init', '--initial-branch=main');
    git(solo, 'config', 'user.email', 't@example.com');
    git(solo, 'config', 'user.name', 'test');
    commit(solo, 'README.md', 'initial');

    const r = findUnlandedCommits(solo, 'main');

    expect(isLandingError(r)).toBe(true);
    expect((r as { error: string }).error).toContain('origin/main');
  });

  it('reports an error outside a git repository rather than claiming clean', () => {
    const notRepo = fs.mkdtempSync(path.join(tmpdir(), 'i57-norepo-'));

    const r = findUnlandedCommits(notRepo, 'main');

    expect(isLandingError(r)).toBe(true);
  });

  it('reports an error for a base branch that does not exist on the remote', () => {
    const r = findUnlandedCommits(clone, 'no-such-branch');

    expect(isLandingError(r)).toBe(true);
    expect((r as { error: string }).error).toContain('origin/no-such-branch');
  });

  it('never throws — the caller renders three outcomes and has no fourth', () => {
    expect(() => findUnlandedCommits('/nonexistent/path/for/i57', 'main')).not.toThrow();
  });
});

/**
 * The wording IS the fix. A builder acts on what this says, so it is asserted
 * rather than eyeballed.
 */
describe('#57: what the builder actually reads', () => {
  const twoUnlanded = {
    base: 'origin/main',
    commits: [
      { sha: '9bef385', subject: 'chore(porch): bugfix-109 protocol complete' },
      { sha: 'd93585d', subject: 'chore(porch): bugfix-109 PR #116 merged' },
    ],
  };

  it('does not say PROTOCOL COMPLETE without qualification while commits are stranded', () => {
    // The defect in one line: the old banner's first line was
    // `🎉 PROTOCOL COMPLETE` regardless of the branch state.
    const { severity, lines } = completionReport('bugfix-109', 'bugfix', 'main', twoUnlanded);

    expect(severity).toBe('unlanded');
    expect(lines[0]).toBe('PROTOCOL COMPLETE — 2 COMMITS NOT LANDED');
    expect(lines[0]).not.toContain('🎉');
  });

  it('names every stranded commit, so the builder does not have to go looking', () => {
    const { lines } = completionReport('bugfix-109', 'bugfix', 'main', twoUnlanded);
    const text = lines.join('\n');

    expect(text).toContain('9bef385 chore(porch): bugfix-109 protocol complete');
    expect(text).toContain('d93585d chore(porch): bugfix-109 PR #116 merged');
  });

  it('gives the notification command, which is the step the improvised PR skipped', () => {
    // The improvised follow-up PR had no notification attached, so the architect
    // was never told the builder was waiting. That is the part that cost time.
    const { lines } = completionReport('bugfix-109', 'bugfix', 'main', twoUnlanded);
    const text = lines.join('\n');

    expect(text).toContain('afx send architect');
    expect(text).toContain('Do NOT open a follow-up PR on your own');
  });

  it('says the state commits are expected, so the builder does not read this as a defect', () => {
    const text = completionReport('bugfix-109', 'bugfix', 'main', twoUnlanded).lines.join('\n');

    expect(text).toContain('This is expected');
  });

  it('agrees on singular and plural rather than printing "1 COMMITS"', () => {
    const one = completionReport('bugfix-109', 'bugfix', 'main', {
      base: 'origin/main',
      commits: [{ sha: 'abc1234', subject: 'only one' }],
    });

    expect(one.lines[0]).toBe('PROTOCOL COMPLETE — 1 COMMIT NOT LANDED');
    expect(one.lines.join('\n')).toContain('this commit is in no PR');
    expect(one.lines.join('\n')).toContain('1 porch state commit unlanded');
  });

  it('still celebrates when there is genuinely nothing unlanded', () => {
    const { severity, lines } = completionReport('bugfix-109', 'bugfix', 'main', {
      base: 'origin/main',
      commits: [],
    });

    expect(severity).toBe('complete');
    expect(lines[0]).toBe('🎉 PROTOCOL COMPLETE');
    expect(lines.join('\n')).toContain('Nothing unlanded');
  });

  it('spells "could not check" differently from "clean", and offers the manual check', () => {
    const { severity, lines } = completionReport('bugfix-109', 'bugfix', 'main', {
      error: 'origin/main is not available locally (never fetched, or no remote)',
    });
    const text = lines.join('\n');

    expect(severity).toBe('unverified');
    expect(lines[0]).toBe('PROTOCOL COMPLETE — LANDING NOT VERIFIED');
    expect(lines[0]).not.toContain('🎉');
    expect(text).toContain('Could not check whether this branch is landed');
    expect(text).toContain('git log --oneline origin/main..HEAD');
  });

  it('the three severities are distinguishable by their first line alone', () => {
    // A builder skims. If the three read alike at a glance, the report has not
    // fixed anything.
    const first = (l: { error: string } | LandingStatus) =>
      completionReport('x', 'bugfix', 'main', l).lines[0];

    const heads = [
      first({ base: 'origin/main', commits: [] }),
      first(twoUnlanded),
      first({ error: 'nope' }),
    ];

    expect(new Set(heads).size).toBe(3);
  });
});
