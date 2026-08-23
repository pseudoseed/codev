import { describe, it, expect } from 'vitest';
import { parseVerdict, allApprove } from '../verdict';
import { _agySkipContent } from '../../consult/index.js';
import type { ReviewResult } from '../types.js';

/**
 * Phase-progression guarantee for the agy backend (Spec 778).
 *
 * When the Antigravity CLI (`agy`) is missing, unauthenticated, or times out, the
 * gemini consult lane emits a non-blocking skip artifact instead of failing the run.
 * Porch parses that artifact as COMMENT, and `allApprove` treats COMMENT as
 * non-blocking — so a SPIR/ASPIR/BUGFIX phase still advances on the strength of the
 * remaining reviewers (codex + claude). These tests pin that contract end-to-end
 * against the REAL skip artifact, so a regression in either the artifact wording or
 * the verdict parser is caught.
 */
describe('agy skip is non-blocking for porch progression', () => {
  const skipReasons = [
    'agy CLI not found',
    'authentication required (OAuth)',
    'no response before timeout',
  ];

  for (const reason of skipReasons) {
    it(`real skip artifact (${reason}) parses as COMMENT`, () => {
      expect(parseVerdict(_agySkipContent(reason))).toBe('COMMENT');
    });
  }

  it('a 3-way phase with gemini skipped still passes (2-way effective)', () => {
    const reviews: ReviewResult[] = [
      { model: 'gemini', verdict: parseVerdict(_agySkipContent('agy CLI not found')), file: '/tmp/g.md' },
      { model: 'codex', verdict: 'APPROVE', file: '/tmp/c.md' },
      { model: 'claude', verdict: 'APPROVE', file: '/tmp/cl.md' },
    ];
    expect(reviews[0].verdict).toBe('COMMENT');
    expect(allApprove(reviews)).toBe(true);
  });

  it('the skip does NOT mask a genuine REQUEST_CHANGES from another reviewer', () => {
    const reviews: ReviewResult[] = [
      { model: 'gemini', verdict: parseVerdict(_agySkipContent('agy CLI not found')), file: '/tmp/g.md' },
      { model: 'codex', verdict: 'REQUEST_CHANGES', file: '/tmp/c.md' },
      { model: 'claude', verdict: 'APPROVE', file: '/tmp/cl.md' },
    ];
    expect(allApprove(reviews)).toBe(false);
  });

  it('skip artifact is self-describing (names the lane and a remediation that FITS)', () => {
    const content = _agySkipContent('authentication required');
    expect(content).toMatch(/Gemini lane skipped/);
    expect(content).toMatch(/non-blocking/);

    // #25: the remediation is now chosen from the cause. For an auth failure
    // that is "sign in", NOT the install URL — the CLI is plainly installed if
    // it got far enough to reject credentials. The old fixed text advised
    // installing regardless, which for a quota wall was two wrong instructions
    // at once.
    expect(content).toMatch(/sign in/i);
    expect(content).not.toMatch(/antigravity\.google/);
  });

  it('skip artifact declares itself unreviewed in machine-readable form (#20)', () => {
    // The artifact states a real VERDICT: COMMENT, so nothing downstream could
    // tell it from a review that concluded COMMENT — and COMMENT counts toward
    // unanimous approval. A missing verdict cannot signal this; the lane has to
    // say so itself.
    const content = _agySkipContent('authentication required');
    expect(content).toMatch(/VERDICT: COMMENT/);
    expect(content).toMatch(/LANE_DID_NOT_REVIEW: true/);
  });

  it('quota exhaustion gets the quota remedy, not the install or login one', () => {
    const content = _agySkipContent('agy exited with code 1', 'RESOURCE_EXHAUSTED: quota exceeded');
    expect(content).toMatch(/quota|rate limit/i);
    expect(content).not.toMatch(/antigravity\.google/);
  });

  it('an unrecognised failure shows agy output instead of inventing a remedy', () => {
    const content = _agySkipContent('agy exited with code 1', 'Segmentation fault');
    expect(content).toMatch(/Segmentation fault/);
    expect(content).not.toMatch(/sign in|antigravity\.google/i);
  });
});
