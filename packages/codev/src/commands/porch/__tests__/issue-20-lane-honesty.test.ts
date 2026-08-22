/**
 * Issue #20 — a review lane that never ran must not read as an approval.
 *
 * `parseVerdict` returns COMMENT both when a reviewer wrote COMMENT and when it
 * wrote no verdict line at all, and `allApprove` counts COMMENT as approval. A
 * skipped lane therefore joined a "unanimous" approval, and the gate message
 * said "All reviewers approved!" over a run one reviewer never looked at.
 *
 * The blocking behaviour is deliberately UNCHANGED. A lane that is
 * unauthenticated or quota-exhausted must not wedge a project — that was the
 * explicit call. What was wrong was the record, not the flow control. These
 * tests pin both halves: still non-blocking, no longer called an approval.
 */

import { describe, it, expect } from 'vitest';
import { parseVerdict, findVerdict, statedVerdict, allApprove, laneSummary } from '../verdict.js';
import type { ReviewResult } from '../types.js';

/** What the agy lane writes when it skips. */
const SKIP_ARTIFACT = `---
VERDICT: COMMENT
SUMMARY: Gemini lane skipped — agy exited with code 1
CONFIDENCE: LOW
---

The Gemini (Antigravity \`agy\`) reviewer was skipped: agy exited with code 1.

THIS LANE DID NOT REVIEW ANYTHING.
`;

/** A real review that happens to conclude COMMENT. */
const REAL_COMMENT = `I read the diff and the surrounding code. Two nits, neither blocking.
The naming in the new helper could be clearer but it is correct as written.

VERDICT: COMMENT
SUMMARY: Minor nits only.
CONFIDENCE: HIGH
`;

/** A lane that produced prose and then died before stating a verdict. */
const NO_VERDICT = `I'll read the diff and the surrounding code.
Reading packages/codev/src/commands/porch/index.ts...
Reading the role docs...
`;

function review(model: string, output: string): ReviewResult {
  return {
    model,
    verdict: parseVerdict(output),
    file: `/tmp/${model}.txt`,
    stated: statedVerdict(output),
  };
}

describe('#20: telling a stated verdict from a defaulted one', () => {
  it('a skip artifact and a real COMMENT parse to the SAME verdict', () => {
    // This is the whole problem in one assertion. Both are COMMENT, so
    // downstream code that sees only the verdict cannot tell them apart.
    expect(parseVerdict(SKIP_ARTIFACT)).toBe('COMMENT');
    expect(parseVerdict(REAL_COMMENT)).toBe('COMMENT');
  });

  it('but statedVerdict separates a verdict-less review from a real one', () => {
    expect(statedVerdict(REAL_COMMENT)).toBe(true);
    expect(statedVerdict(NO_VERDICT)).toBe(false);
  });

  it('a skip artifact DOES state COMMENT — it is honest about its own verdict', () => {
    // Worth pinning: the artifact is not lying. The defect was downstream,
    // where COMMENT was read as approval regardless of what produced it.
    expect(findVerdict(SKIP_ARTIFACT)).toBe('COMMENT');
  });
});

describe('#20: blocking behaviour is unchanged', () => {
  it('a skipped lane still does NOT block the run', () => {
    // Deliberate. An unauthenticated or quota-exhausted lane wedging every
    // project is worse than the reporting bug this issue is about.
    const reviews = [
      review('claude', 'x'.repeat(60) + '\nVERDICT: APPROVE\n'),
      { model: 'gemini', verdict: parseVerdict(SKIP_ARTIFACT), file: '/tmp/g.txt', stated: false },
    ];
    expect(allApprove(reviews)).toBe(true);
  });

  it('REQUEST_CHANGES still blocks', () => {
    const reviews = [
      review('claude', 'x'.repeat(60) + '\nVERDICT: APPROVE\n'),
      review('codex', 'x'.repeat(60) + '\nVERDICT: REQUEST_CHANGES\n'),
    ];
    expect(allApprove(reviews)).toBe(false);
  });
});

describe('#20: the sentence a human reads before approving a gate', () => {
  it('does NOT claim approval when a lane produced no verdict', () => {
    const reviews = [
      review('claude', 'x'.repeat(60) + '\nVERDICT: APPROVE\n'),
      review('codex', 'x'.repeat(60) + '\nVERDICT: APPROVE\n'),
      review('gemini', NO_VERDICT),
    ];

    const s = laneSummary(reviews);

    expect(s.ran).toBe(2);
    expect(s.total).toBe(3);
    expect(s.silent).toEqual(['gemini']);
    expect(s.sentence).toMatch(/2 of 3/);
    expect(s.sentence).toMatch(/NOT as approval/);
  });

  it('names WHICH lanes were silent, so the gap is in the record', () => {
    // The gap used to be visible only as a missing file nobody was looking for.
    const reviews = [
      review('claude', 'x'.repeat(60) + '\nVERDICT: APPROVE\n'),
      review('codex', NO_VERDICT),
      review('gemini', NO_VERDICT),
    ];

    expect(laneSummary(reviews).sentence).toMatch(/codex, gemini/);
  });

  it('says plainly that all lanes approved when they actually did', () => {
    const reviews = [
      review('claude', 'x'.repeat(60) + '\nVERDICT: APPROVE\n'),
      review('codex', 'x'.repeat(60) + '\nVERDICT: APPROVE\n'),
    ];

    const s = laneSummary(reviews);
    expect(s.silent).toHaveLength(0);
    expect(s.sentence).toMatch(/2 of 2 lanes reviewed and approved/);
  });

  it('counts a genuine COMMENT as a lane that RAN', () => {
    // A reviewer that read the code and concluded "nits only" reviewed it.
    // Only an absent verdict is a silent lane.
    const reviews = [
      review('claude', 'x'.repeat(60) + '\nVERDICT: APPROVE\n'),
      review('codex', REAL_COMMENT),
    ];

    expect(laneSummary(reviews).silent).toHaveLength(0);
  });

  it('treats an unrecorded `stated` as ran, not as silent', () => {
    // Backward compatibility: reviews in existing status.yaml files predate the
    // field. Absent provenance must not retroactively accuse them.
    const reviews: ReviewResult[] = [
      { model: 'claude', verdict: 'APPROVE', file: '/tmp/a.txt' },
      { model: 'codex', verdict: 'COMMENT', file: '/tmp/b.txt' },
    ];

    expect(laneSummary(reviews).silent).toHaveLength(0);
  });
});
