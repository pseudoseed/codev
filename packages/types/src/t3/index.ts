/**
 * Spec 146 — the vendored t3code contract.
 *
 * Everything under `generated/` is emitted by `tools/t3-codegen` from a t3code
 * checkout pinned in `pin.json`. Do not hand-edit it; run the refresh procedure
 * in `tools/t3-codegen/REFRESH.md`.
 *
 * Two things a consumer must know before using any of this:
 *
 * 1. **The generated types and schema are a lower bound.** `generated/LOSSY.md`
 *    lists 20 schemas — every branded id in the contract among them — whose
 *    constraints do not survive JSON Schema emission. Matching the shape is not
 *    the same as being acceptable to the server.
 *
 * 2. **Drift is caught by `generated/source-hash.json`, not by the schema.** A
 *    relaxed branded id upstream would not change one byte of the emitted
 *    output. The hash is the detector; the schema diff is the explainer.
 */

export type { ShapeCheckResult, ShapeMismatch } from './shape-check.js';
export { shapeCheck, describeMismatches, UnsupportedKeywordError } from './shape-check.js';
export type * from './generated/types.js';
/**
 * `t3Defs` is exported alongside the schemas because **`shapeCheck` needs it**.
 * The generated payload schemas carry `$ref`s into this pool, and `shapeCheck`
 * throws `UnresolvedRefError` rather than silently matching when it cannot
 * resolve one. Exporting the schemas without the defs would make every
 * ref-carrying schema unusable at the call site — caught in review before
 * Phase 2 consumed it.
 *
 *     shapeCheck(payload, t3Schemas.dispatchCommandInput, t3Defs)
 */
export { t3Schemas, t3Defs, t3Methods } from './generated/schema.js';
