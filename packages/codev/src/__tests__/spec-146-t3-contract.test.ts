/**
 * Spec 146, Phase 1 — the vendored t3code contract.
 *
 * These live in `packages/codev` rather than `packages/types` because that is
 * where the suite actually runs: the root `test` script is
 * `pnpm --filter @cluesmith/codev test`, and `packages/types` has no test
 * runner. A test placed in `packages/types` would look present and never
 * execute, which is the exact failure mode this spec keeps guarding against.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const typesRoot = join(repoRoot, 'packages', 'types');
const t3Root = join(typesRoot, 'src', 't3');
const generated = join(t3Root, 'generated');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * `schema.json` is a document: `{ $defs, schemas }`. It carries `$defs` because
 * the roots are full of `$ref`s into them — an earlier version emitted the roots
 * alone and left 105 dangling refs.
 */
const readSchemas = () => readJson(join(generated, 'schema.json')).schemas as Record<string, any>;

/**
 * Is a pinned t3code checkout available?
 *
 * The plan requires the live-server-dependent tests to be a SUITE separate from
 * the unit tests, whose absence reports as "skipped for no server" and never as
 * a pass. This constant is that separation: the suite below is gated at the
 * `describe` level, so with no checkout vitest prints one skipped *suite* rather
 * than a green run that silently verified nothing.
 */
const T3_ROOT = process.env.T3CODE_ROOT ?? '/Users/chris/dev/t3code';
const HAS_CHECKOUT = existsSync(join(T3_ROOT, 'packages', 'contracts', 'src'));

describe('spec 146: packages/types stays dependency-free', () => {
  it('declares no runtime dependencies', () => {
    const pkg = readJson(join(typesRoot, 'package.json'));
    // `effect` belongs to the codegen tool alone. If it ever appears here the
    // #1189 boundary is gone and every consumer of the sdk inherits a runtime dep.
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('has no source file under src/t3 importing effect', () => {
    for (const file of ['index.ts', 'shape-check.ts', 'generated/schema.ts']) {
      const src = readFileSync(join(t3Root, file), 'utf8');
      expect(src, `${file} must not import effect`).not.toMatch(/from ['"]effect/);
    }
  });

  it('exposes the ./t3 subpath, without which nothing here is importable', () => {
    const pkg = readJson(join(typesRoot, 'package.json'));
    expect(pkg.exports['./t3']).toBeDefined();
  });
});

describe('spec 146: generated artifacts are present and self-describing', () => {
  const required = [
    'schema.ts',
    'schema.json',
    'methods.json',
    'source-hash.json',
    'types.d.ts',
    'LOSSY.md',
    'UNREPRESENTED.md',
    'ATTRIBUTION.md',
  ];

  it.each(required)('emits %s', (name) => {
    expect(existsSync(join(generated, name))).toBe(true);
  });

  it('carries the MIT notice, because these artifacts ship inside an Apache-2.0 package', () => {
    const pkg = readJson(join(typesRoot, 'package.json'));
    // The obligation only exists because the package is published and ships src/.
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.files).toContain('src');

    const attribution = readFileSync(join(generated, 'ATTRIBUTION.md'), 'utf8');
    expect(attribution).toContain('MIT License');
    expect(attribution).toContain(readJson(join(t3Root, 'pin.json')).commit);
  });

  it('pins every closure file with a hash', () => {
    const pin = readJson(join(t3Root, 'pin.json'));
    const hashes = readJson(join(generated, 'source-hash.json'));
    expect(Object.keys(hashes.files).sort()).toEqual([...pin.closure].sort());
    expect(hashes.commit).toBe(pin.commit);
    for (const [file, digest] of Object.entries(hashes.files)) {
      expect(digest, `${file} hash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('maps every pinned method to a schema that exists', () => {
    const methods = readJson(join(generated, 'methods.json'));
    const schemas = readSchemas();
    expect(Object.keys(methods).length).toBeGreaterThan(0);
    for (const [method, spec] of Object.entries<Record<string, string | null>>(methods)) {
      if (spec.input) expect(schemas[spec.input as string], `${method} input`).toBeDefined();
      if (spec.output) expect(schemas[spec.output as string], `${method} output`).toBeDefined();
    }
  });
});

describe('spec 146: the emitter is lossy, and says so', () => {
  /**
   * This is the finding that shaped Phase 1. `toJsonSchemaDocument` drops checks
   * applied on the decoded side of a `decodeTo` transform, so every branded id
   * degrades to an unconstrained string. If LOSSY.md is ever empty, either the
   * detector broke or upstream changed — and both need a human, because an empty
   * LOSSY.md silently promotes the shape check into something it is not.
   */
  it('records the degraded schemas rather than reporting a clean bill', () => {
    const lossy = readFileSync(join(generated, 'LOSSY.md'), 'utf8');
    expect(lossy).toContain('TrimmedNonEmptyString');
    expect(lossy).toContain('ThreadId');
    expect(lossy).not.toContain('_None detected.');
  });

  it('shows branded ids emitting as bare strings in the schema itself', () => {
    const worktree = readSchemas().VcsCreateWorktreeInput;
    // `cwd` is TrimmedNonEmptyString upstream; here it is an unconstrained string.
    // Asserting the weakness keeps anyone from "fixing" the docs to claim otherwise.
    expect(worktree.properties.cwd).toEqual({ type: 'string' });
  });
});

/**
 * LIVE SUITE — requires a pinned t3code checkout. Skipped as a whole when there
 * is none, so its absence is legible in the run output instead of disappearing
 * into a green unit run.
 */
describe.skipIf(!HAS_CHECKOUT)(`spec 146 [live: needs t3code checkout at ${T3_ROOT}]`, () => {
  it('hashes match the pinned checkout', () => {
    const pin = readJson(join(t3Root, 'pin.json'));
    const contracts = join(T3_ROOT, pin.contractsRoot);
    const hashes = readJson(join(generated, 'source-hash.json'));
    for (const [file, expected] of Object.entries<string>(hashes.files)) {
      const actual = createHash('sha256').update(readFileSync(join(contracts, file))).digest('hex');
      expect(actual, `${file} drifted from the pinned hash`).toBe(expected);
    }
  });
});

describe('spec 146: source-hash is the drift detector the schema cannot be', () => {

  /**
   * The plan's acceptance criterion for the two-layer design: mutate
   * `TrimmedNonEmptyString` to drop its `isNonEmpty` check, and assert the
   * source-hash layer fires while the generated diff stays empty.
   *
   * The probe runs under Node 22 with `effect` (it must emit schemas), which the
   * suite does not, so the measurement is recorded and asserted here. Reproduce:
   *
   *   PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH \
   *     node tools/t3-codegen/transform-blindness-probe.mjs
   */
  it('has recorded evidence that the generated layer alone would miss it', () => {
    const evidencePath = join(repoRoot, 'codev', 'research', '146-transform-blindness-evidence.json');
    const evidence = readJson(evidencePath);

    expect(evidence.ok, 'probe could not run; the recorded evidence is stale').toBe(true);
    expect(evidence.mutation).toContain('isNonEmpty');

    // The whole justification for the second layer, in two assertions.
    expect(evidence.schemaChanged, 'if this is true the emitter improved — revisit the design').toBe(false);
    expect(evidence.hashChanged, 'if this is false BOTH drift layers are broken').toBe(true);
    expect(evidence.verdict).toContain('CONFIRMED');
  });

  it('would not notice a relaxed branded id in the generated schema alone', () => {
    // The regression guard for the whole two-layer design. `TrimmedNonEmptyString`
    // and an unconstrained trimmed string emit the identical document, so a change
    // removing `isNonEmpty` upstream produces a zero-byte diff in schema.json.
    // Only the source hash can catch it. If this ever fails, the emitter improved
    // and the second layer can be reconsidered — until then it is load-bearing.
    const schemas = readSchemas();
    const bareString = JSON.stringify({ type: 'string' });
    const idFields = [
      schemas.VcsCreateWorktreeInput.properties.cwd,
      schemas.VcsCreateWorktreeInput.properties.refName,
    ];
    for (const field of idFields) {
      expect(JSON.stringify(field)).toBe(bareString);
    }
  });
});

describe('spec 146: the harness criterion that gates Phase 2', () => {
  /**
   * The plan makes this explicit: "Phase 2 does not start until this passes,
   * since every one of its acceptance criteria assumes it."
   *
   * The proof needs a live server and Node 22, which this suite has neither of,
   * so the run is recorded and asserted here. Reproduce:
   *
   *   PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH \
   *     node tools/t3-server/smoke.mjs --runs 2
   */
  const evidence = readJson(join(repoRoot, 'codev', 'research', '146-harness-coldstart-evidence.json'));

  it('ran twice, not once — a single run cannot show teardown works', () => {
    expect(evidence.runs.length).toBeGreaterThanOrEqual(2);
  });

  it('dispatched a real command and got Success, not merely an open port', () => {
    for (const run of evidence.runs) {
      expect(run.dispatchExit, `run ${run.run}`).toBe('Success');
      expect(run.dispatchSucceeded, `run ${run.run}`).toBe(true);
    }
  });

  it('left no port bound after teardown, so the second run was genuinely cold', () => {
    // Without this the start-twice proof proves nothing: run 2 would just be
    // talking to the server run 1 left behind.
    for (const run of evidence.runs) {
      expect(run.portFreeAfterStop, `run ${run.run}`).toBe(true);
    }
  });

  it('was run against the commit this repo pins', () => {
    expect(evidence.pinnedCommit).toBe(readJson(join(t3Root, 'pin.json')).commit);
  });

  it('passed every run', () => {
    expect(evidence.allRunsPassed).toBe(true);
  });
});

describe('spec 146: tooling distinguishes "nothing to do" from "it failed"', () => {
  /**
   * Eighth instance of this project's recurring defect, caught by running the
   * documented refresh procedure rather than trusting that I had written it
   * correctly. REFRESH.md step 2 classifies churn since the current pin — and at
   * the pin that range is empty, which is the NORMAL state right after a refresh.
   * The classifier exited 1, so the documented step failed whenever it had
   * nothing to report.
   *
   * Asserted at the source rather than by running the tool, which needs Node 22
   * and a checkout that this suite has neither of.
   */
  it('the churn classifier exits 0 on an empty range', () => {
    const src = readFileSync(
      join(repoRoot, 'tools', 't3-codegen', 'classify-churn.mjs'),
      'utf8',
    );
    const emptyBranch = /no commits touch the closure in that range[\s\S]{0,400}?process\.exit\((\d)\)/.exec(src);
    expect(emptyBranch, 'the empty-range branch should still exist').not.toBeNull();
    expect(emptyBranch?.[1], 'an empty range is not a failure').toBe('0');
  });

  it('the harness keeps a third exit code for "could not determine"', () => {
    // 0 verified, 1 mismatch, 3 could-not-determine. Collapsing 3 into either of
    // the others is what makes a missing checkout read as a passing check.
    const src = readFileSync(join(repoRoot, 'tools', 't3-server', 't3-server.mjs'), 'utf8');
    expect(src).toMatch(/const UNDETERMINED = 3/);
    expect(src).toMatch(/die\(\s*UNDETERMINED/);
  });
});
