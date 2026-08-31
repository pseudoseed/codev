import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The only files `npm pack` reads rather than merely stats: the manifest it takes `files` from,
 * and the two ignore-rule files it honours at every level. Everything else contributes nothing
 * but its path, which is why the skeleton below can stub it empty.
 */
const RULE_FILES = new Set(['package.json', '.npmignore', '.gitignore']);

/** Repo-relative paths of every file git tracks. `-z` so odd filenames survive the split. */
function trackedPaths(): string[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['ls-files', '-z'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
  } catch (err) {
    // Framed rather than raw, so a non-git checkout says which step failed and why it is needed.
    throw new Error(
      `Could not list the tracked files under ${workspaceRoot}: \`git ls-files\` failed. `
      + `This test derives what the package ships from the repository, so it needs git. `
      + `${(err as Error).message}`,
    );
  }
  return raw.split('\0').filter(Boolean);
}

/**
 * Materialise the tracked file set as a standalone tree under the OS temp directory.
 *
 * `withContent: false` writes every path as an empty file except the rule files above, which are
 * copied verbatim — enough for npm to apply the real packaging rules, and 55MB cheaper.
 * `withContent: true` copies everything, and exists only so the test below can prove the two
 * produce the same list.
 */
function buildFixture(label: string, withContent: boolean): string {
  const root = mkdtempSync(join(tmpdir(), `codev-pack-${label}-`));
  for (const rel of trackedPaths()) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (withContent || RULE_FILES.has(basename(rel))) copyFileSync(join(workspaceRoot, rel), dest);
    else writeFileSync(dest, '');
  }
  return root;
}

function packListIn(root: string): string[] {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
  const start = raw.indexOf('[');
  if (start === -1) throw new Error(`npm pack produced no JSON for ${root}: ${raw.slice(0, 200)}`);
  const files: string[] = (JSON.parse(raw.slice(start))[0]?.files ?? []).map((f: { path: string }) => f.path);
  // An empty list would satisfy every `not.toContain` assertion below without proving anything.
  if (files.length === 0) throw new Error(`npm reports an empty tarball for ${root}`);
  return files;
}

/**
 * What the root package ships, derived from the repository rather than from the disk (#298).
 *
 * This used to run `npm pack --dry-run --json` with `cwd: workspaceRoot`, which walks the entire
 * live working tree. Two things were wrong with reading the tree instead of the repo:
 *
 *  1. **Concurrent tests perturbed it.** Other suites in the same vitest run create and delete
 *     scratch directories under the workspace root — `agent-farm/__tests__/pir-832-migration.test.ts`
 *     does it once per test case, in `beforeEach`/`afterEach`. When the walk lstat'd a path that
 *     had just been removed, npm exited non-zero and this test failed. Not flaky: five consecutive
 *     full-suite runs, five failures, because the walk took ~62s with `dist/` present and the
 *     scratch directory churned many times inside that window.
 *  2. **It answered a question nobody asked.** The live list carried 43 files git does not
 *     track — `.builder-*`, files under `.claude/hooks/`, and every package's
 *     `node_modules/.bin/` shims — none of which say anything about what the package ships.
 *
 * Taking the paths from `git ls-files` fixes both. The packaging *rules* still come from npm, run
 * against the fixture, rather than being reimplemented here — `apps/web/.npmignore` alone
 * (`node_modules`, `src`, `*.config.*`, `tsconfig*`) plus npm's default excludes decide 55 tracked
 * files, and a second copy of those rules is the copy that drifts.
 *
 * **The honest limit: this fixture holds only tracked files, so it cannot answer anything about
 * build output.** `dist/`, `dashboard-dist/`, `v2-dist/` and `client-dist/` are gitignored, and a
 * `files` array outranks `.gitignore` in npm-packlist — so a live walk of a *built* tree carries
 * them (measured: 4,702 entries against the fixture's 3,575, 950 of the difference being build
 * output) while the fixture never will. That is deliberate. This test asks what the repository
 * ships, and the four assertions below all turn on tracked paths: `apps/web` and `apps/v2` package
 * manifests are tracked, and 216 tracked `apps/vscode/` files would appear here the moment the
 * `!apps/vscode` negation stopped excluding them. A question about the *built* tarball is a
 * different question and needs a built tree — `bugfix-214-publish-scrub.test.ts` asks it, per
 * package.
 *
 * Note the path shape: `--dry-run --json` yields paths **without** the `package/` prefix that
 * `tar -tzf` shows, so the assertions below match on the bare repo-relative path.
 */
function packedFiles(withContent = false): string[] {
  const root = buildFixture(withContent ? 'full' : 'skeleton', withContent);
  try {
    return packListIn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('extension retirement', () => {
  it('deletes the Stream Deck source tree rather than merely excluding its package', () => {
    expect(existsSync(join(workspaceRoot, 'apps/streamdeck'))).toBe(false);
  });

  it('removes both extensions from active release automation and instructions', () => {
    expect(existsSync(join(workspaceRoot, 'scripts/bump-vscode.sh'))).toBe(false);
    expect(existsSync(join(workspaceRoot, '.github/workflows/sdk-canary.yml'))).toBe(false);

    const releaseSurfaces = [
      'scripts/bump-all.sh',
      'codev/protocols/release/protocol.md',
      'docs/releases/UNRELEASED.md',
      'docs/releases/UNRELEASED.template.md',
      '.github/workflows/test.yml',
    ];

    for (const path of releaseSurfaces) {
      const content = readFileSync(join(workspaceRoot, path), 'utf8');
      expect(content, path).not.toMatch(/apps\/vscode|streamdeck|bump-vscode|sdk-canary/i);
    }
  });

  it('keeps supported apps in the pnpm workspace and excludes the VS Code extension', () => {
    const members = JSON.parse(
      execFileSync('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], {
        cwd: workspaceRoot,
        encoding: 'utf8',
      }),
    ) as Array<{ name?: string }>;
    const names = members.flatMap(({ name }) => (name ? [name] : []));

    expect(names).toContain('@cluesmith/codev-web');
    expect(names).toContain('@cluesmith/codev-v2');
    expect(names).not.toContain('codev-vscode');
    expect(names).not.toContain('@cluesmith/codev-streamdeck');
  });

  /**
   * 30s against a measured 2.0s: 0.3s to materialise 3,846 paths, 1.7s for npm's own startup and
   * walk of the fixture. 15x, and the multiple is the point — the old live-tree walk needed 60s
   * because its cost tracked whatever happened to be on disk, crossing the 10s default in #215
   * the first time a runner had `dist/` present and forcing the 60s budget in #216. This one
   * tracks the tracked-file count, which moves with the repo and slowly.
   */
  it('packs neither retired extension while retaining supported apps', () => {
    const files = packedFiles();
    expect(files).toContain('apps/web/package.json');
    expect(files).toContain('apps/v2/package.json');
    expect(files.some((file) => file.startsWith('apps/vscode/'))).toBe(false);
    expect(files.some((file) => file.startsWith('apps/streamdeck/'))).toBe(false);
  }, 30_000);

  /**
   * The regression test for #298.
   *
   * A scratch directory under the workspace root, of exactly the shape other suites create, must
   * not reach the pack list at all — if the list cannot see it while it exists, no concurrent
   * create or delete of it can perturb the list either. Against the old live-tree walk this file
   * was packed (the root `files` field is `["*", …]` and nothing gitignores it), so the assertion
   * fails without the fix.
   */
  it('derives the pack list from the repository, not from whatever is on disk', () => {
    const scratch = join(workspaceRoot, 'packages/codev/.test-bugfix-298');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'state.db'), '');
    try {
      expect(packedFiles()).not.toContain('packages/codev/.test-bugfix-298/state.db');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * The skeleton stubs every non-rule file empty, which is only sound while npm decides inclusion
   * from paths and rule files alone. Packing the same tracked set with its real contents must
   * therefore yield an identical list; if a future ignore mechanism starts reading a file the
   * skeleton blanks, the two diverge and this goes red rather than the skeleton silently
   * answering a different question.
   *
   * The comparison is deliberately skeleton-against-git rather than skeleton-against-the-live-tree,
   * and the next reader will ask why. Two reasons, both load-bearing. Packing the live tree is the
   * walk that failed five consecutive full-suite runs, so asserting against it would reintroduce
   * #298 inside the test written to close it. And the live-versus-git difference is not drift to
   * guard against — it is the 43 untracked litter files, i.e. the bug. The one risk the placeholder
   * trick actually adds is npm reading content from a file stubbed empty, and that is exactly what
   * this compares.
   */
  it('packs the placeholder skeleton identically to the tracked tree with real contents', () => {
    expect(packedFiles()).toEqual(packedFiles(true));
  }, 120_000);

  it('marks the retained VS Code source unsupported', () => {
    const readme = readFileSync(join(workspaceRoot, 'apps/vscode/README.md'), 'utf8');
    expect(readme).toContain('**Unsupported.**');
    expect(readme).toContain('no longer built, tested, packaged, or released');
  });
});
