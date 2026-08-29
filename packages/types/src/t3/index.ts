/**
 * Spec 146 — the vendored t3code contract.
 *
 * Everything under `generated/` is emitted by `tools/t3-codegen` from a t3code
 * checkout pinned in `pin.json`. Do not hand-edit it; run the refresh procedure
 * in `tools/t3-codegen/REFRESH.md`.
 *
 * Two things a consumer must know before using any of this:
 *
 * 1. **The generated types and schema diverge from the contract in BOTH
 *    directions.** `generated/LOSSY.md` lists every schema whose constraints did
 *    not survive emission — every branded id among them — so the check is weaker
 *    there. But the emitted schema also carries `additionalProperties: false` on
 *    239 nodes while t3code decodes with `onExcessProperty: "ignore"`, so a
 *    literal reading would be *stricter* there. `shapeCheck` ignores excess by
 *    default to mirror the decoder. Matching the shape is not the same as being
 *    acceptable to the server, and neither is failing to match.
 *
 * 2. **Drift is caught by `generated/source-hash.json`, not by the schema.** A
 *    relaxed branded id upstream would not change one byte of the emitted
 *    output. The hash is the detector; the schema diff is the explainer.
 */

export type { ShapeCheckResult, ShapeMismatch } from './shape-check.js';
export {
  shapeCheck,
  describeMismatches,
  UnsupportedKeywordError,
  // Exported because a caller must be able to CATCH it. shapeCheck throws this
  // rather than matching when a `$ref` will not resolve, and a consumer that
  // cannot name the error cannot distinguish it from a genuine mismatch.
  UnresolvedRefError,
} from './shape-check.js';
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
