/**
 * Issue #214 — nothing with a home-directory path in it gets published.
 *
 * The instance was `packages/t3-client/src/auth.ts:9`, which carried the maintainer's
 * local scratch directory inside a comment. `files: ["src", "dist"]` and no
 * `removeComments` in the tsconfig meant that one line shipped three times: the source,
 * the emitted `.js`, and the emitted `.d.ts`. npm publishes are effectively irreversible,
 * and the human's condition for publishing these packages was zero identities in what
 * ships — code and comments alike.
 *
 * The guard is worth more than that fix. Seven packages publish from this repo today, and
 * the count is itself a trap: the issue that commissioned this guard said four, because it
 * was written by counting the packages someone had in mind rather than by reading the
 * manifests. So nothing here restates the population — it is derived, every run, from
 * `packages/<*>/package.json`, and the shipped file set is resolved by asking npm what it
 * would actually put in the tarball rather than by re-implementing `files` semantics. A
 * manifest that claims one thing and ships another is caught by the same move.
 *
 * THERE IS DELIBERATELY NO ALLOWLIST OF "SAFE" USERNAMES, and there must not be one.
 * Documentation legitimately needs to show what a home path looks like, so the exemption is
 * STRUCTURAL: a placeholder is `<user>`-shaped or a literal `...` ellipsis, neither of which
 * is a path or can become one by anybody's judgement. A name-based allowlist has a gradient —
 * the cheapest fix for a red on a doc placeholder is to add that name to the list, and two
 * rounds of that is where a real path goes to become invisible. If this fires on a
 * placeholder, rewrite the placeholder structurally; do not teach the guard about humans.
 *
 * SCOPE: home-directory paths only. Emails, hostnames, IPs and credentials are not checked
 * here, so a green run means "no home path shipped", never "nothing identifying shipped".
 * Sourcemaps ARE in scope — `sources` and `sourcesContent` carry build-machine paths and
 * nobody reads a `.map` — and there are tests below naming that, so it stays deliberate.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../..');

const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

/** A package directory carrying a `.` or `+` would otherwise loosen the match it is built into. */
const escapeRe = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every package this repo would publish, derived rather than listed.
 *
 * `private: true` is npm's own refusal to publish, so it is the only thing that takes a
 * package out of scope. A new package under `packages/` is in scope the day it appears,
 * which is the whole point — the next one will not be checked by anyone remembering.
 */
function publishablePackages(
  packagesDir = join(repoRoot, 'packages'),
): Array<{ name: string; dir: string; rel: string }> {
  const found = readdirSync(packagesDir)
    .map((entry) => ({ entry, dir: join(packagesDir, entry) }))
    .filter(({ dir }) => existsSync(join(dir, 'package.json')))
    .map(({ entry, dir }) => ({ manifest: readManifest(dir), entry, dir }))
    .filter(({ manifest }) => manifest.private !== true)
    .map(({ manifest, entry, dir }) => ({ name: manifest.name as string, dir, rel: `packages/${entry}` }));

  // A resolver that finds nothing passes every assertion made about what it found.
  if (found.length === 0) throw new Error(`No publishable packages found under ${packagesDir}`);
  return found;
}

/**
 * What npm would actually put in the tarball.
 *
 * `--ignore-scripts` because no publishable package declares a `prepack`/`prepare` today and
 * a future one must not be able to make this scan run its build as a side effect. `--json`
 * output is an array of one pack result; anything else is a resolution failure, not an
 * empty tarball, and is raised as such.
 */
const shippedCache = new Map<string, string[]>();

/** Both assertions below resolve the same tarballs; `npm pack` is ~0.5s a package. */
function shippedFiles(pkg: { name: string; dir: string; rel: string }): string[] {
  const cached = shippedCache.get(pkg.dir);
  if (cached) return cached;
  let raw: string;
  try {
    raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: pkg.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 28,
    });
  } catch (err) {
    throw new Error(
      `Could not resolve the shipped file set for ${pkg.name} (${pkg.rel}): `
      + `\`npm pack --dry-run\` failed. ${(err as Error).message}`,
    );
  }
  const start = raw.indexOf('[');
  if (start === -1) throw new Error(`npm pack produced no JSON for ${pkg.name}: ${raw.slice(0, 200)}`);
  const result = JSON.parse(raw.slice(start));
  const files: string[] = (result[0]?.files ?? []).map((f: { path: string }) => f.path);
  if (files.length === 0) throw new Error(`npm reports an empty tarball for ${pkg.name} (${pkg.rel})`);
  shippedCache.set(pkg.dir, files);
  return files;
}

/**
 * Entries in `files` that resolved to nothing.
 *
 * This is the vacuous-pass hole, and it is the one that actually happens: `dist/` is a
 * gitignored build output, so an unbuilt package resolves to a tarball missing most of
 * itself and every scan over it passes. Named as a missing build artifact, with the
 * remedy, rather than as a clean run.
 */
function unresolvedFilesEntries(pkg: { dir: string }, shipped: string[]): string[] {
  const manifest = readManifest(pkg.dir);
  const entries: string[] = manifest.files ?? [];
  return entries.filter((entry) => {
    const prefix = entry.replace(/^\.\//, '').replace(/\/$/, '');
    return !shipped.some((f) => f === prefix || f.startsWith(`${prefix}/`));
  });
}

/**
 * A home-directory path, and the two shapes that are not one.
 *
 * The captured group is the segment after the home root — the part that names a human on
 * some machine. The character class stops at anything that ends a path in prose or code, so
 * `'/Users/x/repos/foo'` yields `x` and not `x/repos/foo'`.
 */
const HOME_PATH_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:\\+Users\\+)([^/\\\s'"`)\]},;:]+)/g;

/**
 * Structural, not nominal: `<anything>` or an ellipsis, in either the ASCII or the Unicode
 * spelling. No usernames, ever — see the header.
 *
 * `\u2026` is here because the guard found it and an ad-hoc grep written by hand did not:
 * `packages/codev/src/agent-farm/utils/config.ts` documents `/Users/\u2026/.local/bin/claude`, and a
 * character class of `[A-Za-z0-9._-]` skips that line in silence. A placeholder the guard
 * cannot recognise is a red that gets argued away, which is how allowlists start.
 */
const isPlaceholder = (segment: string) => /^(?:\.\.\.|\u2026|<[^>]*>)$/.test(segment);

type Hit = { file: string; line: number; text: string };

function scanForHomePaths(pkg: { dir: string }, shipped: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const rel of shipped) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(pkg.dir, rel));
    } catch {
      continue; // npm lists it, we cannot read it; the unresolved-entries check owns absence.
    }
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(HOME_PATH_RE)) {
        if (isPlaceholder(m[1])) continue;
        hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160) });
      }
    });
  }
  return hits;
}

describe('Issue #214 — no home-directory path reaches a published tarball', () => {
  it('resolves a non-empty shipped set for every publishable package', () => {
    const packages = publishablePackages();
    const unresolved = packages
      .map((pkg) => ({ pkg, missing: unresolvedFilesEntries(pkg, shippedFiles(pkg)) }))
      .filter(({ missing }) => missing.length > 0);

    // Deliberately not a skip. A skipped "could not check" is absorbed by a green suite
    // exactly as completely as a pass, which is how the packed-imports test stayed invisible
    // to CI for its entire life (#200).
    expect(
      unresolved.map(({ pkg, missing }) =>
        `${pkg.rel} ships ${missing.join(', ')} but they resolve to nothing — `
        + `these are build outputs. Run \`pnpm -w run build\` and re-run; this is a missing `
        + `build artifact, not a failure of the code under test.`),
    ).toEqual([]);
  }, 60_000);

  it('finds no home-directory path in anything that would ship', () => {
    const found = publishablePackages().flatMap((pkg) =>
      scanForHomePaths(pkg, shippedFiles(pkg)).map((hit) => `${pkg.rel}/${hit.file}:${hit.line}: ${hit.text}`),
    );
    expect(found).toEqual([]);
  }, 60_000);
});

describe('Issue #214 — the guard fails when it should', () => {
  const withFixture = (files: Record<string, string>, manifest: object, run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-scrub-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', ...manifest }));
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), body);
      }
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('detects a home path planted in a shipped file', () => {
    withFixture(
      { 'src/leak.ts': "// see /Users/someone/dev/spike/spike.mjs\nexport const ok = 1;\n" },
      { files: ['src'] },
      (dir) => {
        const pkg = { name: 'fixture', dir, rel: 'fixture' };
        const hits = scanForHomePaths(pkg, shippedFiles(pkg));
        expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(['src/leak.ts:1']);
      },
    );
  }, 30_000);

  it('detects the Linux and Windows forms too', () => {
    withFixture(
      { 'src/leak.ts': "// /home/someone/dev\n// C:\\Users\\Someone\\dev\n" },
      { files: ['src'] },
      (dir) => {
        const pkg = { name: 'fixture', dir, rel: 'fixture' };
        expect(scanForHomePaths(pkg, shippedFiles(pkg)).map((h) => h.line)).toEqual([1, 2]);
      },
    );
  }, 30_000);

  it('passes structural placeholders and nothing else', () => {
    withFixture(
      { 'src/doc.ts': "// /Users/<user>/repos/foo\n// /Users/.../workspace\n// C:\\Users\\<user>\\dev\n" },
      { files: ['src'] },
      (dir) => {
        const pkg = { name: 'fixture', dir, rel: 'fixture' };
        expect(scanForHomePaths(pkg, shippedFiles(pkg))).toEqual([]);
      },
    );
  }, 30_000);

  /**
   * Sourcemaps are a disclosure route the original audit did not cover: `sources` and
   * `sourcesContent` can carry the build machine's absolute paths, and nobody reads a `.map`.
   * They need no special handling — a `.map` is UTF-8 text, so the scan above already reads
   * them — but "covered incidentally" and "covered" are different claims, and only one of
   * them survives someone adding a binary-ish skip later. This is the test that makes it the
   * second one.
   */
  it('reads sourcemaps, where an absolute path hides in `sources`', () => {
    withFixture(
      {
        'dist/app.js': '//# sourceMappingURL=app.js.map\n',
        'dist/app.js.map': JSON.stringify({
          version: 3,
          sources: ['/Users/someone/dev/project/src/app.ts'],
          sourcesContent: ['export const ok = 1;\n'],
          mappings: '',
        }),
      },
      { files: ['dist'] },
      (dir) => {
        const pkg = { name: 'fixture', dir, rel: 'fixture' };
        expect(scanForHomePaths(pkg, shippedFiles(pkg)).map((h) => h.file)).toEqual(['dist/app.js.map']);
      },
    );
  }, 30_000);

  it('reads a home path embedded in `sourcesContent`, not only in `sources`', () => {
    withFixture(
      {
        'dist/app.js.map': JSON.stringify({
          version: 3,
          sources: ['../src/app.ts'],
          sourcesContent: ['// copied from /Users/someone/dev/spike\nexport const ok = 1;\n'],
          mappings: '',
        }),
      },
      { files: ['dist'] },
      (dir) => {
        const pkg = { name: 'fixture', dir, rel: 'fixture' };
        expect(scanForHomePaths(pkg, shippedFiles(pkg)).map((h) => h.file)).toEqual(['dist/app.js.map']);
      },
    );
  }, 30_000);

  it('reports an unbuilt `files` entry rather than scanning an empty set', () => {
    withFixture({ 'src/ok.ts': 'export const ok = 1;\n' }, { files: ['src', 'dist'] }, (dir) => {
      const pkg = { name: 'fixture', dir, rel: 'fixture' };
      const shipped = shippedFiles(pkg);
      expect(unresolvedFilesEntries(pkg, shipped)).toEqual(['dist']);
      // The hole this closes: the scan over the surviving set is clean, so without the
      // unresolved-entries check the missing half reads as a pass.
      expect(scanForHomePaths(pkg, shipped)).toEqual([]);
    });
  }, 30_000);

  it('throws rather than resolving an empty set for a package that is not there', () => {
    expect(() => shippedFiles({ name: 'ghost', dir: join(tmpdir(), 'no-such-package-214'), rel: 'ghost' }))
      .toThrow(/Could not resolve the shipped file set for ghost/);
  }, 30_000);

  it('refuses to report a clean run over an empty population', () => {
    // The branch that matters is the one nothing else reaches: a `packages/` that resolves to
    // no publishable package must raise, not return `[]`. An empty array satisfies every
    // assertion made about what was found, which is the whole failure mode this file exists
    // for — so it is exercised against a real empty directory rather than reasoned about.
    const empty = mkdtempSync(join(tmpdir(), 'publish-scrub-empty-'));
    try {
      expect(() => publishablePackages(empty)).toThrow(/No publishable packages found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(publishablePackages().length).toBeGreaterThan(0);
  });

  it('treats a directory of only private packages as an empty population', () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-scrub-private-'));
    try {
      mkdirSync(join(dir, 'only-private'));
      writeFileSync(
        join(dir, 'only-private', 'package.json'),
        JSON.stringify({ name: 'p', version: '0.0.0', private: true }),
      );
      expect(() => publishablePackages(dir)).toThrow(/No publishable packages found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Issue #214 — CI builds every publishable package before this guard runs', () => {
  /**
   * The scan is only as good as the tarballs it can resolve, and `dist/` exists only after a
   * build. The unit-test job built five of the seven publishable packages when this landed;
   * `packages/codev` was the one whose absence would have silently narrowed the scan to the
   * files that happen to be committed. Read from the workflow rather than restated, so a
   * package added to `packages/` fails here instead of quietly leaving the scan.
   */
  it('the unit test job has a build step for each of them', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/test.yml'), 'utf8');
    const start = workflow.indexOf('\n  unit:');
    // The NEXT top-level job, whichever it is. Anchoring on a named successor meant a job
    // inserted after `unit:` widened the slice, and its build steps would have counted as the
    // unit job's. A rename still fails loudly rather than slicing an empty string.
    const end = start === -1 ? -1 : workflow.slice(start + 1).search(/\n {2}[a-z0-9][a-z0-9-]*:\n/);
    expect({ start: start > -1, end: end > -1 }).toEqual({ start: true, end: true });
    const unitJob = workflow.slice(start, start + 1 + end);

    // A step that merely names the directory is not a build — `packages/codev` already had a
    // `copy-skeleton` step there, and matching on the directory alone would have called that
    // a build and passed while `dist/` stayed absent. The `run:` line has to build.
    const missing = publishablePackages()
      .filter((pkg) => !new RegExp(`working-directory: ${escapeRe(pkg.rel)}\\s*\\n\\s*run: [^\\n]*pnpm build`).test(unitJob))
      .map((pkg) => `${pkg.rel} is publishable but the unit test job never builds it`);
    expect(missing).toEqual([]);
  });
});

describe('Issue #214 — both new packages carry the licence they declare', () => {
  const rootLicense = readFileSync(join(repoRoot, 'LICENSE'), 'utf8');

  for (const rel of ['packages/t3-client', 'packages/porch-driver']) {
    it(`${rel} ships an Apache-2.0 LICENSE matching its declared licence`, () => {
      const manifest = readManifest(join(repoRoot, rel));
      expect(manifest.license).toBe('Apache-2.0');
      // npm includes LICENSE automatically, so this is about the file existing at all:
      // without it the package publishes claiming a licence whose text it does not carry.
      expect(readFileSync(join(repoRoot, rel, 'LICENSE'), 'utf8')).toBe(rootLicense);
    });

    it(`${rel} points npm back at its source`, () => {
      const { repository } = readManifest(join(repoRoot, rel));
      expect(repository?.url).toBe('https://github.com/cluesmith/codev');
      expect(repository?.directory).toBe(rel);
    });
  }
});
