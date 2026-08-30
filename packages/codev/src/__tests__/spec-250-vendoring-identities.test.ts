/**
 * Spec 250, Phase 1 — the two-identity vendoring harness.
 *
 * Spec 146 had one checkout and one meaning. Spec 250 adds a second with a
 * different meaning, and the failure that creates is not a missing feature — it
 * is a tool that believes it is looking at one identity while pointing at the
 * other. `acquire()` checked a commit out into the read-only upstream clone, and
 * both `smoke.mjs` and `live/integration.mjs` call it, so the moment `pin.commit`
 * named the fork an ordinary test run would have moved the clone off its pin.
 *
 * These tests exist while the fork head still EQUALS `upstreamBase`, on purpose:
 * every assertion below has a known answer, so a harness bug cannot hide inside a
 * real customization diff.
 *
 * Placed in `packages/codev` for the same reason as the spec 146 suite: this is
 * where `pnpm test` actually runs one.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHURN_MODES,
  DEFAULT_FORK_ROOT,
  DEFAULT_UPSTREAM_ROOT,
  MISMATCH,
  OK,
  UNDETERMINED,
  churnRange,
  classifyForkHead,
  contractSource,
  resolveIdentities,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — a dependency-free .mjs helper shared with the build tools, not a package
} from '../../../../tools/t3-fork/identities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const pinPath = join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json');
const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');
const churn = join(repoRoot, 'tools', 't3-codegen', 'classify-churn.mjs');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const pin = readJson(pinPath);

// ---------------------------------------------------------------- throwaway repos

/**
 * A real git repository with one commit, so exit-code assertions run against
 * `git` rather than against a mock that agrees with them.
 */
function makeRepo(label: string): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), `t3-${label}-`));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'spec250', GIT_AUTHOR_EMAIL: 'spec250@example.invalid',
        GIT_COMMITTER_NAME: 'spec250', GIT_COMMITTER_EMAIL: 'spec250@example.invalid',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  // The content is unique per repository on purpose. Two repos built from the
  // same bytes, message and (fixed) identity in the same second produce the SAME
  // commit sha, and an "unrelated histories" fixture that shares a commit with
  // the tree it is supposed to be unrelated to tests the opposite of its name.
  writeFileSync(join(dir, 'base.txt'), `base ${label} ${dir}\n`);
  git('add', 'base.txt');
  git('commit', '-qm', `base ${label}`);
  return { dir, head: git('rev-parse', 'HEAD') };
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'spec250', GIT_AUTHOR_EMAIL: 'spec250@example.invalid',
      GIT_COMMITTER_NAME: 'spec250', GIT_COMMITTER_EMAIL: 'spec250@example.invalid',
    },
  }).trim();
}

/** A pin file naming whatever shas the scenario needs. */
function writePin(dir: string, commit: string, upstreamBase: string): string {
  const path = join(dir, 'pin.json');
  writeFileSync(path, JSON.stringify({
    ...pin, commit, upstreamBase,
  }, null, 2));
  return path;
}

function runVerify(
  { pinFile, upstreamRoot, forkRoot }: { pinFile: string; upstreamRoot: string; forkRoot: string },
) {
  return spawnSync(process.execPath, [harness, 'verify'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      T3_PIN_FILE: pinFile,
      T3CODE_ROOT: upstreamRoot,
      T3CODE_FORK_ROOT: forkRoot,
    },
  });
}

// ---------------------------------------------------------------- pin shape

describe('spec 250: the pin names two identities', () => {
  it('carries upstreamBase alongside commit', () => {
    expect(pin.upstreamBase, 'pin.json must record the upstream base the fork branched from')
      .toMatch(/^[0-9a-f]{40}$/);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('names the private fork repository and branch', () => {
    expect(pin.forkRepo).toContain('pseudoseed/t3code');
    expect(pin.forkBranch).toBe('codev');
  });

  it('still points `repo` at the public upstream, which we never push to', () => {
    expect(pin.repo).toContain('pingdotgg/t3code');
  });
});

describe('spec 250: identity resolution', () => {
  it('resolves both roots from the environment, one variable each', () => {
    const ids = resolveIdentities(pin, {
      T3CODE_ROOT: '/tmp/up', T3CODE_FORK_ROOT: '/tmp/fork',
    });
    expect(ids.upstream.root).toBe('/tmp/up');
    expect(ids.fork.root).toBe('/tmp/fork');
    expect(ids.upstream.rootVar).toBe('T3CODE_ROOT');
    expect(ids.fork.rootVar).toBe('T3CODE_FORK_ROOT');
  });

  it('defaults each root to its own path rather than sharing one', () => {
    const ids = resolveIdentities(pin, {});
    expect(ids.upstream.root).toBe(DEFAULT_UPSTREAM_ROOT);
    expect(ids.fork.root).toBe(DEFAULT_FORK_ROOT);
    expect(ids.upstream.root).not.toBe(ids.fork.root);
  });

  it('pins upstream to upstreamBase and the fork to commit', () => {
    const ids = resolveIdentities({ ...pin, commit: 'f'.repeat(40), upstreamBase: 'a'.repeat(40) }, {});
    expect(ids.upstream.commit).toBe('a'.repeat(40));
    expect(ids.fork.commit).toBe('f'.repeat(40));
    expect(ids.fork.base).toBe('a'.repeat(40));
    expect(ids.diverged).toBe(true);
  });

  /**
   * A pre-250 pin has no `upstreamBase`. Resolving it to two identities that name
   * the same commit is deliberate: the alternative is every tool growing a
   * version check, and "one checkout, one meaning" is exactly what a pin without
   * an `upstreamBase` means.
   */
  it('reads a pin with no upstreamBase as one commit wearing both meanings', () => {
    const ids = resolveIdentities({ commit: 'b'.repeat(40), repo: 'x' }, {});
    expect(ids.upstream.commit).toBe('b'.repeat(40));
    expect(ids.fork.commit).toBe('b'.repeat(40));
    expect(ids.fork.base).toBe('b'.repeat(40));
    expect(ids.diverged).toBe(false);
  });

  it('refuses a pin with no commit at all rather than resolving to undefined', () => {
    expect(() => resolveIdentities({ repo: 'x' } as never, {})).toThrow(/no `commit`/);
  });
});

// ---------------------------------------------------------------- churn ranges

describe('spec 250: the two churn ranges are two questions', () => {
  const ids = resolveIdentities(
    { ...pin, commit: 'f'.repeat(40), upstreamBase: 'a'.repeat(40) },
    { T3CODE_ROOT: '/tmp/up', T3CODE_FORK_ROOT: '/tmp/fork' },
  );

  it('reads upstream movement from the upstream checkout, base..origin/main', () => {
    const range = churnRange('upstream-movement', ids);
    expect(range.root).toBe('/tmp/up');
    expect(range.from).toBe('a'.repeat(40));
    expect(range.to).toBe('origin/main');
  });

  /**
   * To HEAD, not to `pin.commit`. Once `pin.commit` was ruled to stay at
   * `upstreamBase` until regeneration, measuring to it reported zero drift for a
   * fork carrying real commits — "I could not tell" spelled like "nothing
   * changed", on the tool whose whole job is answering "what have we changed?".
   */
  it('reads fork drift from the fork checkout, base..HEAD', () => {
    const range = churnRange('fork-drift', ids);
    expect(range.root).toBe('/tmp/fork');
    expect(range.from).toBe('a'.repeat(40));
    expect(range.to).toBe('HEAD');
    expect(range.to).not.toBe(ids.fork.commit);
  });

  it('measures fork drift even while pin.commit still equals upstreamBase', () => {
    // The exact shape of phases 2-4: the contract pin has not moved, the
    // checkout has. A range of base..base would report a diverged fork as clean.
    const undiverged = resolveIdentities(
      { ...pin, commit: 'a'.repeat(40), upstreamBase: 'a'.repeat(40) },
      { T3CODE_FORK_ROOT: '/tmp/fork' },
    );
    const range = churnRange('fork-drift', undiverged);
    expect(range.from).toBe('a'.repeat(40));
    expect(range.to).toBe('HEAD');
    expect(`${range.from}..${range.to}`).not.toBe(`${range.from}..${range.from}`);
  });

  it('never resolves the two modes to the same range', () => {
    const a = churnRange('upstream-movement', ids);
    const b = churnRange('fork-drift', ids);
    expect(`${a.root}:${a.from}..${a.to}`).not.toBe(`${b.root}:${b.from}..${b.to}`);
  });

  it('throws on an unknown mode instead of picking one', () => {
    expect(() => churnRange('whatever', ids)).toThrow(/Unknown churn mode/);
    expect(Object.keys(CHURN_MODES).sort()).toEqual(['fork-drift', 'upstream-movement']);
  });
});

describe('spec 250: classify-churn refuses to guess which question it was asked', () => {
  it('exits 1 with no mode, naming both', () => {
    const result = spawnSync(process.execPath, [churn], { encoding: 'utf8' });
    expect(result.status).toBe(MISMATCH);
    expect(result.stderr).toContain('--upstream-movement');
    expect(result.stderr).toContain('--fork-drift');
    expect(result.stdout).toBe('');
  });

  it('exits 1 with both modes rather than silently preferring one', () => {
    const result = spawnSync(
      process.execPath, [churn, '--upstream-movement', '--fork-drift'], { encoding: 'utf8' },
    );
    expect(result.status).toBe(MISMATCH);
    expect(result.stderr).toContain('2 modes given');
  });

  /**
   * A missing checkout is `3`. Reporting "no drift" for a checkout nobody could
   * read is the exact spelling mistake this project keeps writing tests against.
   */
  it('exits 3, not 0, when the checkout it was told to read is absent', () => {
    const absent = join(tmpdir(), `t3-absent-${Date.now()}`);
    const result = spawnSync(process.execPath, [churn, '--fork-drift'], {
      encoding: 'utf8',
      env: { ...process.env, T3CODE_FORK_ROOT: absent },
    });
    expect(result.status).toBe(UNDETERMINED);
    expect(result.stderr).toContain('COULD_NOT_TELL');
  });

  it('exits 3 when a ref in the range does not resolve', () => {
    const repo = makeRepo('churn-noref');
    try {
      // A real repository that simply has no `origin/main`: unreadable ref, not
      // "upstream has not moved".
      const result = spawnSync(process.execPath, [churn, '--upstream-movement'], {
        encoding: 'utf8',
        env: { ...process.env, T3CODE_ROOT: repo.dir },
      });
      expect(result.status).toBe(UNDETERMINED);
      expect(result.stderr).toContain('COULD_NOT_TELL');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  /**
   * The `--upstream-movement` twin of the zero below. Upstream having moved is
   * the normal state on this machine, so the named zero is reached with a
   * throwaway checkout whose `origin/main` sits exactly where the range starts:
   * a real empty range, not a mocked one.
   */
  it('reports zero upstream movement as NO_UPSTREAM_MOVEMENT, exit 0', () => {
    const repo = makeRepo('churn-nomove');
    try {
      gitIn(repo.dir, 'update-ref', 'refs/remotes/origin/main', repo.head);
      const result = spawnSync(
        process.execPath, [churn, '--upstream-movement', '--since', repo.head], {
          encoding: 'utf8',
          env: { ...process.env, T3CODE_ROOT: repo.dir },
        },
      );
      expect(result.status).toBe(OK);
      const report = JSON.parse(result.stdout);
      expect(report.mode).toBe('upstream-movement');
      expect(report.identity).toBe('upstream');
      expect(report.total).toBe(0);
      expect(report.signal).toBe('NO_UPSTREAM_MOVEMENT');
      expect(result.stderr).toContain('NO_UPSTREAM_MOVEMENT');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  /**
   * Review finding: the ref guard ran before `--since` was applied, so an
   * unresolvable `--since` slipped past it and surfaced as a raw git error —
   * exit 1 doing exit 3's job.
   */
  it('exits 3 when --since names a ref that does not resolve', () => {
    const repo = makeRepo('churn-badsince');
    try {
      gitIn(repo.dir, 'update-ref', 'refs/remotes/origin/main', repo.head);
      const result = spawnSync(
        process.execPath, [churn, '--upstream-movement', '--since', 'f'.repeat(40)], {
          encoding: 'utf8',
          env: { ...process.env, T3CODE_ROOT: repo.dir },
        },
      );
      expect(result.status).toBe(UNDETERMINED);
      expect(result.stderr).toContain('COULD_NOT_TELL');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  /**
   * Zero fork drift is a real answer and exits 0 — while the fork head equals
   * `upstreamBase` it is the only correct one. It is spelled `NO_FORK_DRIFT` so
   * it cannot be confused with the tool having failed to look.
   */
  it('reports zero fork drift as a named zero, exit 0', () => {
    const forkRoot = process.env.T3CODE_FORK_ROOT ?? DEFAULT_FORK_ROOT;
    if (!existsSync(forkRoot)) return; // covered by the absent-checkout case above
    const result = spawnSync(process.execPath, [churn, '--fork-drift'], { encoding: 'utf8' });
    expect(result.status).toBe(OK);
    const report = JSON.parse(result.stdout);
    expect(report.mode).toBe('fork-drift');
    expect(report.identity).toBe('fork');
    expect(report.root).toBe(forkRoot);
    if (report.total === 0) {
      expect(report.signal).toBe('NO_FORK_DRIFT');
    }
  });
});

// ---------------------------------------------------------------- verify, per identity

describe('spec 250: verify asserts each checkout against its own pin', () => {
  it('exits 0 with both checkouts clean on their pins', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-ok-'));
    const upstream = makeRepo('up-ok');
    const fork = makeRepo('fork-ok');
    try {
      // The fork is a clone of upstream, so its merge-base with the base IS the base.
      rmSync(fork.dir, { recursive: true, force: true });
      execFileSync('git', ['clone', '-q', upstream.dir, fork.dir]);
      const forkHead = gitIn(fork.dir, 'rev-parse', 'HEAD');

      const result = runVerify({
        pinFile: writePin(scratch, forkHead, upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: fork.dir,
      });
      expect(result.stderr).toContain('verified upstream');
      expect(result.stderr).toContain('verified fork');
      expect(result.status).toBe(OK);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
      rmSync(fork.dir, { recursive: true, force: true });
    }
  });

  it('exits 1 and names the UPSTREAM identity when the upstream clone moved', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-up-'));
    const upstream = makeRepo('up-moved');
    const fork = makeRepo('fork-still');
    try {
      const result = runVerify({
        // The pin names a sha the upstream repo does not have.
        pinFile: writePin(scratch, fork.head, 'c'.repeat(40)),
        upstreamRoot: upstream.dir,
        forkRoot: fork.dir,
      });
      expect(result.status).toBe(MISMATCH);
      expect(result.stderr).toContain('identity: upstream');
      expect(result.stderr).not.toContain('identity: fork');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
      rmSync(fork.dir, { recursive: true, force: true });
    }
  });

  it('exits 1 and names the FORK identity when the fork moved off the contract commit', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-fork-'));
    const upstream = makeRepo('up-2');
    const forkDir = join(scratch, 'fork');
    try {
      // Two real commits in the fork. The pin names the second; the checkout is
      // on the first, so HEAD does not descend from the contract commit.
      execFileSync('git', ['clone', '-q', upstream.dir, forkDir]);
      gitIn(forkDir, 'checkout', '-q', '-b', 'codev');
      writeFileSync(join(forkDir, 'ours.txt'), 'ours\n');
      gitIn(forkDir, 'add', 'ours.txt');
      gitIn(forkDir, 'commit', '-qm', 'contract commit');
      const contract = gitIn(forkDir, 'rev-parse', 'HEAD');
      gitIn(forkDir, 'checkout', '-q', '--detach', upstream.head);

      const result = runVerify({
        pinFile: writePin(scratch, contract, upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: forkDir,
      });
      expect(result.status).toBe(MISMATCH);
      expect(result.stderr).toContain('FORK_CHECKOUT_MISMATCH');
      expect(result.stderr).toContain('identity: fork');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  /**
   * A contract commit the fork repository does not even contain. Whether HEAD
   * descends from it is not a question git can answer, so it is `3`. Reporting
   * `1` here would say "the fork is on the wrong commit" when what happened is
   * that nobody could tell.
   */
  it('exits 3 when the contract commit does not exist in the fork at all', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-nocommit-'));
    const upstream = makeRepo('up-2b');
    const fork = makeRepo('fork-nocommit');
    try {
      const result = runVerify({
        pinFile: writePin(scratch, 'd'.repeat(40), upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: fork.dir,
      });
      expect(result.status).toBe(UNDETERMINED);
      expect(result.stderr).toContain('NO_FORK_ANCESTRY');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
      rmSync(fork.dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when a checkout is on its pin but dirty', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-dirty-'));
    const upstream = makeRepo('up-dirty');
    const fork = makeRepo('fork-clean');
    try {
      writeFileSync(join(upstream.dir, 'base.txt'), 'edited\n');
      const result = runVerify({
        pinFile: writePin(scratch, fork.head, upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: fork.dir,
      });
      expect(result.status).toBe(MISMATCH);
      expect(result.stderr).toContain('DIRTY_UPSTREAM_CHECKOUT');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
      rmSync(fork.dir, { recursive: true, force: true });
    }
  });

  /**
   * The finding this check exists for: a fork that is clean, at its pin, and
   * descended from nothing we can name. A rebase that dropped the base, a squash,
   * or a branch cut from somewhere else all produce it, and without the
   * merge-base assertion every one of them verifies green while every fork-drift
   * range computed from it is a diff between unrelated trees.
   */
  it('exits 1 when the fork no longer descends from upstreamBase', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-base-'));
    const upstream = makeRepo('up-base');
    const forkDir = join(scratch, 'fork');
    try {
      // Upstream: root -> base. The fork HAS the base commit (it was cloned) but
      // its branch was cut from the ROOT instead, which is what a rebase that
      // dropped the base leaves behind. merge-base resolves fine; it is simply
      // not `upstreamBase`.
      const root = upstream.head;
      writeFileSync(join(upstream.dir, 'base2.txt'), 'base2\n');
      gitIn(upstream.dir, 'add', 'base2.txt');
      gitIn(upstream.dir, 'commit', '-qm', 'the base');
      const base = gitIn(upstream.dir, 'rev-parse', 'HEAD');

      execFileSync('git', ['clone', '-q', upstream.dir, forkDir]);
      gitIn(forkDir, 'checkout', '-q', '-b', 'codev', root);
      writeFileSync(join(forkDir, 'ours.txt'), 'ours\n');
      gitIn(forkDir, 'add', 'ours.txt');
      gitIn(forkDir, 'commit', '-qm', 'our customization, off the base');
      const forkHead = gitIn(forkDir, 'rev-parse', 'HEAD');

      expect(gitIn(forkDir, 'merge-base', forkHead, base)).toBe(root);

      const result = runVerify({
        pinFile: writePin(scratch, forkHead, base),
        upstreamRoot: upstream.dir,
        forkRoot: forkDir,
      });
      expect(result.status).toBe(MISMATCH);
      expect(result.stderr).toContain('FORK_BASE_MISMATCH');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  /**
   * A fork with an unrelated history cannot answer the question at all, and that
   * is `3`. "I could not compute a merge-base" and "the merge-base is wrong" are
   * different facts; collapsing them would mean a corrupt or mis-pointed checkout
   * reads as a deliberate rebase.
   */
  it('exits 3, not 1, when no merge-base can be computed at all', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-nobase-'));
    const upstream = makeRepo('up-nobase');
    const fork = makeRepo('fork-unrelated'); // an independent history, not a clone
    try {
      const result = runVerify({
        pinFile: writePin(scratch, fork.head, upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: fork.dir,
      });
      expect(result.status).toBe(UNDETERMINED);
      expect(result.stderr).toContain('NO_FORK_MERGE_BASE');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
      rmSync(fork.dir, { recursive: true, force: true });
    }
  });

  it('exits 3, not 1, when the fork checkout is missing entirely', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-absent-'));
    const upstream = makeRepo('up-3');
    try {
      const result = runVerify({
        pinFile: writePin(scratch, 'e'.repeat(40), upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: join(scratch, 'not-there'),
      });
      expect(result.status).toBe(UNDETERMINED);
      expect(result.stderr).toContain('NO_FORK_CHECKOUT');
      expect(result.stderr).toContain('T3CODE_FORK_ROOT');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  it('exits 3 when the fork HEAD cannot be read', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-nohead-'));
    const upstream = makeRepo('up-4');
    const notARepo = join(scratch, 'not-a-repo');
    try {
      mkdirSync(notARepo, { recursive: true });
      const result = runVerify({
        pinFile: writePin(scratch, 'e'.repeat(40), upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: notARepo,
      });
      expect(result.status).toBe(UNDETERMINED);
      expect(result.stderr).toContain('NO_FORK_HEAD');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  /**
   * Review finding: the `git status` catch fell through to the empty string, so a
   * checkout whose status could not be read reported CLEAN. The comment said
   * "undetermined" and the code said "fine".
   *
   * Triggered for real by removing read permission on `.git/index`: `rev-parse
   * HEAD` needs only the ref, so it still resolves, and `git status` then exits
   * 128 with "index file open failed". The failure lands between the two checks,
   * which is exactly where the swallowed catch was.
   */
  it('exits 3 when `git status` itself fails, rather than reporting clean', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-nostatus-'));
    const upstream = makeRepo('up-nostatus');
    const index = join(upstream.dir, '.git', 'index');
    try {
      chmodSync(index, 0o000);
      // Running as root, or on a filesystem that ignores the mode, leaves the
      // trigger absent — asserting on it then would test nothing.
      const statusStillWorks = (() => {
        try {
          execFileSync('git', ['-C', upstream.dir, 'status', '--porcelain'], { encoding: 'utf8', stdio: 'pipe' });
          return true;
        } catch { return false; }
      })();
      expect(
        statusStillWorks,
        'could not make `git status` fail, so this run proves nothing about the swallowed catch',
      ).toBe(false);

      const result = runVerify({
        pinFile: writePin(scratch, 'e'.repeat(40), upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: join(scratch, 'absent'),
      });
      expect(result.status).toBe(UNDETERMINED);
      expect(result.stderr).toContain('NO_UPSTREAM_STATUS');
      expect(result.stderr).not.toContain('verified upstream');
    } finally {
      try { chmodSync(index, 0o644); } catch { /* already gone */ }
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  it('spells the three outcomes three different ways', () => {
    // 0, 1 and 3 are asserted individually above; this pins the contract that
    // they are three, not two with an alias.
    expect(new Set([OK, MISMATCH, UNDETERMINED]).size).toBe(3);
    expect(UNDETERMINED).not.toBe(MISMATCH);
  });
});

// ---------------------------------------------------------------- ahead vs wrong

/**
 * The architect's ruling: `pin.commit` means "the vendored contract was generated
 * from this commit", and only regeneration moves it. Phase 5 is where
 * regeneration happens, so through phases 2-4 the fork checkout is legitimately
 * ahead of the pin.
 *
 * That state is the truth and must not be silenced. It must also not be spelled
 * the same as a real error: a signal that fires for three phases straight is one
 * people learn to ignore, and then it fires for a real reason and nobody looks.
 */
describe('spec 250: ahead of the contract is not the same as on the wrong commit', () => {
  it('reads a pin with no contractSource as upstream-sourced', () => {
    expect(contractSource({ commit: 'a'.repeat(40) })).toBe('upstream');
    expect(contractSource({ contractSource: 'fork' })).toBe('fork');
    expect(contractSource({ contractSource: 'nonsense' })).toBe('upstream');
    expect(contractSource(undefined)).toBe('upstream');
  });

  it('carries contractSource on the fork identity', () => {
    expect(resolveIdentities({ ...pin, contractSource: 'fork' }, {}).fork.contractSource).toBe('fork');
    expect(resolveIdentities({ commit: 'a'.repeat(40) }, {}).fork.contractSource).toBe('upstream');
  });

  it('classifies the three fork-head states', () => {
    const at = classifyForkHead({ head: 'a', commit: 'a', descendant: true, contractSource: 'upstream' });
    expect(at).toEqual({ state: 'at-contract', ok: true, signal: null });

    const aheadBefore = classifyForkHead({ head: 'b', commit: 'a', descendant: true, contractSource: 'upstream' });
    expect(aheadBefore.state).toBe('ahead');
    expect(aheadBefore.ok).toBe(true);
    expect(aheadBefore.signal).toBe('FORK_AHEAD_OF_CONTRACT');

    const aheadAfter = classifyForkHead({ head: 'b', commit: 'a', descendant: true, contractSource: 'fork' });
    expect(aheadAfter.state).toBe('ahead');
    expect(aheadAfter.ok, 'once the contract is fork-sourced, ahead is an error').toBe(false);

    const wrong = classifyForkHead({ head: 'b', commit: 'a', descendant: false, contractSource: 'upstream' });
    expect(wrong.state).toBe('wrong-commit');
    expect(wrong.ok).toBe(false);
    expect(wrong.signal).toBe('FORK_CHECKOUT_MISMATCH');
  });

  it('the shipped pin says the contract is still upstream-sourced', () => {
    // Phase 5 flips this. Until it does, phases 2-4 can commit to the fork
    // without every `verify` reporting a mismatch.
    expect(pin.contractSource).toBe('upstream');
  });

  /** Builds a fork whose HEAD is a real descendant of the contract commit. */
  function forkAheadFixture(label: string) {
    const scratch = mkdtempSync(join(tmpdir(), `t3-${label}-`));
    const upstream = makeRepo(`up-${label}`);
    const forkDir = join(scratch, 'fork');
    execFileSync('git', ['clone', '-q', upstream.dir, forkDir]);
    gitIn(forkDir, 'checkout', '-q', '-b', 'codev');
    writeFileSync(join(forkDir, 'ours.txt'), `ours ${label}\n`);
    gitIn(forkDir, 'add', 'ours.txt');
    gitIn(forkDir, 'commit', '-qm', 'a phase 2 customization');
    return { scratch, upstream, forkDir, forkHead: gitIn(forkDir, 'rev-parse', 'HEAD') };
  }

  it('exits 0 with FORK_AHEAD_OF_CONTRACT while the contract is upstream-sourced', () => {
    const f = forkAheadFixture('ahead-ok');
    try {
      const pinFile = join(f.scratch, 'pin.json');
      writeFileSync(pinFile, JSON.stringify({
        ...pin, commit: f.upstream.head, upstreamBase: f.upstream.head, contractSource: 'upstream',
      }, null, 2));
      const result = runVerify({ pinFile, upstreamRoot: f.upstream.dir, forkRoot: f.forkDir });
      expect(result.stderr).toContain('FORK_AHEAD_OF_CONTRACT');
      expect(result.stderr).not.toContain('FORK_CHECKOUT_MISMATCH');
      expect(result.status).toBe(OK);
    } finally {
      rmSync(f.scratch, { recursive: true, force: true });
      rmSync(f.upstream.dir, { recursive: true, force: true });
    }
  });

  it('exits 1 with FORK_AHEAD_OF_CONTRACT once the contract is fork-sourced', () => {
    const f = forkAheadFixture('ahead-err');
    try {
      const pinFile = join(f.scratch, 'pin.json');
      writeFileSync(pinFile, JSON.stringify({
        ...pin, commit: f.upstream.head, upstreamBase: f.upstream.head, contractSource: 'fork',
      }, null, 2));
      const result = runVerify({ pinFile, upstreamRoot: f.upstream.dir, forkRoot: f.forkDir });
      expect(result.stderr).toContain('FORK_AHEAD_OF_CONTRACT');
      expect(result.status).toBe(MISMATCH);
    } finally {
      rmSync(f.scratch, { recursive: true, force: true });
      rmSync(f.upstream.dir, { recursive: true, force: true });
    }
  });

  it('still exits 1 with FORK_CHECKOUT_MISMATCH for a head that does not descend', () => {
    const f = forkAheadFixture('not-descendant');
    try {
      const pinFile = join(f.scratch, 'pin.json');
      // The contract commit is the fork head itself; the checkout is moved BACK
      // to the base, so it does not descend from the pin.
      gitIn(f.forkDir, 'checkout', '-q', '--detach', f.upstream.head);
      writeFileSync(pinFile, JSON.stringify({
        ...pin, commit: f.forkHead, upstreamBase: f.upstream.head, contractSource: 'upstream',
      }, null, 2));
      const result = runVerify({ pinFile, upstreamRoot: f.upstream.dir, forkRoot: f.forkDir });
      expect(result.stderr).toContain('FORK_CHECKOUT_MISMATCH');
      expect(result.stderr).not.toContain('FORK_AHEAD_OF_CONTRACT');
      expect(result.status).toBe(MISMATCH);
    } finally {
      rmSync(f.scratch, { recursive: true, force: true });
      rmSync(f.upstream.dir, { recursive: true, force: true });
    }
  });

  it('status reports the fork state and which way the contract is sourced', () => {
    const f = forkAheadFixture('status-ahead');
    try {
      const pinFile = join(f.scratch, 'pin.json');
      writeFileSync(pinFile, JSON.stringify({
        ...pin, commit: f.upstream.head, upstreamBase: f.upstream.head, contractSource: 'upstream',
      }, null, 2));
      const result = spawnSync(process.execPath, [harness, 'status'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          T3_PIN_FILE: pinFile, T3CODE_ROOT: f.upstream.dir, T3CODE_FORK_ROOT: f.forkDir,
        },
      });
      const report = JSON.parse(result.stdout);
      expect(report.fork.state).toBe('ahead');
      expect(report.fork.ok).toBe(true);
      expect(report.fork.signal).toBe('FORK_AHEAD_OF_CONTRACT');
      expect(report.fork.contractSource).toBe('upstream');
      expect(report.fork.matchesPin).toBe(false);
    } finally {
      rmSync(f.scratch, { recursive: true, force: true });
      rmSync(f.upstream.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- the destructive one

describe('spec 250: nothing writes a fork sha into the upstream clone', () => {
  /**
   * `acquire()` is the only verb in the harness that writes, it runs against the
   * upstream clone, and `smoke.mjs` and `live/integration.mjs` both call it. If it
   * checked out `pin.commit` it would move the read-only clone onto a fork sha
   * from an ordinary test run — no deliberate invocation required.
   *
   * Measured by running it against a throwaway upstream whose HEAD is deliberately
   * off `upstreamBase`, with a pin whose `commit` is a DIFFERENT sha, and asserting
   * which of the two it moved to.
   */
  it('acquire checks out upstreamBase, never the fork head', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-acquire-'));
    const upstream = makeRepo('up-acquire');
    try {
      const base = upstream.head;
      writeFileSync(join(upstream.dir, 'later.txt'), 'later\n');
      gitIn(upstream.dir, 'add', 'later.txt');
      gitIn(upstream.dir, 'commit', '-qm', 'later');
      const later = gitIn(upstream.dir, 'rev-parse', 'HEAD');
      expect(later).not.toBe(base);

      // `commit` is the LATER sha, standing in for a diverged fork head.
      // `upstreamBase` is the earlier one. A correct acquire lands on the base.
      const result = spawnSync(process.execPath, [harness, 'acquire'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          T3_PIN_FILE: writePin(scratch, later, base),
          T3CODE_ROOT: upstream.dir,
          T3CODE_FORK_ROOT: upstream.dir,
        },
      });

      expect(gitIn(upstream.dir, 'rev-parse', 'HEAD')).toBe(base);
      expect(result.status).toBe(OK);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  it('status reports the upstream checkout against upstreamBase and the fork separately', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-status-'));
    const upstream = makeRepo('up-status');
    const fork = makeRepo('fork-status');
    try {
      const result = spawnSync(process.execPath, [harness, 'status'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          T3_PIN_FILE: writePin(scratch, fork.head, upstream.head),
          T3CODE_ROOT: upstream.dir,
          T3CODE_FORK_ROOT: fork.dir,
        },
      });
      const report = JSON.parse(result.stdout);
      expect(report.pin).toBe(upstream.head);
      expect(report.checkout).toBe(upstream.head);
      expect(report.matchesPin).toBe(true);
      expect(report.fork.head).toBe(fork.head);
      expect(report.fork.matchesPin).toBe(true);
      expect(report.forkPin).toBe(fork.head);
      expect(result.status).toBe(OK);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
      rmSync(fork.dir, { recursive: true, force: true });
    }
  });

  it('status reports an absent fork as unavailable, not as a mismatch', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-status-nofork-'));
    const upstream = makeRepo('up-status-2');
    try {
      const result = spawnSync(process.execPath, [harness, 'status'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          T3_PIN_FILE: writePin(scratch, 'e'.repeat(40), upstream.head),
          T3CODE_ROOT: upstream.dir,
          T3CODE_FORK_ROOT: join(scratch, 'gone'),
        },
      });
      const report = JSON.parse(result.stdout);
      expect(report.fork.available).toBe(false);
      expect(report.fork.matchesPin).toBe('unknown');
      // The upstream half is still a real answer, so the exit code is upstream's.
      expect(result.status).toBe(OK);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- the root readers

describe('spec 250: every T3CODE_ROOT reader is assigned to an identity', () => {
  /**
   * The plan's table, asserted rather than described. A reader that resolves its
   * root by re-deriving `process.env.T3CODE_ROOT ?? '<a literal path>'` has an
   * identity by accident; one that goes through `identities.mjs` has one on
   * purpose. This test is the grep the plan asked for, run every time.
   */
  const readers = [
    { file: 'tools/t3-server/t3-server.mjs', identity: 'both' },
    { file: 'tools/t3-codegen/generate.mjs', identity: 'fork' },
    { file: 'tools/t3-codegen/classify-churn.mjs', identity: 'both' },
    { file: 'tools/t3-codegen/transform-blindness-probe.mjs', identity: 'fork' },
    { file: 'tools/t3-server/smoke.mjs', identity: 'upstream' },
  ];

  it.each(readers)('$file resolves its root through identities.mjs', ({ file }) => {
    const src = readFileSync(join(repoRoot, file), 'utf8');
    expect(src, `${file} must import the shared identity resolver`)
      .toMatch(/from '\.\.\/t3-fork\/identities\.mjs'/);
  });

  it.each(readers)('$file no longer hardcodes a bare T3CODE_ROOT fallback path', ({ file }) => {
    const src = readFileSync(join(repoRoot, file), 'utf8');
    expect(src, `${file} still re-derives its root from a literal path`)
      .not.toMatch(/process\.env\.T3CODE_ROOT\s*\?\?\s*'/);
  });

  /**
   * `live/integration.mjs` is the sixth reader and it deliberately does NOT use a
   * default: #214 made the variable required so a missing input reads as a
   * sentence rather than as a failure inside the server. Spec 250 keeps that,
   * because a required variable also means the fork's path cannot arrive here by
   * accident.
   */
  it('live/integration.mjs keeps T3CODE_ROOT required and never falls back to the fork', () => {
    const src = readFileSync(join(repoRoot, 'packages', 't3-client', 'live', 'integration.mjs'), 'utf8');
    expect(src).toContain('const T3CODE_ROOT = process.env.T3CODE_ROOT;');
    // It may NAME the fork variable in the comment explaining why it is upstream;
    // it must never READ it.
    expect(src).not.toMatch(/process\.env\.T3CODE_FORK_ROOT/);
  });

  it('the spec 146 contract suite gates the two live suites on two different roots', () => {
    const src = readFileSync(join(here, 'spec-146-t3-contract.test.ts'), 'utf8');
    expect(src).toContain("process.env.T3CODE_FORK_ROOT ?? ''");
    expect(src).toContain('HAS_FORK_CHECKOUT');
    expect(src).toContain('HAS_CHECKOUT');
  });

  /**
   * The fork hash suite compares generated artifacts against the fork checkout,
   * which is only a valid comparison while the checkout sits ON `pin.commit`.
   * Through phases 2-4 it does not, so the suite skips — and a skip that nobody
   * can see the end of is how a suite quietly stops existing.
   *
   * This pins two things: the gate is the contract commit and not merely the
   * checkout's presence, and the skip carries a reason naming which case it is.
   */
  it('gates the fork hash suite on the contract commit, and says why it skipped', () => {
    const src = readFileSync(join(here, 'spec-146-t3-contract.test.ts'), 'utf8');
    expect(src, 'presence is not the same question as being on the contract commit')
      .toContain('FORK_AT_CONTRACT');
    expect(src).toMatch(/describe\.skipIf\(!FORK_AT_CONTRACT\)/);
    expect(src).toContain('forkSkipReason');
    // Three distinguishable reasons, not one blank skip.
    expect(src).toContain('no fork checkout at');
    expect(src).toContain('could not read HEAD of');
    expect(src).toContain('ahead of contract commit');
  });

  /**
   * The other end of the same rule: once phase 5 sets `contractSource` to
   * `"fork"`, `pin.commit` IS the fork head, so this gate opens again on its own.
   * If it ever stops doing that, the suite is dead and this test says so.
   */
  it('the gate reopens by itself once pin.commit names the fork head', () => {
    const atContract = classifyForkHead({
      head: pin.commit, commit: pin.commit, descendant: true, contractSource: 'fork',
    });
    expect(atContract.state).toBe('at-contract');
    expect(atContract.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- source-hash

describe('spec 250: source-hash records both ends of the comparison', () => {
  const hashes = readJson(join(repoRoot, 'packages', 'types', 'src', 't3', 'generated', 'source-hash.json'));

  it('keeps the fork hashes under `files`, at pin.commit', () => {
    expect(hashes.commit).toBe(pin.commit);
    expect(Object.keys(hashes.files).sort()).toEqual([...pin.closure].sort());
  });

  it('records the upstream closure at upstreamBase as its own section', () => {
    expect(hashes.upstream, 'generation must record what upstream looked like at the base').toBeDefined();
    expect(hashes.upstream.commit).toBe(pin.upstreamBase);
  });

  it('spells an unmeasured upstream section differently from a matching one', () => {
    if (hashes.upstream.available) {
      expect(Object.keys(hashes.upstream.files).sort()).toEqual([...pin.closure].sort());
      for (const [file, digest] of Object.entries<string>(hashes.upstream.files)) {
        expect(digest, `${file} upstream hash`).toMatch(/^[0-9a-f]{64}$/);
      }
    } else {
      // Not a pass wearing a failure's clothes: an absent measurement carries a
      // reason and no file hashes at all.
      expect(hashes.upstream.files).toEqual({});
      expect(hashes.upstream.reason, 'an unavailable measurement must say why').toBeTruthy();
    }
  });

  it('reports fork drift as a measured subtraction, not an assumption', () => {
    expect(hashes.forkDrift).toBeDefined();
    if (hashes.upstream.available) {
      expect(hashes.forkDrift.measured).toBe(true);
      expect(Array.isArray(hashes.forkDrift.changedFiles)).toBe(true);
      // While the fork head equals upstreamBase the answer is known: zero.
      if (pin.commit === pin.upstreamBase) {
        expect(hashes.forkDrift.changedFiles).toEqual([]);
      }
    } else {
      expect(hashes.forkDrift.measured).toBe(false);
      expect(hashes.forkDrift.reason).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- per-identity verbs

describe('spec 250: an upstream-only caller does not depend on the fork', () => {
  /**
   * Review finding: `start` was upstream-only but `ready` re-imposed the fork
   * requirement one call later, so the exemption bought nothing. `smoke.mjs` and
   * `live/integration.mjs` ran the both-identity `verify` for the same reason.
   *
   * A fork move is not `CHECKOUT_MOVED_DURING_RUN`, and it says nothing about the
   * upstream process answering on the port.
   */
  it('verify-upstream passes with no fork checkout at all', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-up-only-'));
    const upstream = makeRepo('up-only');
    try {
      const result = spawnSync(process.execPath, [harness, 'verify-upstream'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          T3_PIN_FILE: writePin(scratch, 'e'.repeat(40), upstream.head),
          T3CODE_ROOT: upstream.dir,
          T3CODE_FORK_ROOT: join(scratch, 'absent'),
        },
      });
      expect(result.stderr).toContain('verified upstream');
      expect(result.stderr).not.toContain('verified fork');
      expect(result.status).toBe(OK);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  it('verify-fork checks only the fork', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-fork-only-'));
    const upstream = makeRepo('up-ignored');
    const forkDir = join(scratch, 'fork');
    try {
      execFileSync('git', ['clone', '-q', upstream.dir, forkDir]);
      const forkHead = gitIn(forkDir, 'rev-parse', 'HEAD');
      const result = spawnSync(process.execPath, [harness, 'verify-fork'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          // The upstream root points at nothing; verify-fork must not care.
          T3_PIN_FILE: writePin(scratch, forkHead, upstream.head),
          T3CODE_ROOT: join(scratch, 'no-upstream-here'),
          T3CODE_FORK_ROOT: forkDir,
        },
      });
      expect(result.stderr).toContain('verified fork');
      expect(result.stderr).not.toContain('verified upstream');
      expect(result.status).toBe(OK);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });

  it('ready, smoke and the live integration script all use the upstream-only verb', () => {
    const server = readFileSync(join(repoRoot, 'tools', 't3-server', 't3-server.mjs'), 'utf8');
    expect(server).toMatch(/verifyUpstream\('CHECKOUT_MOVED_DURING_RUN'\)/);

    const smoke = readFileSync(join(repoRoot, 'tools', 't3-server', 'smoke.mjs'), 'utf8');
    expect(smoke).toContain("harness('verify-upstream')");
    expect(smoke).not.toMatch(/harness\('verify'\)/);

    const live = readFileSync(join(repoRoot, 'packages', 't3-client', 'live', 'integration.mjs'), 'utf8');
    expect(live).toContain("run('verify-upstream')");
    expect(live).not.toMatch(/run\('verify'\)/);
  });

  it('bare verify still asserts both, which is the phase acceptance criterion', () => {
    const scratch = mkdtempSync(join(tmpdir(), 't3-verify-both-'));
    const upstream = makeRepo('up-both');
    try {
      const result = runVerify({
        pinFile: writePin(scratch, 'e'.repeat(40), upstream.head),
        upstreamRoot: upstream.dir,
        forkRoot: join(scratch, 'absent'),
      });
      // Upstream passes; the missing fork is what stops it, and it stops it at 3.
      expect(result.stderr).toContain('verified upstream');
      expect(result.status).toBe(UNDETERMINED);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(upstream.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- criterion 8b

/**
 * Spec 250 criterion 8b, exercised rather than argued.
 *
 * Two review lanes refused an in-process simulation on an in-memory database as
 * evidence for "the server is killed partway through applying the columns and the
 * resulting database still opens against the PRE-FORK server binary" — correctly:
 * no kill, no file, no pre-fork binary is not that criterion, it is a different
 * and easier one wearing its name.
 *
 * `tools/t3-fork/criterion-8b.mjs` runs the real sequence against the pinned
 * t3@0.0.36 server and records what happened. The assertions here are on that
 * recording, and they refuse evidence older than the code it describes — the same
 * shape spec 146 uses for its cold-start evidence, and for the same reason.
 */
describe('spec 250: criterion 8b, the kill test', () => {
  const evidencePath = join(repoRoot, 'codev', 'research', '250-criterion-8b-evidence.json');
  const evidence = readJson(evidencePath);

  it('ran against the pinned pre-fork server, not a stand-in', () => {
    expect(evidence.preForkCliVersion).toBe(pin.cliVersion);
    expect(evidence.upstreamBase).toBe(pin.upstreamBase);
  });

  it('names WHICH fork commit the guard under test came from', () => {
    // A path is not a version: `forkRoot` alone would describe whatever that
    // checkout happened to hold at the time, so the evidence could not say which
    // guard passed.
    expect(evidence.forkCommit, 'the evidence must record the fork commit, not just its path')
      .toMatch(/^[0-9a-f]{40}$/);
  });

  /**
   * The fork half of the staleness guard.
   *
   * The mtime check below covers this repo's scripts. It cannot see the fork,
   * where the guard itself lives — and the evidence went stale exactly that way
   * once already: a fork commit changed the guard, and the recorded run still
   * named the commit before it. Skipped rather than failed when the fork checkout
   * is absent, because "I could not look" is not "it matches".
   */
  it('describes the fork commit that is actually checked out', () => {
    const forkRoot = process.env.T3CODE_FORK_ROOT ?? DEFAULT_FORK_ROOT;
    if (!existsSync(forkRoot)) return;
    const head = spawnSync('git', ['-C', forkRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0) return;

    expect(
      evidence.forkCommit,
      'the criterion 8b evidence names a different fork commit than the one checked out — ' +
        'regenerate it with\n' +
        '  export T3_NODE=/absolute/path/to/node T3_HARNESS_PORT=<free port>\n' +
        '  node tools/t3-fork/criterion-8b.mjs > codev/research/250-criterion-8b-evidence.json\n' +
        'rather than trusting a result recorded against an older guard.',
    ).toBe(head.stdout.trim());
  });

  it('started from a database the pre-fork server itself created and migrated', () => {
    expect(evidence.steps.preForkServerCreatedDatabase).toBe(true);
    expect(
      evidence.steps.columnsBeforeGuard,
      'if the database already had Codev columns the run proves nothing',
    ).toEqual([]);
  });

  it('killed a real process and really left the schema half applied', () => {
    // SIGKILL specifically: no handler, no cleanup, no chance to finish. A clean
    // exit would make the half-applied state something the script chose.
    expect(evidence.steps.childKilledBySignal).toBe('SIGKILL');
    expect(evidence.steps.halfApplied).toBe(true);
    expect(evidence.steps.columnsAfterKill).toHaveLength(1);
  });

  it('THE CRITERION: the pre-fork binary opens the half-applied database', () => {
    expect(evidence.steps.preForkServerOpensHalfApplied).toBe(true);
  });

  it('the guard then adds the missing column and only that one', () => {
    expect(evidence.steps.guardResume.added).toEqual(['codev_parent_thread_id']);
    expect(evidence.steps.guardResume.present).toEqual(['codev_role']);
    expect(evidence.steps.guardAddedOnlyTheMissingColumn).toBe(true);
    expect(evidence.steps.columnsAfterResume).toHaveLength(2);
  });

  it('and the pre-fork binary still opens it once fully applied', () => {
    expect(evidence.steps.preForkServerOpensFullyApplied).toBe(true);
    expect(evidence.passed).toBe(true);
  });

  /**
   * Recorded evidence outlives the code it describes. Nothing stops the guard or
   * the driver changing while this stays green, so this refuses evidence older
   * than either.
   */
  it('is not older than the code it is evidence for', () => {
    const evidenceAge = statSync(evidencePath).mtimeMs;
    const sources = [
      join(repoRoot, 'tools', 't3-fork', 'criterion-8b.mjs'),
      join(repoRoot, 'tools', 't3-fork', 'crash-apply-child.mjs'),
      join(repoRoot, 'tools', 't3-server', 't3-server.mjs'),
    ];
    // The fork-side script the evidence depends on lives outside this repo, so it
    // cannot be stat'd here. `forkCommit` above is what pins that half.
    for (const source of sources) {
      expect(
        evidenceAge,
        `${source} changed after the criterion 8b evidence was recorded — regenerate it with\n` +
          `  export T3_NODE=/absolute/path/to/node T3_HARNESS_PORT=<free port>\n` +
          `  node tools/t3-fork/criterion-8b.mjs > codev/research/250-criterion-8b-evidence.json\n` +
          `rather than trusting a stale result. The redirection is part of the command.`,
      ).toBeGreaterThanOrEqual(statSync(source).mtimeMs - 1000);
    }
  });
});

// ---------------------------------------------------------------- documentation

describe('spec 250: the two-identity procedure is written down', () => {
  it('FORK.md records the remote, branch, checkout path and phase log', () => {
    const doc = readFileSync(join(repoRoot, 'tools', 't3-fork', 'FORK.md'), 'utf8');
    expect(doc).toContain('pseudoseed/t3code');
    expect(doc).toContain(DEFAULT_FORK_ROOT);
    expect(doc).toContain('codev');
    expect(doc).toContain(pin.upstreamBase);
    // The prohibition is the reason the repository exists in the shape it does.
    expect(doc).toMatch(/gh repo create pseudoseed\/t3code --private/);
    expect(doc).toContain('gh repo fork');
  });

  it('REFRESH.md documents both churn modes and both roots', () => {
    const doc = readFileSync(join(repoRoot, 'tools', 't3-codegen', 'REFRESH.md'), 'utf8');
    expect(doc).toContain('--upstream-movement');
    expect(doc).toContain('--fork-drift');
    expect(doc).toContain('T3CODE_FORK_ROOT');
    expect(doc).toContain('NO_UPSTREAM_MOVEMENT');
  });
});
