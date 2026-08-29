import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The root pack's file list, resolved lazily and only for the one test that needs it (#216).
 *
 * This used to write a real tarball in a `beforeAll` and then shell out to `tar -tzf` purely to
 * read a list of names. Three things were wrong with that, and #215 turned the combination red:
 *
 *  1. **The work far exceeded the assertion.** `npm pack --dry-run --json` returns the same
 *     list with no tarball written and no `tar` process. The root `package.json` is
 *     `files: ["*", …]`, so the pack sweeps the whole monorepo — 4,395 files and 27MB packed
 *     once `packages/codev` is built — and every byte of that was being compressed to disk and
 *     read back so four `startsWith` checks could run.
 *  2. **It ran for every test in the file.** Four of the five tests read files or `pnpm list`
 *     and need nothing from the pack. In `beforeAll` a slow fixture takes down tests that never
 *     depended on it: when the hook died, all five were reported skipped.
 *  3. **It had no explicit timeout,** so it ran on vitest's 10s default and crossed it by 544ms
 *     the first time CI had a built `dist/`, `dashboard-dist/` and `v2-dist/` present.
 *
 * Note the path shape: `--dry-run --json` yields paths **without** the `package/` prefix that
 * `tar -tzf` shows, so the assertion below matches on the bare repo-relative path.
 */
function packedFiles(): string[] {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
  const start = raw.indexOf('[');
  if (start === -1) throw new Error(`npm pack produced no JSON for the workspace root: ${raw.slice(0, 200)}`);
  const files: string[] = (JSON.parse(raw.slice(start))[0]?.files ?? []).map((f: { path: string }) => f.path);
  // An empty list would satisfy both `not.toContain` assertions below without proving anything.
  if (files.length === 0) throw new Error('npm reports an empty tarball for the workspace root');
  return files;
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
   * 60s, deliberately, and not the 10s default that failed.
   *
   * The budget is set by what the pack actually has to walk, which grows with the repo: 4,395
   * files today, ~4.7s warm on a developer machine, and it crossed 10s on a CI runner the first
   * time the built output was present. 60s is roughly 12x the measured local cost — enough
   * headroom that ordinary growth and a cold runner do not make this red again, and still short
   * enough that a genuine hang fails rather than hanging the job.
   */
  it('packs neither retired extension while retaining supported apps', () => {
    const files = packedFiles();
    expect(files).toContain('apps/web/package.json');
    expect(files).toContain('apps/v2/package.json');
    expect(files.some((file) => file.startsWith('apps/vscode/'))).toBe(false);
    expect(files.some((file) => file.startsWith('apps/streamdeck/'))).toBe(false);
  }, 60_000);

  it('marks the retained VS Code source unsupported', () => {
    const readme = readFileSync(join(workspaceRoot, 'apps/vscode/README.md'), 'utf8');
    expect(readme).toContain('**Unsupported.**');
    expect(readme).toContain('no longer built, tested, packaged, or released');
  });
});
