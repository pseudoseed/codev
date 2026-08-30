// @vitest-environment node
/**
 * THE COVERAGE TABLE IS CHECKED, NOT REMEMBERED.
 *
 * `README.md` carries a table of which test suite covers what, and its whole
 * purpose is to stop someone quoting a green run that could not reach the code
 * they changed. That happened in this PR: a change to `PairingStore.issue()`
 * broke `phase7-pairing.e2e.test.ts`, and the 6,813-passing unit run quoted as
 * evidence excludes `**\/*.e2e.test.ts` — a measurement taken where the thing
 * being measured was not present.
 *
 * A table that can itself go stale reintroduces exactly that failure, with MORE
 * authority than no table, because the next reader trusts it. And it is not
 * hypothetical: the first version of the table was typed from memory and omitted
 * `vitest.cli.config.ts`. It drifted within one turn of being written.
 *
 * So the list is DERIVED here — from the vitest configs on disk and this app's
 * own `package.json` — and the table is asserted to match it in both directions.
 * Add a suite, rename a config, or drop a row, and this fails and names which.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(CLIENT_ROOT, '..', '..');
const CODEV = join(REPO_ROOT, 'packages', 'codev');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'test.yml');

/** Every vitest config in `packages/codev`, read off disk. */
function codevSuites(): string[] {
  return readdirSync(CODEV)
    .filter((name) => /^vitest[.\w-]*\.config\.ts$/.test(name))
    .sort();
}

/**
 * This app's runnable test suites, from its own scripts.
 *
 * A script counts when it runs vitest or Playwright NON-INTERACTIVELY —
 * `vitest run` or `playwright test`. `test:watch` is `vitest` with no `run`, so
 * it is a developer convenience rather than a suite, and it is excluded by that
 * rule rather than by being named here.
 */
function clientSuites(): string[] {
  const pkg = JSON.parse(readFileSync(join(CLIENT_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return Object.entries(pkg.scripts)
    .filter(([, command]) => /\bvitest run\b/.test(command) || /\bplaywright test\b/.test(command))
    .map(([name]) => name)
    .sort();
}

/** The table's first column, between the markers, as written. */
function tableSuites(): string[] {
  const readme = readFileSync(join(CLIENT_ROOT, 'README.md'), 'utf8');
  const begin = readme.indexOf('<!-- suite-coverage:begin -->');
  const end = readme.indexOf('<!-- suite-coverage:end -->');
  expect(begin, 'README.md is missing the suite-coverage:begin marker').toBeGreaterThan(-1);
  expect(end, 'README.md is missing the suite-coverage:end marker').toBeGreaterThan(begin);

  return readme.slice(begin, end)
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|')[1].trim())
    // `\`packages/codev\` · \`vitest.e2e.config.ts\`` → `packages/codev:vitest.e2e.config.ts`
    .map((cell) => cell.replace(/`/g, '').split('·').map((part) => part.trim()).join(':'))
    .sort();
}

function derivedSuites(): string[] {
  return [
    ...codevSuites().map((config) => `packages/codev:${config}`),
    ...clientSuites().map((script) => `apps/client:pnpm ${script}`),
  ].sort();
}

describe('the README suite-coverage table', () => {
  it('names every suite that exists, and no suite that does not', () => {
    // One assertion in both directions: a missing row and an invented row are
    // different mistakes and this reports whichever happened.
    expect(tableSuites()).toEqual(derivedSuites());
  });

  it('is derived from something, not from a list typed here', () => {
    // Guards the guard: if the derivation stops finding configs, the equality
    // above passes vacuously against an empty table.
    expect(codevSuites().length).toBeGreaterThanOrEqual(3);
    expect(clientSuites()).toContain('test');
    expect(clientSuites()).toContain('test:e2e');
    // And `test:watch` must NOT be counted — the interactive-exclusion rule is
    // the sort of thing that stops working silently.
    expect(clientSuites()).not.toContain('test:watch');
  });

  it('names only suites CI actually runs', () => {
    const workflow = readFileSync(WORKFLOW, 'utf8');
    for (const config of codevSuites()) {
      // The default config is used implicitly by a bare `vitest run`; the others
      // must appear by name in a CI command.
      if (config === 'vitest.config.ts') {
        expect(workflow, 'no CI step runs the default packages/codev suite')
          .toMatch(/vitest run --coverage|pnpm test/);
        continue;
      }
      expect(workflow, `no CI step runs --config ${config}`).toContain(`--config ${config}`);
    }
    for (const script of clientSuites()) {
      expect(workflow, `no CI step runs apps/client's "${script}"`)
        .toMatch(new RegExp(`run: pnpm ${script.replace(/[:]/g, ':')}\\b`));
    }
  });
});
