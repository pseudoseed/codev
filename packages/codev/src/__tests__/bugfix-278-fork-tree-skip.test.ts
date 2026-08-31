/**
 * Bugfix #278 — the spec 250 suite must not let a live working tree decide an
 * assertion about `contractSource`.
 *
 * `spec-250-vendoring-identities.test.ts` runs `t3-server verify` twice against
 * the REAL fork checkout, changing only `pin.contractSource`, and asserts that
 * only the exit code moves: 1 while the contract is fork-sourced, 0 while it is
 * upstream-sourced. But `verify` also exits 1 on `DIRTY_FORK_CHECKOUT`, and the
 * fork checkout is one worktree on `codev` that builders edit while fork work is
 * in flight. So the 0 half failed for a reason the test was not making a claim
 * about, and every builder running the suite saw a red result it did not cause.
 *
 * Two things are pinned here:
 *
 *   1. `inspectCheckoutTree` answers in three states, and `unknown` is never
 *      spelled the same as `clean`.
 *   2. The state it calls `dirty` is EXACTLY the state that makes `verify` exit 1
 *      for the unrelated reason — asserted by running the harness, not by
 *      reasoning about it. A guard whose predicate does not match the failure it
 *      guards against is not a guard.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLEAN,
  DIRTY,
  UNKNOWN,
  firstUnobservable,
  inspectCheckoutTree,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — a dependency-free .mjs helper shared with the build tools, not a package
} from '../../../../tools/t3-fork/checkout-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
const pin = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'),
);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'bugfix278', GIT_AUTHOR_EMAIL: 'bugfix278@example.invalid',
  GIT_COMMITTER_NAME: 'bugfix278', GIT_COMMITTER_EMAIL: 'bugfix278@example.invalid',
};
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv }).trim();

/** A repository with one commit, so the assertions run against real `git`. */
function makeRepo(label: string): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), `b278-${label}-`));
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), `${label}\n`);
  gitIn(dir, 'add', 'README.md');
  gitIn(dir, 'commit', '-qm', 'one');
  return { dir, head: gitIn(dir, 'rev-parse', 'HEAD') };
}

describe('bugfix 278: a checkout tree answers clean, dirty, or unknown', () => {
  it('reports a committed tree clean, with no reason to report', () => {
    const repo = makeRepo('clean');
    try {
      const seen = inspectCheckoutTree(repo.dir);
      expect(seen.state).toBe(CLEAN);
      expect(seen.reason).toBeNull();
      expect(seen.entries).toEqual([]);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('names the checkout and what is in the way when the tree is dirty', () => {
    const repo = makeRepo('dirty');
    try {
      writeFileSync(join(repo.dir, 'lan-serve.mjs'), 'untracked\n');
      const seen = inspectCheckoutTree(repo.dir);
      expect(seen.state).toBe(DIRTY);
      // The path, so the next reader does not have to re-derive which file it was.
      expect(seen.reason).toContain(repo.dir);
      expect(seen.reason).toContain('lan-serve.mjs');
      expect(seen.entries).toEqual(['?? lan-serve.mjs']);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('states that it truncated rather than presenting a short list as the whole list', () => {
    const repo = makeRepo('many');
    try {
      for (const n of [1, 2, 3, 4, 5, 6]) writeFileSync(join(repo.dir, `f${n}.txt`), 'x\n');
      const seen = inspectCheckoutTree(repo.dir);
      expect(seen.state).toBe(DIRTY);
      expect(seen.entries).toHaveLength(6);
      expect(seen.reason).toContain('6 uncommitted entries');
      expect(seen.reason).toContain('and 2 more');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('reports unknown, not clean, when nothing is there to look at', () => {
    const seen = inspectCheckoutTree(join(tmpdir(), 'b278-does-not-exist'));
    expect(seen.state).toBe(UNKNOWN);
    expect(seen.reason).toContain('b278-does-not-exist');
  });

  it('reports unknown, not clean, when `git status` itself fails', () => {
    const repo = makeRepo('unreadable');
    try {
      // A `git status` that failed answered nothing. Empty stdout from a failed
      // run is the exact "could not tell spelled as no" this guard exists to
      // prevent, so the failing branch is exercised directly rather than assumed.
      const seen = inspectCheckoutTree(
        repo.dir,
        () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository\n' }),
      );
      expect(seen.state).toBe(UNKNOWN);
      expect(seen.state).not.toBe(CLEAN);
      expect(seen.reason).toContain('fatal: not a git repository');
      expect(seen.reason).toContain('unknown is not clean');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('names WHICH of several checkouts is unobservable', () => {
    const ok = makeRepo('first-ok');
    const bad = makeRepo('second-dirty');
    try {
      writeFileSync(join(bad.dir, 'stray.txt'), 'x\n');
      expect(firstUnobservable([ok.dir, ok.dir])).toBeNull();
      const blocker = firstUnobservable([ok.dir, bad.dir]);
      expect(blocker.state).toBe(DIRTY);
      expect(blocker.reason).toContain(bad.dir);
      expect(blocker.reason).not.toContain(ok.dir);
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
      rmSync(bad.dir, { recursive: true, force: true });
    }
  });
});

describe('bugfix 278: the dirty state is the one that decides the exit code', () => {
  /**
   * The seam, run rather than reasoned about.
   *
   * A fork one commit ahead of an upstream-sourced contract is the tolerated
   * state: `verify` warns `FORK_AHEAD_OF_CONTRACT` and exits 0. Adding one
   * untracked file — nothing to do with `contractSource` — flips it to 1. That
   * flip is what turned the spec 250 assertion red, and `inspectCheckoutTree`
   * must call exactly that tree dirty. Asserting the guard's verdict without
   * asserting the exit code it stands in for would test one end of the seam.
   */
  it('verify exits 0 on the tolerated ahead state and 1 once the same tree is dirty', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'b278-seam-'));
    const upstream = makeRepo('seam-up');
    try {
      const forkDir = join(scratch, 'fork');
      execFileSync('git', ['clone', '-q', upstream.dir, forkDir], { env: gitEnv });
      gitIn(forkDir, 'checkout', '-q', '-b', 'codev');
      writeFileSync(join(forkDir, 'ours.txt'), 'a customization\n');
      gitIn(forkDir, 'add', 'ours.txt');
      gitIn(forkDir, 'commit', '-qm', 'a customization');

      const pinFile = join(scratch, 'pin.json');
      writeFileSync(pinFile, JSON.stringify({
        ...pin,
        commit: upstream.head,
        upstreamBase: upstream.head,
        contractSource: 'upstream',
      }, null, 2));

      const runVerify = () => spawnSync(process.execPath, [harness, 'verify'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          T3_PIN_FILE: pinFile, T3CODE_ROOT: upstream.dir, T3CODE_FORK_ROOT: forkDir,
        },
      });

      expect(inspectCheckoutTree(forkDir).state).toBe(CLEAN);
      const clean = runVerify();
      expect(clean.stderr).toContain('FORK_AHEAD_OF_CONTRACT');
      expect(clean.status, 'ahead of an upstream-sourced contract is tolerated').toBe(0);

      writeFileSync(join(forkDir, 'lan-serve.mjs'), 'untracked\n');

      const seen = inspectCheckoutTree(forkDir);
      expect(seen.state, 'the guard must call this tree dirty').toBe(DIRTY);

      const dirty = runVerify();
      expect(dirty.stderr).toContain('DIRTY_FORK_CHECKOUT');
      expect(
        dirty.status,
        'one untracked file, no pin change, and the exit code moved — this is what the guard is for',
      ).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  /**
   * The wiring. The unit tests above prove the predicate; this proves the spec 250
   * suite actually gates on it, which is the thing that was missing.
   */
  it('the spec 250 real-checkout test gates on observability and says why it skipped', () => {
    const src = readFileSync(join(here, 'spec-250-vendoring-identities.test.ts'), 'utf8');
    expect(src, 'presence is not the same question as being observable')
      .toContain('REAL_CHECKOUTS_OBSERVABLE');
    expect(src).toMatch(/it\.skipIf\(!REAL_CHECKOUTS_OBSERVABLE\)/);
    expect(src, 'the skip must carry a reason, not be blank')
      .toContain('realCheckoutSkipReason');
    expect(src, 'the reason comes from the checkout probe, not a hand-written string')
      .toContain('firstUnobservable');
  });
});
