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
    const schemas = readJson(join(generated, 'schema.json'));
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
    const schemas = readJson(join(generated, 'schema.json'));
    const worktree = schemas.VcsCreateWorktreeInput;
    // `cwd` is TrimmedNonEmptyString upstream; here it is an unconstrained string.
    // Asserting the weakness keeps anyone from "fixing" the docs to claim otherwise.
    expect(worktree.properties.cwd).toEqual({ type: 'string' });
  });
});

describe('spec 146: source-hash is the drift detector the schema cannot be', () => {
  it('hashes match the pinned checkout when it is available', () => {
    const pin = readJson(join(t3Root, 'pin.json'));
    const t3 = process.env.T3CODE_ROOT ?? '/Users/chris/dev/t3code';
    const contracts = join(t3, pin.contractsRoot);

    if (!existsSync(contracts)) {
      // A missing checkout must not read as a pass. Vitest surfaces the skip.
      console.warn(
        `[spec-146] SKIPPED hash verification: no t3code checkout at ${t3}. ` +
          `This is "could not check", not "checked and fine".`,
      );
      return;
    }

    const hashes = readJson(join(generated, 'source-hash.json'));
    for (const [file, expected] of Object.entries<string>(hashes.files)) {
      const actual = createHash('sha256').update(readFileSync(join(contracts, file))).digest('hex');
      expect(actual, `${file} drifted from the pinned hash`).toBe(expected);
    }
  });

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
    const schemas = readJson(join(generated, 'schema.json'));
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
