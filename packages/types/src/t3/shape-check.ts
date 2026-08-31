/**
 * Spec 146 — a shape check over the generated t3code JSON Schema.
 *
 * IT IS CALLED `shape-check` AND NOT `validate` ON PURPOSE.
 *
 * The generated schema is a **lower bound** on t3code's own validation, never an
 * equivalent. `toJsonSchemaDocument` drops checks applied on the decoded side of
 * a `decodeTo` transform, and `TrimmedNonEmptyString` is exactly that shape — so
 * every branded id in the contract (`ThreadId`, `ProjectId`, `CommandId`,
 * `TurnId`, `MessageId`, …) emits as an unconstrained string. Every such schema is
 * listed in `generated/LOSSY.md`, which the generator writes — count deliberately
 * not repeated here, because a hardcoded one goes stale the moment upstream moves.
 *
 * A pass therefore means "matches the emitted shape". It does NOT mean the server
 * will accept the payload, and no call site may treat it as though it does. That
 * is why the result type is `ShapeCheckResult` with a `matches` field rather than
 * a boolean named `valid`.
 *
 * IT DIVERGES IN BOTH DIRECTIONS, NOT ONE.
 *
 * The docs above and in `index.ts` used to say only "lower bound", which was half
 * the truth and the more comfortable half. The emitted schema carries
 * `additionalProperties: false` on 239 nodes, while t3code decodes with Effect's
 * default `onExcessProperty: "ignore"` (`SchemaAST.ts:446`) — the server *strips*
 * unknown keys rather than rejecting them. So on excess properties this check is
 * STRICTER than the server, not weaker.
 *
 * That matters concretely: an additive upstream field — the change class the churn
 * classifier calls non-breaking — would make a naive strict check reject a payload
 * the server legitimately sent. So excess properties are **ignored by default**,
 * mirroring the decoder. Pass `{ excess: 'error' }` to opt into strictness, which
 * is reasonable for outbound payloads Codev itself constructs and never for
 * inbound ones.
 *
 * Zero imports, by design: this file ships inside `@cluesmith/codev-types`, which
 * has no runtime dependencies and must keep none (#1189).
 */

export interface ShapeMismatch {
  /** JSON Pointer-ish path to the offending value, e.g. `/message/text`. */
  readonly path: string;
  /** What the schema wanted. */
  readonly expected: string;
  /** What was actually there. */
  readonly actual: string;
}

export interface ShapeCheckResult {
  /**
   * True when the value matches the emitted shape. Deliberately not named
   * `valid`: the emitted shape is weaker than the contract (see LOSSY.md).
   */
  readonly matches: boolean;
  readonly mismatches: ReadonlyArray<ShapeMismatch>;
}

/**
 * Thrown when the schema uses a keyword this checker does not implement.
 *
 * Silently ignoring an unknown keyword would report "matches" for a constraint
 * that was never checked, which is the failure this whole module exists to avoid:
 * "I could not tell" must never be spelled the same way as "yes".
 */
export class UnsupportedKeywordError extends Error {
  constructor(
    readonly keyword: string,
    readonly path: string,
  ) {
    super(
      `shape-check does not implement JSON Schema keyword "${keyword}" (at ${path || '/'}). ` +
        `Refusing to report a match for a constraint that was not checked. ` +
        `Implement it in shape-check.ts, or narrow the generated schema.`,
    );
    this.name = 'UnsupportedKeywordError';
  }
}

/**
 * Thrown when a `$ref` cannot be resolved.
 *
 * This is its own error because an unresolvable `$ref` is the worst possible
 * silent pass: the checker would walk into an empty schema, find nothing to
 * check, and report a match. The generator emitted 105 dangling `$ref`s once and
 * this checker reported every payload valid. It throws now.
 */
export class UnresolvedRefError extends Error {
  constructor(
    readonly ref: string,
    readonly path: string,
  ) {
    super(
      `shape-check could not resolve "${ref}" (at ${path || '/'}). ` +
        `Pass the generated $defs as the third argument to shapeCheck. ` +
        `Refusing to report a match for a schema that was never loaded.`,
    );
    this.name = 'UnresolvedRefError';
  }
}

/** Every keyword the generator is known to emit. Anything else throws. */
const SUPPORTED = new Set([
  'type',
  'enum',
  'anyOf',
  'oneOf',
  'allOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  '$ref',
  'description',
  'title',
]);

type JsonSchema = Record<string, unknown>;
type Defs = Record<string, JsonSchema>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t;
}

function assertKnownKeywords(schema: JsonSchema, path: string): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new UnsupportedKeywordError(keyword, path);
  }
}

function check(
  value: unknown,
  schema: JsonSchema,
  path: string,
  out: ShapeMismatch[],
  defs: Defs,
  seen: ReadonlySet<string>,
  excess: 'ignore' | 'error',
): void {
  assertKnownKeywords(schema, path);

  // Resolve before anything else. A `$ref` node carries no constraints of its
  // own, so continuing past it means checking nothing and reporting a match.
  if (typeof schema.$ref === 'string') {
    const key = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(schema.$ref)?.[1];
    const target = key ? defs[key] : undefined;
    if (!target) throw new UnresolvedRefError(schema.$ref, path);
    // A self-referential schema is legal; re-entering it on the same value is not.
    if (!seen.has(key as string)) {
      check(value, target, path, out, defs, new Set([...seen, key as string]), excess);
    }
    return;
  }

  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (branches) {
    const anyMatched = branches.some((branch) => {
      const scratch: ShapeMismatch[] = [];
      check(value, branch, path, scratch, defs, seen, excess);
      return scratch.length === 0;
    });
    if (!anyMatched) {
      out.push({ path, expected: `one of ${branches.length} variants`, actual: typeOf(value) });
    }
    return;
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as JsonSchema[]) check(value, sub, path, out, defs, seen, excess);
  }

  if (Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).some((allowed) => allowed === value)) {
      out.push({
        path,
        expected: (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | '),
        actual: JSON.stringify(value) ?? typeOf(value),
      });
      return;
    }
  }

  if (typeof schema.type === 'string') {
    const actual = typeOf(value);
    // An integer is an acceptable number; the reverse is not true.
    const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!ok) {
      out.push({ path, expected: schema.type, actual });
      return;
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push({ path, expected: `>= ${schema.minimum}`, actual: String(value) });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push({ path, expected: `<= ${schema.maximum}`, actual: String(value) });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push({ path, expected: `minLength ${schema.minLength}`, actual: `length ${value.length}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      out.push({ path, expected: `maxLength ${schema.maxLength}`, actual: `length ${value.length}` });
    }
  }

  if (Array.isArray(value)) {
    /**
     * Spec 250 phase 5. The generator emits these for a bounded array — the gate
     * payload's one-to-five choices is the first schema in the vendored closure
     * to have them — and an unimplemented keyword THROWS rather than passing, so
     * without this every check of that payload raised `UnsupportedKeywordError`
     * instead of returning a result. Implementing them makes the checker report
     * on a constraint it previously refused to look at; it is not a loosening,
     * and it changes nothing for any schema that does not carry them.
     */
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push({ path, expected: `minItems ${schema.minItems}`, actual: `length ${value.length}` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      out.push({ path, expected: `maxItems ${schema.maxItems}`, actual: `length ${value.length}` });
    }
    if (schema.items) {
      value.forEach((item, index) => check(item, schema.items as JsonSchema, `${path}/${index}`, out, defs, seen, excess));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;

    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) {
        out.push({ path: `${path}/${key}`, expected: 'present (required)', actual: 'missing' });
      }
    }

    for (const [key, sub] of Object.entries(properties)) {
      if (key in record) check(record[key], sub, `${path}/${key}`, out, defs, seen, excess);
    }

    // Default 'ignore' mirrors the server's decoder. Enforcing this by default
    // would reject payloads t3code accepts — the inverse of the stated invariant.
    if (excess === 'error' && schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          out.push({ path: `${path}/${key}`, expected: 'no additional properties', actual: 'present' });
        }
      }
    }
  }
}

/**
 * Check a value against one schema from the generated document.
 *
 * Throws `UnsupportedKeywordError` for a keyword it does not implement, and
 * `UnresolvedRefError` for a `$ref` it cannot follow. Both are refusals to report
 * a match for something that was never checked.
 *
 * @param defs the generated `$defs` pool. Required whenever the schema contains
 *   a `$ref`, which most of the generated payload schemas do.
 */
export interface ShapeCheckOptions {
  /**
   * How to treat properties the schema does not name.
   *
   * `'ignore'` (default) mirrors t3code's decoder, which uses Effect's default
   * `onExcessProperty: "ignore"`. `'error'` enforces `additionalProperties: false`
   * and is appropriate only for payloads Codev constructs itself.
   */
  readonly excess?: 'ignore' | 'error';
}

export function shapeCheck(
  value: unknown,
  schema: JsonSchema,
  defs: Defs = {},
  options: ShapeCheckOptions = {},
): ShapeCheckResult {
  const mismatches: ShapeMismatch[] = [];
  check(value, schema, '', mismatches, defs, new Set(), options.excess ?? 'ignore');
  return { matches: mismatches.length === 0, mismatches };
}

/** Render mismatches for an error message, one per line. */
export function describeMismatches(result: ShapeCheckResult): string {
  return result.mismatches
    .map((m) => `  ${m.path || '/'}: expected ${m.expected}, got ${m.actual}`)
    .join('\n');
}
