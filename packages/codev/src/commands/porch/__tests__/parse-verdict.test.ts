import { describe, it, expect } from 'vitest';
import { parseVerdict, findVerdict } from '../verdict';

describe('parseVerdict', () => {
  it('returns REQUEST_CHANGES for empty output', () => {
    expect(parseVerdict('')).toBe('REQUEST_CHANGES');
  });

  it('returns REQUEST_CHANGES for short output', () => {
    expect(parseVerdict('ok')).toBe('REQUEST_CHANGES');
  });

  it('parses APPROVE verdict', () => {
    const output = `Some review text here that is long enough to pass the minimum length check.

---
VERDICT: APPROVE
SUMMARY: Looks good
CONFIDENCE: HIGH
---
KEY_ISSUES: None`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('parses REQUEST_CHANGES verdict', () => {
    const output = `Review text that is long enough to pass the minimum length threshold for parsing.

---
VERDICT: REQUEST_CHANGES
SUMMARY: Missing tests
CONFIDENCE: HIGH
---
KEY_ISSUES:
- No unit tests`;
    expect(parseVerdict(output)).toBe('REQUEST_CHANGES');
  });

  it('parses COMMENT verdict', () => {
    const output = `Review text that is long enough to pass the minimum length threshold for parsing.

---
VERDICT: COMMENT
SUMMARY: Minor suggestions
CONFIDENCE: MEDIUM
---`;
    expect(parseVerdict(output)).toBe('COMMENT');
  });

  it('handles markdown-formatted verdict', () => {
    const output = `Review text that is long enough to pass the minimum length threshold for parsing.

**VERDICT: APPROVE**
**SUMMARY: All good**`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('ignores template text with brackets and uses actual verdict', () => {
    // This is the actual bug: codex CLI echoes the prompt template which contains
    // "VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]" before the real verdict.
    const output = `Review Implementation for Project 88

End your review with a verdict in this EXACT format:

---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your review]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---

KEY_ISSUES: [List of critical issues if any, or "None"]

OpenAI Codex v0.63.0 (research preview)
model: gpt-5.1-codex

The implementation looks correct. PORCH_VERSION is exported from version.ts
and imported in run.ts. The test verifies semver format.

---
VERDICT: APPROVE
SUMMARY: Version constant, status output, and tests all align with the spec/plan.
CONFIDENCE: HIGH
---
KEY_ISSUES: None`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('ignores template text echoed TWICE by codex and uses actual verdict', () => {
    // Codex sometimes echoes the template twice (prompt + reasoning)
    const output = `VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary]

Some reasoning here about REQUEST_CHANGES patterns...

VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary]

Actual review content that mentions REQUEST_CHANGES in discussion but the real verdict is below.

---
VERDICT: APPROVE
SUMMARY: All good
CONFIDENCE: HIGH
---`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('last verdict wins when multiple non-template verdicts exist', () => {
    const output = `First pass review - this is long enough to pass the minimum length check for verdict parsing.

VERDICT: REQUEST_CHANGES

After addressing feedback:

VERDICT: APPROVE`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('returns COMMENT when no verdict is found in a long output (ran but no verdict)', () => {
    const output = `Review text that is long enough to pass the minimum length threshold for parsing.
But it does not contain any VERDICT: line because the reviewer went off-task or didn't write one.`;
    expect(parseVerdict(output)).toBe('COMMENT');
  });
});

/**
 * `findVerdict` — "did the reviewer state a verdict?", which `parseVerdict` cannot answer (#22).
 *
 * The distinction matters because of what sits downstream: `allApprove` counts COMMENT as an
 * approval, and `parseVerdict` returns COMMENT both when a reviewer wrote `VERDICT: COMMENT` and
 * when a reviewer wrote no verdict at all. Silence and consent are indistinguishable there.
 *
 * The 50-character floor was the only thing standing between those two cases, and it was a proxy —
 * length standing in for "a review happened". Any lane that prefixes provenance, a banner, a model
 * id or a timestamp clears the floor without reviewing anything. This function measures the thing
 * itself instead.
 */
describe('findVerdict', () => {
  it('returns null when the reviewer stated no verdict', () => {
    expect(findVerdict('Some long review text with no verdict line anywhere in it at all.')).toBeNull();
  });

  it('distinguishes a stated COMMENT from a missing verdict', () => {
    const stated = 'Review text long enough to clear the floor.\n\nVERDICT: COMMENT';
    const missing = 'Review text long enough to clear the floor, but stating nothing.';
    // parseVerdict collapses these two into the same answer; that collapse is the bug.
    expect(parseVerdict(stated)).toBe(parseVerdict(missing));
    expect(findVerdict(stated)).toBe('COMMENT');
    expect(findVerdict(missing)).toBeNull();
  });

  it('ignores a template placeholder, as parseVerdict does', () => {
    expect(findVerdict('VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]')).toBeNull();
  });

  it('reads the LAST verdict, as parseVerdict does', () => {
    expect(findVerdict('VERDICT: REQUEST_CHANGES\n\nlater...\n\nVERDICT: APPROVE')).toBe('APPROVE');
  });

  it('strips markdown emphasis, as parseVerdict does', () => {
    expect(findVerdict('**VERDICT: APPROVE**')).toBe('APPROVE');
  });

  it('leaves parseVerdict behaviour unchanged for short output', () => {
    // The refactor must not move the floor: parseVerdict still shortcuts before consulting this.
    expect(findVerdict('ok')).toBeNull();
    expect(parseVerdict('ok')).toBe('REQUEST_CHANGES');
  });

  it('shows why a provenance header is dangerous without a verdict check', () => {
    // The concrete defect the opencode lane found in its own implementation: a 76-character banner
    // lifts a two-word non-answer over the floor, and REQUEST_CHANGES silently becomes an approval.
    const header = '_Reviewed by the opencode lane — model: `xai/grok-4.6` (shipped default)._\n\n';
    expect(parseVerdict('ok')).toBe('REQUEST_CHANGES');
    expect(parseVerdict(header + 'ok')).toBe('COMMENT');
    // findVerdict is indifferent to length, so it catches what the floor cannot.
    expect(findVerdict(header + 'ok')).toBeNull();
  });
});
