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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A step that runs exactly `pnpm <script>` and nothing else on that line. */
function exactStep(script: string): RegExp {
  return new RegExp(`^\\s*run: pnpm ${escapeRegExp(script)}\\s*$`, 'm');
}

/** Split the workflow into steps so a match can be tied to one, with its directory. */
function stepsOf(workflow: string): Array<{ dir: string; block: string }> {
  return workflow.split(/\n(?=\s*- name: )/).map((block) => ({
    dir: /working-directory:\s*(\S+)/.exec(block)?.[1] ?? '',
    block,
  }));
}

function runsIn(
  dir: string,
  matches: (block: string) => boolean,
  workflow = readFileSync(WORKFLOW, 'utf8'),
): boolean {
  return stepsOf(workflow).some((step) => step.dir === dir && matches(step.block));
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
    /*
     * MATCHED AGAINST WHOLE STEPS, IN THE RIGHT DIRECTORY.
     *
     * Two versions of this check were vacuous in the same way, one level in from
     * the emptiness guard above. `run: pnpm ${script}\b` was satisfied for the
     * `test` suite by the `test:e2e` STEP, because `\b` matches between `test`
     * and a colon. And the default codev config was accepted by a bare
     * `pnpm test` anywhere in the file — which `apps/web`, `apps/v2` and
     * `test:browser` all supply. Either unit step could have been deleted from
     * CI with this guard still green, in the test whose entire job is proving
     * every suite is actually run.
     *
     * So: the workflow is split into steps, and a suite is satisfied only by a
     * step that runs IT, in the directory it belongs to. A substring hunt over a
     * whole YAML file cannot express either of those.
     */
    for (const config of codevSuites()) {
      // The default config is implicit in a bare `vitest run`; CI runs it with
      // coverage, which is specific enough to name and belongs to no other step.
      const ok = config === 'vitest.config.ts'
        ? runsIn('packages/codev', (block) => /vitest run --coverage/.test(block))
        : runsIn('packages/codev', (block) => block.includes(`--config ${config}`));
      expect(ok, `no CI step in packages/codev runs ${config}`).toBe(true);
    }

    for (const script of clientSuites()) {
      expect(
        runsIn('apps/client', (block) => exactStep(script).test(block)),
        `no CI step in apps/client runs exactly "pnpm ${script}"`,
      ).toBe(true);
    }
  });

  it('would notice a suite losing its CI step', () => {
    /*
     * GUARDS THE GUARD ABOVE. It is only worth having if it can fail, and both
     * of its previous versions could not — so this drives the matcher against a
     * workflow with the step removed rather than trusting the shape.
     */
    const workflow = readFileSync(WORKFLOW, 'utf8');
    const withoutClientUnit = workflow.replace(
      /\n\s*- name: Run client unit tests\n[\s\S]*?(?=\n\s*- name: )/,
      '',
    );
    expect(withoutClientUnit, 'the client unit step could not be removed; update this guard')
      .not.toBe(workflow);
    // `pnpm test:e2e` survives that removal and must NOT satisfy `pnpm test`.
    expect(withoutClientUnit).toContain('run: pnpm test:e2e');
    expect(runsIn('apps/client', (block) => exactStep('test').test(block), withoutClientUnit))
      .toBe(false);
  });
});
