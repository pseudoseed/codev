/**
 * Spec 146, Phase 2 — shape-checking inbound payloads.
 *
 * The plan's deliverable: "Payloads are shape-checked on the way in using Phase
 * 1's `shape-check.ts`. A payload that fails is surfaced as a named decode error
 * carrying the method tag and the failing path. It is never coerced and never
 * dropped silently."
 *
 * WHAT A PASS DOES NOT MEAN
 *
 * Phase 1 measured this and the measurement is the reason this file exists at
 * all. The generated schema is a **lower bound** on t3code's validation: every
 * branded id lost its constraint on the way out (`generated/LOSSY.md`), so
 * `shapeCheck` will accept a plain string where the server demands a branded one.
 * It is also, read literally, *stricter* in the other direction —
 * `additionalProperties: false` on 239 nodes against a decoder that runs
 * `onExcessProperty: "ignore"` — which is why `shapeCheck` ignores excess by
 * default, mirroring the decoder rather than the document.
 *
 * So: **a passing shape check is not proof the payload is contract-valid.** It is
 * proof that nothing obviously wrong arrived. Drift that matters is caught by
 * `generated/source-hash.json`, not here.
 *
 * THE THIRD ANSWER, AGAIN
 *
 * Not every method has a generated schema. A method the generator never saw must
 * report **`unchecked`** — never `ok`. "I looked and it was fine" and "I had
 * nothing to look with" are different facts, and collapsing them is the defect
 * this project has spent two phases on. A caller reads `unchecked` off the result
 * and decides; nothing here decides silently on its behalf.
 */

import { shapeCheck, describeMismatches, t3Schemas, t3Defs, t3Methods } from '@cluesmith/codev-types/t3';

/** Which side of the call a payload came from. */
export type PayloadRole = 'input' | 'output';

export type CheckOutcome =
  | { readonly status: 'ok' }
  | {
      /**
       * No generated schema covers this method or role. NOT a pass. The reason is
       * carried so a caller can tell "the generator skipped it" from "the method
       * is not in the contract at all".
       */
      readonly status: 'unchecked';
      readonly reason: string;
    }
  | { readonly status: 'failed'; readonly error: PayloadShapeError };

/**
 * A payload that did not match the generated shape.
 *
 * Carries the method tag and the failing paths, because "a payload was wrong" is
 * not actionable and "`orchestration.subscribeThread` output: /event/sequence
 * expected number, got string" is.
 */
export class PayloadShapeError extends Error {
  constructor(
    readonly method: string,
    readonly role: PayloadRole,
    readonly paths: ReadonlyArray<string>,
    detail: string,
  ) {
    super(
      `t3code ${method} ${role} payload did not match the vendored shape:\n${detail}\n` +
        `  This is a LOWER BOUND on t3code's own validation (see LOSSY.md); a mismatch here is ` +
        `real, but a match would not have proved the payload contract-valid.`,
    );
    this.name = 'PayloadShapeError';
  }
}

// `output` is genuinely `null` for methods the generator found no output schema
// for (`vcs.removeWorktree` is one), so the type says so. tsc caught a narrower
// annotation here, which is the whole reason the cast is spelled out rather than
// hidden behind `as any`.
type ContractEntry = {
  readonly input?: string | null;
  readonly output?: string | null;
  readonly stream?: boolean;
};
const methods = t3Methods as unknown as Record<string, ContractEntry>;
const schemas = t3Schemas as Record<string, unknown>;

/**
 * Check one payload against the generated schema for `method`.
 *
 * Never throws for an unknown method and never throws for a mismatch — both are
 * returned, so the caller chooses where the failure surfaces. `shapeCheck` itself
 * can still throw `UnresolvedRefError` or `UnsupportedKeywordError`; those are
 * bugs in the generated artifacts rather than facts about the payload, and they
 * are deliberately left to propagate.
 */
export function checkPayload(method: string, role: PayloadRole, value: unknown): CheckOutcome {
  const entry = methods[method];
  if (!entry) {
    return {
      status: 'unchecked',
      reason: `no generated contract entry for method '${method}'`,
    };
  }

  const schemaName = role === 'input' ? entry.input : entry.output;
  if (!schemaName) {
    return {
      status: 'unchecked',
      reason: `contract entry for '${method}' names no ${role} schema`,
    };
  }

  const schema = schemas[schemaName];
  if (!schema) {
    return {
      status: 'unchecked',
      reason: `contract names ${role} schema '${schemaName}' for '${method}', but it was not emitted`,
    };
  }

  const result = shapeCheck(value, schema as never, t3Defs as never);
  if (result.matches) return { status: 'ok' };

  return {
    status: 'failed',
    error: new PayloadShapeError(
      method,
      role,
      result.mismatches.map((mismatch: { path: string }) => mismatch.path || '/'),
      describeMismatches(result),
    ),
  };
}

/** Every method the generated contract can check, for callers that want to know up front. */
export function checkableMethods(): ReadonlyArray<string> {
  return Object.keys(methods);
}
