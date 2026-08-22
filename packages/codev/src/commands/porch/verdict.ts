/**
 * Verdict parsing for porch consultation reviews.
 *
 * Extracted from run.ts so it can be shared by next.ts.
 */

import type { Verdict, ReviewResult } from './types.js';

/**
 * The verdict a review explicitly states, or `null` when it states none.
 *
 * Recognises the verdict line in the format:
 *   VERDICT: APPROVE
 *   VERDICT: REQUEST_CHANGES
 *   VERDICT: COMMENT
 *
 * Also handles markdown formatting like:
 *   **VERDICT: APPROVE**
 *   *VERDICT: APPROVE*
 *
 * Split out of `parseVerdict` so a caller can tell "the reviewer said COMMENT" apart from "the
 * reviewer said nothing and COMMENT is what we defaulted to". `parseVerdict` cannot express that
 * difference — both come back as COMMENT, and `allApprove` counts COMMENT as an approval — so a
 * lane that wants to refuse a verdict-less review has to ask this instead (#22).
 */
export function findVerdict(output: string): Verdict | null {
  // Scan lines LAST→FIRST so the actual verdict (at the end) takes priority
  // over template text echoed by codex CLI at the start of output.
  // Skip template lines containing "[" (e.g., "VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]")
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Strip markdown formatting (**, *, __, _, `) and trim
    const stripped = lines[i].trim().replace(/^[\*_`-]+|[\*_`-]+$/g, '').trim().toUpperCase();
    // Match "VERDICT: <value>" but NOT template "VERDICT: [APPROVE | ...]"
    if (stripped.startsWith('VERDICT:') && !stripped.includes('[')) {
      const value = stripped.substring('VERDICT:'.length).trim();
      if (value.startsWith('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
      if (value.startsWith('APPROVE')) return 'APPROVE';
      if (value.startsWith('COMMENT')) return 'COMMENT';
    }
  }
  return null;
}

/**
 * Parse verdict from consultation output.
 *
 * Safety: If no explicit verdict found (empty output, crash, malformed),
 * defaults to REQUEST_CHANGES to prevent proceeding with unverified code.
 */
export function parseVerdict(output: string): Verdict {
  // Empty or very short output = something went wrong
  if (!output || output.trim().length < 50) {
    return 'REQUEST_CHANGES';
  }

  // No valid VERDICT: line found but the consult ran — treat as COMMENT (non-blocking skip)
  return findVerdict(output) ?? 'COMMENT';
}

/**
 * Check if all reviewers approved (unanimity required).
 *
 * Returns true only if ALL reviewers explicitly APPROVE.
 * COMMENT counts as approve (non-blocking feedback).
 * CONSULT_ERROR and REQUEST_CHANGES block approval.
 *
 * Issue #20: a skipped lane stays NON-BLOCKING here on purpose. A lane that is
 * unauthenticated, quota-exhausted, or absent must not wedge a project — that
 * was the explicit design call. What was wrong was calling it an approval in
 * the record. Use `laneSummary` for anything a human or a review file will
 * read, so "3 reviewers approved" is never printed over a run where one of them
 * never looked at the code.
 */
export function allApprove(reviews: ReviewResult[]): boolean {
  if (reviews.length === 0) return true; // No verification = auto-approve
  return reviews.every(r => r.verdict === 'APPROVE' || r.verdict === 'COMMENT');
}

/**
 * Marker a lane writes to declare that it produced no review (#20).
 *
 * A skipped lane's artifact is WELL-FORMED — `agySkipContent` writes a real
 * `VERDICT: COMMENT` line — so the absence of a verdict cannot detect it. The
 * lane has to say so itself. This is a contract between codev's own skip
 * writers and this parser, not an inference from prose.
 */
export const NO_REVIEW_MARKER = 'LANE_DID_NOT_REVIEW: true';

/**
 * Did this review actually state a verdict, or did porch default one for it?
 *
 * `parseVerdict` collapses "the reviewer wrote COMMENT" and "the reviewer wrote
 * no verdict line" into the same COMMENT, and `allApprove` counts COMMENT as an
 * approval. That is how a lane that never ran becomes part of a unanimous
 * approval. `findVerdict` is the distinction; this carries it to callers.
 */
export function statedVerdict(output: string): boolean {
  return findVerdict(output) !== null;
}

/**
 * Did this lane actually review the code?
 *
 * Two ways it did not, and they look nothing alike:
 *   - it stated no verdict at all (crashed, truncated, produced only prose)
 *   - it stated a verdict on an artifact that declares itself a skip
 *
 * The second is the one that mattered in practice: a skipped agy lane writes a
 * perfectly well-formed `VERDICT: COMMENT`, which `allApprove` counts as an
 * approval. Checking only for a missing verdict misses it entirely.
 */
export function laneReviewed(output: string): boolean {
  if (output.includes(NO_REVIEW_MARKER)) return false;
  return statedVerdict(output);
}

/** How many lanes actually produced a verdict, out of how many were asked. */
export interface LaneSummary {
  /** Lanes that stated a verdict of their own. */
  ran: number;
  /** Lanes asked for. */
  total: number;
  /** Lanes that produced no verdict of their own (skipped, crashed, empty). */
  silent: string[];
  /** One line stating exactly what happened, safe to print or commit. */
  sentence: string;
}

/**
 * Describe the lane outcome honestly (#20).
 *
 * "All reviewers approved!" is false whenever a lane was skipped, and it is the
 * sentence a human reads before merging. This produces the sentence that is
 * actually true, naming the silent lanes so the gap is visible in the record
 * rather than inferred from a missing file.
 */
export function laneSummary(reviews: ReviewResult[]): LaneSummary {
  const silent = reviews.filter(r => r.stated === false).map(r => r.model);
  const ran = reviews.length - silent.length;
  const sentence =
    silent.length === 0
      ? `${ran} of ${reviews.length} lanes reviewed and approved.`
      : `${ran} of ${reviews.length} lanes actually reviewed. ` +
        `Did not review: ${silent.join(', ')} — recorded as non-blocking, NOT as approval.`;
  return { ran, total: reviews.length, silent, sentence };
}

