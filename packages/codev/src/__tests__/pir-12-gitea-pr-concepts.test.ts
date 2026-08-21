/**
 * Issue #12 — Forgejo/Gitea forge parity: pr-search, pr-diff, and the
 * pr-exists "hang".
 *
 * Three things are pinned here, and the first is the one that matters most.
 *
 * 1. **pr-exists must never enumerate pulls.** The old implementation walked
 *    `pulls?state=all` page by page. Forgejo charges that endpoint per RETURNED
 *    PR OBJECT — measured 0.78s at limit=1 and 32.8s at limit=50 against
 *    Forgejo 15.x — so on a 1599-PR repository a single yes/no question cost
 *    ~17 minutes and read as a hang. The regression is easy to reintroduce
 *    while keeping a behavioural test green, because a scan returns the right
 *    answer; it just takes a quarter of an hour. So the endpoints are asserted
 *    directly.
 *
 * 2. **A merged PR whose branch was deleted is still findable.** Gitea rewrites
 *    `.head.ref` to "refs/pull/N/head" once the source branch is gone, which is
 *    the normal state of every merged PR here, but `.head.label` keeps the
 *    branch name. That is undocumented Gitea behaviour and exactly the kind of
 *    thing a Forgejo upgrade breaks silently.
 *
 * 3. **The `is:` qualifier grammar, and afx spawn's explicit `is:open`.** Making
 *    pr-search all-states (upstream cluesmith/codev#1331, fixing #759) is
 *    correct and breaks spawn-worktree.ts, which leaned on the old open-only
 *    default. See the query table in gitea/pr-search.sh.
 *
 * The script-content assertions are anchored to command lines rather than
 * matched with `toContain`, so the explanatory comments in the scripts — which
 * quote the very strings under test — cannot make an assertion pass after the
 * code it pins has been removed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getForgeCommand, resolveAllConcepts } from '../lib/forge.js';

const codevPkgRoot = path.resolve(import.meta.dirname, '..', '..');
const forgeScripts = path.join(codevPkgRoot, 'scripts', 'forge');
const gitea = path.join(forgeScripts, 'gitea');

function hasJq(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** An open PR, branch intact. */
const OPEN_PR = JSON.stringify({
  number: 3855,
  title: 'open one',
  state: 'open',
  merged: false,
  html_url: 'https://forge.example.com/o/r/pulls/3855',
  url: 'https://forge.example.com/api/v1/repos/o/r/pulls/3855',
  head: { ref: 'builder/air-364', label: 'builder/air-364' },
  base: { ref: 'main' },
});

/**
 * A MERGED PR whose source branch has been deleted — `.head.ref` has been
 * rewritten and only `.head.label` still carries the branch name. Copied from
 * the real shape of PR 3869 on the reference Forgejo.
 */
const MERGED_PR_DELETED_BRANCH = JSON.stringify({
  number: 3869,
  title: 'merged one',
  state: 'closed',
  merged: true,
  html_url: 'https://forge.example.com/o/r/pulls/3869',
  head: { ref: 'refs/pull/3869/head', label: 'builder/aspir-3860' },
  base: { ref: 'main' },
});

/** A PR closed without merging — must never count as "exists". */
const CLOSED_PR = JSON.stringify({
  number: 3800,
  title: 'abandoned',
  state: 'closed',
  merged: false,
  html_url: 'https://forge.example.com/o/r/pulls/3800',
  head: { ref: 'builder/abandoned', label: 'builder/abandoned' },
  base: { ref: 'main' },
});

/** Gitea's 404 body. Identical for an unknown repo and an unknown target. */
const NOT_FOUND = '{"message":"The target couldn\'t be found.","url":"https://forge.example.com/api/swagger","errors":[]}';

/**
 * A fake `tea` serving the slice of `tea api` these scripts use.
 *
 * Logs every requested endpoint to `endpoints`, one per line, so a test can
 * assert both what was called and — the point of this whole exercise — what
 * was not.
 *
 * TEA_ROUTES is a `<glob>\t<body-file>` table; the first match wins and its
 * file is emitted verbatim. The body lives in a FILE rather than in the table
 * cell because a raw diff contains newlines, which a line-oriented table
 * silently truncates to its first line.
 */
const TEA_STUB = [
  'if [ "$1" != "api" ]; then echo "unexpected tea invocation: $*" >&2; exit 9; fi',
  'for a in "$@"; do ep=$a; done',
  'printf "%s\\n" "$ep" >> "$TEA_LOG"',
  'while IFS="\t" read -r pattern bodyfile; do',
  '  [ -n "$pattern" ] || continue',
  '  # shellcheck disable=SC2254  # the pattern is meant to glob',
  '  case "$ep" in',
  '    $pattern) cat "$bodyfile"; exit 0 ;;',
  '  esac',
  'done < "$TEA_ROUTES"',
  // Gitea's 404 body carries an apostrophe, so it is read from a file rather
  // than quoted into the stub — inlining it broke the stub's own shell syntax.
  'cat "$TEA_NOT_FOUND"',
  'exit 0',
].join('\n');

describe('#12 — the gitea preset offers pr-search and pr-diff', () => {
  it.each(['pr-search', 'pr-diff', 'pr-exists', 'recently-merged'])(
    'routes %s to the gitea script instead of disabling it',
    (concept) => {
      const command = getForgeCommand(concept, { provider: 'gitea' });
      expect(command, `gitea has no ${concept} route`).not.toBeNull();
      expect(command).toBe(path.join(gitea, `${concept}.sh`));
      expect(fs.existsSync(command!)).toBe(true);
      expect(fs.statSync(command!).mode & 0o111, 'script is not executable').not.toBe(0);
    },
  );

  it.each(['team-activity', 'on-it-timestamps'])(
    'keeps %s disabled — Forgejo has no GraphQL, and this is deliberate',
    (concept) => {
      expect(getForgeCommand(concept, { provider: 'gitea' })).toBeNull();
      const resolution = resolveAllConcepts({ provider: 'gitea' }).find((r) => r.concept === concept);
      expect(resolution?.source).toBe('disabled');
    },
  );

  it('doctor resolves EVERY enabled gitea concept to tea', () => {
    // Not just the new ones. `extractExecutable` reads a script's first
    // substantive line, which answered "echo" for issue-view and "case" for
    // pr-list — so `codev doctor` on a Forgejo repo told the user to install
    // `echo`, and a genuinely missing `tea` went unreported. That is the #1455
    // defect class, and the remedy is the `# forge-executable:` declaration.
    // Asserted across the whole preset so a new script cannot reintroduce it.
    const wrong = resolveAllConcepts({ provider: 'gitea' })
      .filter((r) => r.source !== 'disabled' && r.executable !== 'tea')
      .map((r) => `${r.concept} -> ${r.executable}`);
    expect(wrong).toEqual([]);
  });
});

describe('#12 — gitea concept scripts against a fake tea', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pir-12-gitea-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Install the fake tea with the given endpoint routes. */
  function routes(pairs: Array<[string, string]>): void {
    const lines = pairs.map(([pattern, body], i) => {
      const bodyFile = path.join(tmp, `body-${i}`);
      fs.writeFileSync(bodyFile, body);
      return `${pattern}\t${bodyFile}`;
    });
    fs.writeFileSync(path.join(tmp, 'routes.tsv'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(tmp, 'notfound.json'), NOT_FOUND);
    const file = path.join(tmp, 'tea');
    fs.writeFileSync(file, `#!/bin/sh\n${TEA_STUB}\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }

  /** The repo probe every script makes; also what proves the repo resolves. */
  const REPO_ROUTE: [string, string] = ['repos/o/r', '{"default_branch":"main"}'];

  // spawnSync, not execFileSync: several of these assertions are about what the
  // script says on stderr while SUCCEEDING (the default-window announcement,
  // the truncation notes). execFileSync only surfaces stderr by throwing.
  function run(script: string, env: Record<string, string> = {}): { stdout: string; status: number; stderr: string } {
    const r = spawnSync('sh', [path.join(gitea, script)], {
      cwd: tmp,
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH}`,
        CODEV_REPO: 'o/r',
        TEA_LOG: path.join(tmp, 'endpoints'),
        TEA_ROUTES: path.join(tmp, 'routes.tsv'),
        TEA_NOT_FOUND: path.join(tmp, 'notfound.json'),
        ...env,
      },
      encoding: 'utf-8',
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  /** Every endpoint the script asked tea for, in order. */
  function endpoints(): string[] {
    const file = path.join(tmp, 'endpoints');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // pr-exists
  // -------------------------------------------------------------------------

  describe('pr-exists', () => {
    it.skipIf(!hasJq())('answers true for an open PR via the base/head lookup', () => {
      routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/air-364', OPEN_PR]]);
      const { stdout, status } = run('pr-exists.sh', { CODEV_BRANCH_NAME: 'builder/air-364' });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('true');
    });

    it.skipIf(!hasJq())(
      'finds a MERGED PR whose branch was deleted — head.label, not head.ref',
      () => {
        // The whole point. `.head.ref` on this PR is "refs/pull/3869/head", so
        // any implementation matching on head.ref answers false. The base/head
        // endpoint matches on the stored head branch, which Gitea also exposes
        // as `.head.label`. If a Forgejo release ever stops honouring that,
        // this test is where it shows up rather than in a builder's confused
        // "no PR found" three months later.
        routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/aspir-3860', MERGED_PR_DELETED_BRANCH]]);
        const { stdout, status } = run('pr-exists.sh', { CODEV_BRANCH_NAME: 'builder/aspir-3860' });
        expect(status).toBe(0);
        expect(stdout.trim()).toBe('true');
      },
    );

    it.skipIf(!hasJq())('NEVER issues a list call — no state=all, no pulls enumeration', () => {
      // The 17-minute regression. A scan would still return the right answer,
      // so only the request log can catch its return.
      routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/air-364', OPEN_PR]]);
      run('pr-exists.sh', { CODEV_BRANCH_NAME: 'builder/air-364' });

      const asked = endpoints();
      expect(asked).toEqual(['repos/o/r', 'repos/o/r/pulls/main/builder/air-364']);
      for (const ep of asked) {
        expect(ep).not.toMatch(/state=all/);
        expect(ep, 'pr-exists must not page a list endpoint').not.toMatch(/[?&]page=/);
        expect(ep).not.toMatch(/[?&]limit=/);
      }
    });

    it.skipIf(!hasJq())('answers false for a closed-not-merged PR', () => {
      routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/abandoned', CLOSED_PR]]);
      const { stdout } = run('pr-exists.sh', { CODEV_BRANCH_NAME: 'builder/abandoned' });
      expect(stdout.trim()).toBe('false');
    });

    it.skipIf(!hasJq())('answers false when no PR exists for the branch', () => {
      routes([REPO_ROUTE]);
      const { stdout, status } = run('pr-exists.sh', { CODEV_BRANCH_NAME: 'never-opened' });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('false');
    });

    it.skipIf(!hasJq())('ERRORS rather than answering false when the repo cannot be read', () => {
      // Gitea returns a byte-identical 404 for "no such repo" and "no such PR".
      // Reading the first as "no PR exists" is a silent wrong answer at a gate,
      // so the repo probe has to come first and its failure has to be fatal.
      routes([]);
      const { stdout, status, stderr } = run('pr-exists.sh', { CODEV_BRANCH_NAME: 'anything' });
      expect(status).not.toBe(0);
      expect(stdout.trim()).not.toBe('false');
      expect(stderr).toMatch(/could not read repository/);
    });

    it.skipIf(!hasJq())('honours CODEV_PR_BASE for a PR against a non-default base', () => {
      routes([REPO_ROUTE, ['repos/o/r/pulls/integration/feature-x', OPEN_PR]]);
      const { stdout } = run('pr-exists.sh', {
        CODEV_BRANCH_NAME: 'feature-x',
        CODEV_PR_BASE: 'integration',
      });
      expect(stdout.trim()).toBe('true');
      expect(endpoints()).toContain('repos/o/r/pulls/integration/feature-x');
    });

    it('requires CODEV_BRANCH_NAME', () => {
      routes([REPO_ROUTE]);
      const { status, stderr } = run('pr-exists.sh', { CODEV_BRANCH_NAME: '' });
      expect(status).toBe(2);
      expect(stderr).toMatch(/CODEV_BRANCH_NAME is required/);
    });
  });

  // -------------------------------------------------------------------------
  // The timeout — a hang must surface as an error
  // -------------------------------------------------------------------------

  describe('gitea_timeout', () => {
    it('kills a tea that never returns, and names the endpoint', () => {
      // A wrapper that spawns a child and waits: killing the wrapper alone
      // leaves the child holding the stdout pipe, and the command substitution
      // stays blocked long after the timeout "fired". That failure mode was
      // observed before the temp-file decoupling in gitea_timeout, so the stub
      // reproduces its shape deliberately.
      fs.writeFileSync(path.join(tmp, 'routes.tsv'), '\n');
      fs.writeFileSync(path.join(tmp, 'notfound.json'), NOT_FOUND);
      fs.writeFileSync(path.join(tmp, 'tea'), '#!/bin/sh\nsleep 60 &\nwait\n', { mode: 0o755 });
      fs.chmodSync(path.join(tmp, 'tea'), 0o755);

      const started = Date.now();
      const { status, stderr } = run('pr-exists.sh', {
        CODEV_BRANCH_NAME: 'whatever',
        CODEV_FORGE_TIMEOUT: '2',
      });
      const elapsed = Date.now() - started;

      expect(status).not.toBe(0);
      expect(stderr).toMatch(/did not return within 2s/);
      expect(stderr).toMatch(/repos\/o\/r/);
      expect(elapsed, 'the timeout did not actually unblock the caller').toBeLessThan(30_000);
    }, 40_000);
  });

  // -------------------------------------------------------------------------
  // pr-search
  // -------------------------------------------------------------------------

  describe('pr-search', () => {
    it.skipIf(!hasJq())('head:<branch> resolves through the base/head lookup', () => {
      routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/air-364', OPEN_PR]]);
      const { stdout } = run('pr-search.sh', { CODEV_SEARCH_QUERY: 'head:builder/air-364' });
      expect(JSON.parse(stdout)).toEqual([
        {
          number: 3855,
          title: 'open one',
          state: 'open',
          url: 'https://forge.example.com/o/r/pulls/3855',
          headRefName: 'builder/air-364',
          baseRefName: 'main',
        },
      ]);
    });

    it.skipIf(!hasJq())('finds a merged PR by branch with no is: qualifier (#1331/#759)', () => {
      // The bug #1331 fixes: an open-only default means `consult --type pr`
      // cannot find its own PR once it is merged.
      routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/aspir-3860', MERGED_PR_DELETED_BRANCH]]);
      const { stdout } = run('pr-search.sh', { CODEV_SEARCH_QUERY: 'head:builder/aspir-3860' });
      const prs = JSON.parse(stdout);
      expect(prs).toHaveLength(1);
      expect(prs[0]).toMatchObject({ number: 3869, state: 'merged', headRefName: 'builder/aspir-3860' });
    });

    it.skipIf(!hasJq())('is:open excludes that same merged PR', () => {
      routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/aspir-3860', MERGED_PR_DELETED_BRANCH]]);
      const { stdout } = run('pr-search.sh', {
        CODEV_SEARCH_QUERY: 'head:builder/aspir-3860 is:open',
      });
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it.skipIf(!hasJq())('is:merged keeps it (the afx cleanup query)', () => {
      routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/aspir-3860', MERGED_PR_DELETED_BRANCH]]);
      const { stdout } = run('pr-search.sh', {
        CODEV_SEARCH_QUERY: 'head:builder/aspir-3860 is:merged',
      });
      expect(JSON.parse(stdout)).toHaveLength(1);
    });

    it.skipIf(!hasJq())('is:merged excludes an OPEN PR (the qualifier means what it says)', () => {
      routes([REPO_ROUTE, ['repos/o/r/pulls/main/builder/air-364', OPEN_PR]]);
      const { stdout } = run('pr-search.sh', {
        CODEV_SEARCH_QUERY: 'head:builder/air-364 is:merged',
      });
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it.skipIf(!hasJq())('an issue number searches the cheap index, then resolves refs', () => {
      const index = JSON.stringify([
        { number: 3869, title: '[Spec 3860] the kit', body: '' },
        { number: 3800, title: 'unrelated', body: 'mentions 33861 only' },
      ]);
      routes([
        REPO_ROUTE,
        ['repos/o/r/issues\\?type=pulls*', index],
        ['repos/o/r/pulls/3869', MERGED_PR_DELETED_BRANCH],
      ]);
      const { stdout } = run('pr-search.sh', { CODEV_SEARCH_QUERY: '3860' });
      const prs = JSON.parse(stdout);
      expect(prs).toHaveLength(1);
      expect(prs[0]).toMatchObject({ number: 3869, baseRefName: 'main' });

      // The index endpoint carries the search term; the expensive pulls list is
      // never touched.
      const asked = endpoints();
      expect(asked.some((e) => e.includes('type=pulls') && e.includes('q=3860'))).toBe(true);
      expect(asked.some((e) => /pulls\?.*state=all/.test(e))).toBe(false);
    });

    it.skipIf(!hasJq())('word-bounds the issue number so #3386 never matches #33861', () => {
      const index = JSON.stringify([
        { number: 10, title: '[Spec 33861] a longer number', body: 'also 133860' },
      ]);
      routes([REPO_ROUTE, ['repos/o/r/issues\\?type=pulls*', index]]);
      const { stdout } = run('pr-search.sh', { CODEV_SEARCH_QUERY: '3386' });
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it.skipIf(!hasJq())('orders open PRs before merged ones, so prs[0] is the live PR', () => {
      const index = JSON.stringify([
        { number: 3869, title: 'old merged for #42', body: '' },
        { number: 3855, title: 'live one for #42', body: '' },
      ]);
      routes([
        REPO_ROUTE,
        ['repos/o/r/issues\\?type=pulls*', index],
        ['repos/o/r/pulls/3869', MERGED_PR_DELETED_BRANCH],
        ['repos/o/r/pulls/3855', OPEN_PR],
      ]);
      const { stdout } = run('pr-search.sh', { CODEV_SEARCH_QUERY: '42' });
      const prs = JSON.parse(stdout);
      expect(prs.map((p: { number: number }) => p.number)).toEqual([3855, 3869]);
      expect(prs[0].state).toBe('open');
    });

    it.skipIf(!hasJq())('returns [] rather than guessing at a query it does not understand', () => {
      routes([REPO_ROUTE]);
      const { stdout, status, stderr } = run('pr-search.sh', {
        CODEV_SEARCH_QUERY: 'author:someone sort:updated',
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
      expect(stderr).toMatch(/does not understand the query/);
    });
  });

  // -------------------------------------------------------------------------
  // pr-diff
  // -------------------------------------------------------------------------

  describe('pr-diff', () => {
    const DIFF = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b';

    it('returns the raw diff from the .diff endpoint', () => {
      routes([REPO_ROUTE, ['repos/o/r/pulls/7.diff', DIFF]]);
      const { stdout, status } = run('pr-diff.sh', { CODEV_PR_NUMBER: '7' });
      expect(status).toBe(0);
      expect(stdout.trimEnd()).toBe(DIFF);
    });

    it.skipIf(!hasJq())('name-only emits bare paths, one per line, like gh pr diff --name-only', () => {
      const files = JSON.stringify([
        { filename: 'apps/web/a.ts' },
        { filename: 'packages/db/b.ts' },
      ]);
      routes([REPO_ROUTE, ['repos/o/r/pulls/7/files*', files]]);
      const { stdout, status } = run('pr-diff.sh', {
        CODEV_PR_NUMBER: '7',
        CODEV_DIFF_NAME_ONLY: '1',
      });
      expect(status).toBe(0);
      expect(stdout.trim().split('\n')).toEqual(['apps/web/a.ts', 'packages/db/b.ts']);
    });

    it.skipIf(!hasJq())('errors instead of emitting Gitea\'s 404 body as if it were a diff', () => {
      // A model handed this would review the error page as the change.
      routes([REPO_ROUTE]);
      const { stdout, status, stderr } = run('pr-diff.sh', { CODEV_PR_NUMBER: '999999' });
      expect(status).not.toBe(0);
      expect(stdout).not.toMatch(/couldn't be found/);
      expect(stderr).toMatch(/not found/);
    });

    it('requires CODEV_PR_NUMBER', () => {
      routes([REPO_ROUTE]);
      const { status, stderr } = run('pr-diff.sh', {});
      expect(status).toBe(2);
      expect(stderr).toMatch(/CODEV_PR_NUMBER is required/);
    });
  });

  // -------------------------------------------------------------------------
  // recently-merged
  // -------------------------------------------------------------------------

  describe('recently-merged', () => {
    function indexOf(entries: Array<{ number: number; mergedAt: string | null }>): string {
      return JSON.stringify(
        entries.map((e) => ({
          number: e.number,
          title: `PR ${e.number}`,
          body: 'b',
          created_at: '2026-08-01T00:00:00Z',
          html_url: `https://forge.example.com/o/r/pulls/${e.number}`,
          pull_request: e.mergedAt === null ? { merged_at: null } : { merged_at: e.mergedAt },
        })),
      );
    }

    it.skipIf(!hasJq())('reads the cheap index and never pages the pulls list', () => {
      routes([
        REPO_ROUTE,
        ['repos/o/r/issues\\?type=pulls*', indexOf([{ number: 3869, mergedAt: '2026-08-21T03:12:02Z' }])],
        ['repos/o/r/pulls/3869', MERGED_PR_DELETED_BRANCH],
      ]);
      const { stdout, status } = run('recently-merged.sh', {
        CODEV_SINCE_DATE: '2026-08-20T00:00:00Z',
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([
        {
          number: 3869,
          title: 'PR 3869',
          url: 'https://forge.example.com/o/r/pulls/3869',
          body: 'b',
          createdAt: '2026-08-01T00:00:00Z',
          mergedAt: '2026-08-21T03:12:02Z',
          headRefName: 'builder/aspir-3860',
        },
      ]);
      // `state=closed` on the ISSUES index is fine and cheap. What must never
      // appear is a walk of the pulls list, which is the ~26-minute path.
      expect(endpoints().some((e) => /^repos\/o\/r\/pulls\?/.test(e))).toBe(false);
    });

    it.skipIf(!hasJq())('drops closed-not-merged pulls', () => {
      routes([
        REPO_ROUTE,
        ['repos/o/r/issues\\?type=pulls*', indexOf([{ number: 3800, mergedAt: null }])],
      ]);
      const { stdout } = run('recently-merged.sh', { CODEV_SINCE_DATE: '2026-08-20T00:00:00Z' });
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it.skipIf(!hasJq())('drops PRs updated in the window but merged before it', () => {
      // `since` filters on updated_at, so an old PR commented on yesterday comes
      // back from the index. merged_at is the field that decides.
      routes([
        REPO_ROUTE,
        ['repos/o/r/issues\\?type=pulls*', indexOf([{ number: 3000, mergedAt: '2026-01-01T00:00:00Z' }])],
      ]);
      const { stdout } = run('recently-merged.sh', { CODEV_SINCE_DATE: '2026-08-20T00:00:00Z' });
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it.skipIf(!hasJq())('an empty window is [] with status 0 — NOT a truncation', () => {
      routes([REPO_ROUTE, ['repos/o/r/issues\\?type=pulls*', '[]']]);
      const { stdout, status } = run('recently-merged.sh', {
        CODEV_SINCE_DATE: '2026-08-20T00:00:00Z',
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
    });

    it.skipIf(!hasJq())('exits 3 with EMPTY stdout when the window exceeds the ceiling', () => {
      // The distinction the whole script exists for: "nothing merged" and "I
      // stopped looking" must not be spelled the same way. A partial list is
      // indistinguishable from a complete one once printed, so none is printed.
      const many = Array.from({ length: 5 }, (_, i) => ({
        number: 100 + i,
        mergedAt: '2026-08-21T00:00:00Z',
      }));
      routes([REPO_ROUTE, ['repos/o/r/issues\\?type=pulls*', indexOf(many)]]);
      const { stdout, status, stderr } = run('recently-merged.sh', {
        CODEV_SINCE_DATE: '2026-08-20T00:00:00Z',
        CODEV_FORGE_MERGED_MAX: '2',
      });
      expect(status).toBe(3);
      expect(stdout.trim()).toBe('');
      expect(stderr).toMatch(/over the 2 ceiling/);
    });

    it.skipIf(!hasJq())('bounds itself to a default window when given no date, and says so', () => {
      routes([REPO_ROUTE, ['repos/o/r/issues\\?type=pulls*', '[]']]);
      const { status, stderr } = run('recently-merged.sh', {});
      expect(status).toBe(0);
      expect(stderr).toMatch(/limiting to the last 7 days/);
      // The window reaches the server as a `since` filter — the bound is not
      // client-side discarding, which is what made the old script slow.
      expect(endpoints().some((e) => e.includes('since='))).toBe(true);
    });

    it('rejects an unparseable CODEV_SINCE_DATE instead of silently widening', () => {
      routes([REPO_ROUTE]);
      const { status, stderr } = run('recently-merged.sh', { CODEV_SINCE_DATE: 'last tuesday' });
      expect(status).toBe(2);
      expect(stderr).toMatch(/expected YYYY-MM-DD or RFC3339/);
    });
  });
});

describe('#12 — the scripts pin their own commands, not their comments', () => {
  /**
   * These assertions are anchored to code lines. #1331's review caught the
   * opposite: assertions written as `content.toContain('--state all')` passed
   * against the explanatory comment that quoted the flag, so they stayed green
   * with the flag deleted from the command.
   */
  it('pr-exists reaches for the base/head endpoint and nothing that lists', () => {
    const src = fs.readFileSync(path.join(gitea, 'pr-exists.sh'), 'utf-8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(code.some((l) => /gitea_api "repos\/\$\{REPO\}\/pulls\/\$\{BASE\}\//.test(l))).toBe(true);
    expect(code.some((l) => l.includes('tea_api_paged'))).toBe(false);
    expect(code.some((l) => l.includes('state=all'))).toBe(false);
  });

  it('recently-merged reads the issues index, not the pulls list', () => {
    const src = fs.readFileSync(path.join(gitea, 'recently-merged.sh'), 'utf-8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(code.some((l) => /tea_api_paged "repos\/\$\{REPO\}\/issues"/.test(l))).toBe(true);
    expect(code.some((l) => /tea_api_paged "repos\/\$\{REPO\}\/pulls"/.test(l))).toBe(false);
    expect(code.some((l) => l.includes('state=closed') && l.includes('type=pulls'))).toBe(true);
  });

  it('afx spawn asks pr-search for OPEN PRs explicitly, not by relying on a default', () => {
    // #1331's review: without this, every re-spawn of an issue that ever had a
    // merged PR aborts with a factually wrong "Found N open PR(s)".
    const src = fs.readFileSync(
      path.join(codevPkgRoot, 'src', 'agent-farm', 'commands', 'spawn-worktree.ts'),
      'utf-8',
    );
    expect(src).toMatch(/CODEV_SEARCH_QUERY:\s*`in:body #\$\{issueNumber\} is:open`/);
  });
});
