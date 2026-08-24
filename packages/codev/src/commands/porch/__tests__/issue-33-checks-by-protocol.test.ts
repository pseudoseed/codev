/**
 * Issue #33 — a correct check override that warns on every `porch status`.
 *
 * `porch.checks` is one flat map applied to every protocol, and protocols do not
 * declare the same check names. Measured against the skeleton in this repo:
 *
 *   air        build, e2e_tests, pr_exists, tests
 *   bugfix     build, regression_test, tests
 *   maintain   build, tests
 *   pir        build, plan_exists, pr_exists, review_has_*, tests
 *   spir/aspir build, e2e_tests, tests, + the artifact checks
 *
 * `regression_test` exists only in BUGFIX; `e2e_tests` is absent from BUGFIX,
 * PIR and MAINTAIN. In a repo with no package.json the npm defaults cannot run,
 * so those overrides are required — and then every `porch status` on a protocol
 * that does not declare the name printed:
 *
 *   ⚠ Unknown check override "regression_test" (not found in protocol)
 *
 * There was no way to satisfy both. Dropping the override broke the protocol
 * that needed it; keeping it warned on every protocol that did not.
 *
 * (The issue's own example uses `test`, singular. No protocol in this skeleton
 * declares that name — they all use `tests` — so a literal `test` override still
 * warns, correctly.)
 *
 * Two halves, offered in the issue as alternatives. They fix different things:
 * `byProtocol` lets the config say what it means, and the warning fix stops
 * punishing a flat override that is simply not used by this protocol.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { getPhaseChecks } from '../protocol.js';
import { loadCheckOverrides } from '../config.js';
import { listAllCheckNames } from '../../../lib/skeleton.js';
import type { Protocol } from '../types.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

const spir = {
  name: 'spir',
  phases: [{ id: 'implement', checks: ['build', 'tests'] }],
  checks: { build: { command: 'npm run build' }, tests: { command: 'npm test' } },
} as unknown as Protocol;

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStderr(): { lines: string[] } {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines };
}

/** A throwaway workspace with a .codev/config.json. */
function withConfig(config: unknown, fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'i33-'));
  fs.mkdirSync(path.join(root, '.codev'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codev', 'config.json'), JSON.stringify(config, null, 2));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('#33: the warning that punished a correct override', () => {
  it('does not warn for a name another protocol declares', () => {
    // `regression_test` is BUGFIX's alone. SPIR has no such check, and that is
    // not an error — the override simply does not apply here.
    const { lines } = captureStderr();

    getPhaseChecks(spir, 'implement', { regression_test: { skip: true } }, REPO_ROOT);

    expect(lines.join('')).toBe('');
  });

  it('still warns for a name NO protocol declares, which really is a typo', () => {
    const { lines } = captureStderr();

    getPhaseChecks(spir, 'implement', { tset: { command: './run-tests.sh' } }, REPO_ROOT);

    expect(lines.join('')).toContain('"tset"');
    expect(lines.join('')).toContain('not declared by any protocol');
  });

  it('keeps warning when no workspace is given, rather than falling silent', () => {
    // Without a workspace there is nothing to check the name against. Silence
    // there would turn a real typo into a no-op, so the old behaviour stands.
    const { lines } = captureStderr();

    getPhaseChecks(spir, 'implement', { regression_test: { skip: true } });

    expect(lines.join('')).toContain('"regression_test"');
  });

  it('never warns for a name this protocol does declare', () => {
    const { lines } = captureStderr();

    getPhaseChecks(spir, 'implement', { tests: { command: './run-tests.sh' } }, REPO_ROOT);

    expect(lines.join('')).toBe('');
  });
});

describe('#33: listAllCheckNames', () => {
  it('finds names from protocols other than the one being run', () => {
    const names = listAllCheckNames(REPO_ROOT);

    expect(names.has('regression_test')).toBe(true); // bugfix only
    expect(names.has('e2e_tests')).toBe(true);       // air, aspir, spir
    expect(names.has('tests')).toBe(true);           // most
    expect(names.has('build')).toBe(true);           // all
  });

  it('includes phase_completion predicates, which porch.checks also overrides', () => {
    const names = listAllCheckNames(REPO_ROOT);

    expect(names.has('tests_pass') || names.has('build_succeeds')).toBe(true);
  });

  it('reports nothing rather than throwing when the tiers cannot be read', () => {
    expect(() => listAllCheckNames(path.join(tmpdir(), 'i33-does-not-exist'))).not.toThrow();
  });
});

describe('#33: byProtocol lets the config say what it means', () => {
  it('applies a per-protocol override that the flat map does not carry', () => {
    withConfig(
      { porch: { byProtocol: { bugfix: { checks: { regression_test: { command: './run-tests.sh' } } } } } },
      root => {
        expect(loadCheckOverrides(root, 'bugfix')?.regression_test?.command).toBe('./run-tests.sh');
      },
    );
  });

  it('does not leak one protocol’s override into another', () => {
    // The whole point. A BUGFIX-only override must not reach SPIR.
    withConfig(
      { porch: { byProtocol: { bugfix: { checks: { regression_test: { command: './run-tests.sh' } } } } } },
      root => {
        expect(loadCheckOverrides(root, 'spir')).toBeNull();
      },
    );
  });

  it('merges field-by-field over the flat map, per-protocol winning', () => {
    // Wholesale replacement would mean a per-protocol `skip` silently discarded
    // the global `command` for the same check.
    withConfig(
      {
        porch: {
          checks: { build: { command: './render.sh', cwd: 'infra' } },
          byProtocol: { bugfix: { checks: { build: { timeout: 900 } } } },
        },
      },
      root => {
        const o = loadCheckOverrides(root, 'bugfix');

        expect(o?.build).toEqual({ command: './render.sh', cwd: 'infra', timeout: 900 });
      },
    );
  });

  it('leaves the flat map alone for a protocol with no entry', () => {
    withConfig(
      {
        porch: {
          checks: { build: { command: './render.sh' } },
          byProtocol: { bugfix: { checks: { regression_test: { skip: true } } } },
        },
      },
      root => {
        expect(loadCheckOverrides(root, 'spir')).toEqual({ build: { command: './render.sh' } });
      },
    );
  });

  it('treats an alias and its canonical name as the same entry', () => {
    // `spider` is spir. Resolving by spelling would make the config depend on
    // which one happened to be typed.
    withConfig(
      { porch: { byProtocol: { spider: { checks: { tests: { skip: true } } } } } },
      root => {
        expect(loadCheckOverrides(root, 'spir')?.tests?.skip).toBe(true);
      },
    );
  });

  it('ignores a malformed byProtocol rather than throwing', () => {
    withConfig(
      { porch: { checks: { build: { command: './x.sh' } }, byProtocol: 'nonsense' } },
      root => {
        expect(loadCheckOverrides(root, 'spir')).toEqual({ build: { command: './x.sh' } });
      },
    );
  });

  it('returns the flat map unchanged when no protocol is named', () => {
    // Every existing caller passed no protocol; none of them may change behaviour.
    withConfig(
      {
        porch: {
          checks: { build: { command: './render.sh' } },
          byProtocol: { bugfix: { checks: { regression_test: { skip: true } } } },
        },
      },
      root => {
        expect(loadCheckOverrides(root)).toEqual({ build: { command: './render.sh' } });
      },
    );
  });
});
