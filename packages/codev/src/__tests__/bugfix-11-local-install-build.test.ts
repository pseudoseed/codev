/**
 * Regression test for bugfix #11: local-install ships whatever is in dist
 * without building, so it silently installs stale code and reports success.
 *
 * scripts/local-install.sh packs packages/{types,core,sdk,codev} into
 * tarballs and installs them globally. Packing reads straight from each
 * package's dist/, so if the script never rebuilds first, a stale dist/
 * gets packed, installed, and reported as "Installed: <version>" with no
 * signal that the code inside is stale (the printed version comes from
 * package.json, not from dist freshness).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const scriptPath = resolve(repoRoot, 'scripts', 'local-install.sh');

describe('bugfix #11: local-install builds before packing', () => {
  it('runs the workspace build before packing any package', () => {
    const script = readFileSync(scriptPath, 'utf8');

    const buildIndex = script.indexOf('pnpm -w run build');
    expect(
      buildIndex,
      'local-install.sh must invoke the workspace build (pnpm -w run build) before packing — ' +
        'otherwise it packs whatever is already in dist/, which may be stale'
    ).toBeGreaterThan(-1);

    const packMatches = [...script.matchAll(/pack --pack-destination/g)];
    expect(packMatches.length, 'expected at least one pack invocation in local-install.sh').toBeGreaterThan(0);

    for (const match of packMatches) {
      expect(
        buildIndex,
        'build must run before packing so the tarballs never contain a stale dist/'
      ).toBeLessThan(match.index!);
    }
  });
});
