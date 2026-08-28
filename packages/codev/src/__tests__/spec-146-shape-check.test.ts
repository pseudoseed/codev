/**
 * Spec 146, Phase 1 — tests for `shapeCheck` itself.
 *
 * The first cut of this phase tested the generated *artifacts* thoroughly and the
 * checker not at all. All three review lanes caught that independently, and they
 * were right: the checker had a defect that made it return `matches: true` at 105
 * `$ref` positions, and no test could have noticed.
 *
 * So these tests are weighted towards the ways a checker can lie — passing on
 * something it never examined — rather than towards the happy path.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shapeCheck,
  describeMismatches,
  UnsupportedKeywordError,
  UnresolvedRefError,
} from '../../../types/src/t3/shape-check.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const generated = join(repoRoot, 'packages', 'types', 'src', 't3', 'generated');
const document = JSON.parse(readFileSync(join(generated, 'schema.json'), 'utf8'));
const defs = document.$defs as Record<string, Record<string, unknown>>;
const schemas = document.schemas as Record<string, Record<string, unknown>>;

describe('shapeCheck: refuses to pass what it did not check', () => {
  it('throws on an unresolvable $ref instead of reporting a match', () => {
    // The exact defect that shipped: a $ref with nothing behind it. Walking past
    // it finds no constraints and reports success on literally any value.
    expect(() => shapeCheck({ anything: true }, { $ref: '#/$defs/Missing' }, {})).toThrow(
      UnresolvedRefError,
    );
  });

  it('throws on a JSON Schema keyword it does not implement', () => {
    expect(() => shapeCheck('x', { type: 'string', pattern: '^a' })).toThrow(UnsupportedKeywordError);
  });

  it('names the offending keyword and path in the error', () => {
    try {
      shapeCheck({ a: 1 }, { type: 'object', properties: { a: { type: 'integer', multipleOf: 2 } } });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedKeywordError);
      expect((error as UnsupportedKeywordError).keyword).toBe('multipleOf');
      expect((error as UnsupportedKeywordError).path).toBe('/a');
    }
  });
});

describe('shapeCheck: $ref resolution', () => {
  it('follows a $ref into the defs pool and applies its constraints', () => {
    const pool = { Thing: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } };
    expect(shapeCheck({ id: 'x' }, { $ref: '#/$defs/Thing' }, pool).matches).toBe(true);

    const bad = shapeCheck({ id: 42 }, { $ref: '#/$defs/Thing' }, pool);
    expect(bad.matches).toBe(false);
    expect(bad.mismatches[0]).toMatchObject({ path: '/id', expected: 'string', actual: 'integer' });
  });

  it('terminates on a self-referential schema rather than recursing forever', () => {
    const pool = {
      Node: {
        type: 'object',
        properties: { child: { $ref: '#/$defs/Node' } },
      },
    };
    expect(() => shapeCheck({ child: { child: {} } }, { $ref: '#/$defs/Node' }, pool)).not.toThrow();
  });
});

describe('shapeCheck: primitives and structure', () => {
  it('distinguishes integer from number in the right direction', () => {
    expect(shapeCheck(1, { type: 'integer' }).matches).toBe(true);
    expect(shapeCheck(1, { type: 'number' }).matches).toBe(true);
    // An integer satisfies number; 1.5 must not satisfy integer.
    expect(shapeCheck(1.5, { type: 'integer' }).matches).toBe(false);
  });

  it('treats null as its own type, not as an object', () => {
    expect(shapeCheck(null, { type: 'null' }).matches).toBe(true);
    expect(shapeCheck(null, { type: 'object' }).matches).toBe(false);
  });

  it('treats an array as an array, not as an object', () => {
    expect(shapeCheck([], { type: 'array' }).matches).toBe(true);
    expect(shapeCheck([], { type: 'object' }).matches).toBe(false);
  });

  it('reports a missing required property', () => {
    const schema = { type: 'object', required: ['a', 'b'], properties: { a: {}, b: {} } };
    const result = shapeCheck({ a: 1 }, schema);
    expect(result.matches).toBe(false);
    expect(result.mismatches).toContainEqual({ path: '/b', expected: 'present (required)', actual: 'missing' });
  });

  it('rejects additional properties when the schema forbids them', () => {
    const schema = { type: 'object', additionalProperties: false, properties: { a: { type: 'integer' } } };
    expect(shapeCheck({ a: 1 }, schema).matches).toBe(true);
    expect(shapeCheck({ a: 1, b: 2 }, schema).matches).toBe(false);
  });

  it('checks every element of an array, not just the first', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    const result = shapeCheck(['a', 'b', 3], schema);
    expect(result.matches).toBe(false);
    expect(result.mismatches[0].path).toBe('/2');
  });

  it('enforces enum membership', () => {
    const schema = { type: 'string', enum: ['web', 'desktop'] };
    expect(shapeCheck('web', schema).matches).toBe(true);
    expect(shapeCheck('mobile', schema).matches).toBe(false);
  });

  it('applies minimum, maximum and length bounds where they survived emission', () => {
    expect(shapeCheck(-1, { type: 'integer', minimum: 0 }).matches).toBe(false);
    expect(shapeCheck(0, { type: 'integer', minimum: 0 }).matches).toBe(true);
    expect(shapeCheck('', { type: 'string', minLength: 1 }).matches).toBe(false);
  });

  it('accepts a union when any branch matches, and reports when none does', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    expect(shapeCheck('x', schema).matches).toBe(true);
    expect(shapeCheck(null, schema).matches).toBe(true);
    expect(shapeCheck(7, schema).matches).toBe(false);
  });
});

describe('shapeCheck: against the real generated contract', () => {
  it('accepts the worktree payload the spike actually sent', () => {
    // Taken from the proven spike, so this is a payload the live server accepted.
    const payload = { cwd: '/repo', refName: 'HEAD', newRefName: 'branch-1', path: null };
    const result = shapeCheck(payload, schemas.VcsCreateWorktreeInput, defs);
    expect(describeMismatches(result)).toBe('');
    expect(result.matches).toBe(true);
  });

  it('rejects that payload with a required field removed', () => {
    const result = shapeCheck({ refName: 'HEAD', path: null }, schemas.VcsCreateWorktreeInput, defs);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.path === '/cwd')).toBe(true);
  });

  it('runs every generated schema without throwing, proving no dangling refs remain', () => {
    // If any $ref in any generated schema were unresolvable, this throws. That is
    // the regression guard for the defect all three reviewers found.
    for (const [name, schema] of Object.entries(schemas)) {
      expect(() => shapeCheck({}, schema, defs), `${name} has an unresolvable ref`).not.toThrow(
        UnresolvedRefError,
      );
    }
  });

  it('is honest that a pass is weaker than the contract', () => {
    // `cwd` is TrimmedNonEmptyString upstream: the server rejects "". The emitted
    // schema lost that constraint, so the shape check accepts it. Asserting the
    // weakness here means nobody can later mistake `matches` for validity.
    const result = shapeCheck(
      { cwd: '', refName: 'HEAD', path: null },
      schemas.VcsCreateWorktreeInput,
      defs,
    );
    expect(result.matches).toBe(true);
  });
});
