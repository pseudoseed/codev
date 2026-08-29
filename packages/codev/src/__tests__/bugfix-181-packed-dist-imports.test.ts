/**
 * Regression for #181: packed dist/ relative imports must resolve inside
 * the tarball, and an empty dist/ must not pass by finding nothing to
 * complain about. The unit job never builds codev, so the live check
 * lives in verify-install.mjs (package job). These fixtures pin the
 * helper that job calls.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertPackedDistRelativeImports } from '../../scripts/packed-dist-imports.mjs';

function makeTarball(files: Record<string, string>): { dir: string; tarball: string } {
  const dir = mkdtempSync(join(tmpdir(), 'packed-dist-fix-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const tarball = join(dir, 'pkg.tgz');
  execFileSync('tar', ['-czf', tarball, 'package'], { cwd: dir });
  return { dir, tarball };
}

describe('bugfix-181: packed dist/ relative imports', () => {
  it('fails when the tarball has no dist/ .js files', () => {
    const { dir, tarball } = makeTarball({
      'package/package.json': '{"name":"x"}',
    });
    try {
      expect(() => assertPackedDistRelativeImports(tarball)).toThrow(
        /packed dist\/ contains no \.js files/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a relative import is missing from the tarball', () => {
    const { dir, tarball } = makeTarball({
      'package/dist/a.js': "import { x } from './missing.js';\n",
    });
    try {
      expect(() => assertPackedDistRelativeImports(tarball)).toThrow(
        /relative imports missing from tarball/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when every relative import resolves inside the tarball', () => {
    const { dir, tarball } = makeTarball({
      'package/dist/a.js': "import { x } from './b.js';\n",
      'package/dist/b.js': 'export const x = 1;\n',
    });
    try {
      expect(() => assertPackedDistRelativeImports(tarball)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verify-install.mjs runs the packed-dist check on the codev tarball', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../../scripts/verify-install.mjs'),
      'utf8',
    );
    expect(src).toContain('assertPackedDistRelativeImports');
    expect(src).toContain('isCodevTarball');
  });
});
