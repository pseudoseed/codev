/**
 * Issues #25, #35, #43 — consult saying the wrong thing when it cannot tell.
 *
 *   #43 A bare `--type pr` failed by naming `codev/consult-types/pr-review.md`,
 *       a path that has never shipped in any release. The reader is being told
 *       to create a file; the actual fix is `--protocol`.
 *   #35 A 0-byte PR diff produced a prompt saying `Changed Files (0)`, and
 *       three lanes returned APPROVE (HIGH) on nothing.
 *   #25 The agy skip artifact ended with "install the CLI and sign in"
 *       regardless of cause — two wrong instructions for a quota wall.
 */

import { describe, it, expect } from 'vitest';
import { agyRemedy } from '../commands/consult/index.js';
import { protocolsProvidingConsultType } from '../lib/skeleton.js';

describe('#43: a protocol-scoped review type must name the real remedy', () => {
  it('finds the protocols that actually ship pr-review.md', () => {
    const owners = protocolsProvidingConsultType('pr-review.md');

    // Whichever tier answers, the answer must be non-empty and must include the
    // protocols this repo ships. If this ever returns [], the error message
    // correctly falls back to the plain not-found rather than guessing.
    expect(owners.length).toBeGreaterThan(0);
    expect(owners).toContain('bugfix');
    expect(owners).toContain('pir');
  });

  it('reports nothing for a review type no protocol provides', () => {
    // "I could not find an owner" must be expressible. Returning a plausible
    // list here would be a second wrong remedy replacing the first.
    expect(protocolsProvidingConsultType('nonsense-review.md')).toEqual([]);
  });

  it('integration-review is NOT protocol-scoped, so it needs no --protocol', () => {
    // The one type that legitimately resolves bare. Pinned so a future change
    // that moves it under protocols/ has to notice.
    expect(protocolsProvidingConsultType('integration-review.md')).toEqual([]);
  });
});

describe('#25: the agy skip remedy must match the actual failure', () => {
  it('does NOT advise installing the CLI when the cause is a quota wall', () => {
    // The CLI is installed. Saying "install it" is a detour, and saying
    // "sign in again" does not refill a quota.
    const remedy = agyRemedy('agy exited with code 1', 'Error: RESOURCE_EXHAUSTED: quota exceeded for model');

    // Asserted against the INSTRUCTION, not the word: the message legitimately
    // says "the CLI is installed and signed in", which is the point being made.
    expect(remedy).not.toMatch(/install the cli|https:\/\/antigravity/i);
    expect(remedy).toMatch(/quota|rate limit/i);
  });

  it('recognises a rate limit by HTTP status alone', () => {
    expect(agyRemedy('agy exited with code 1', 'request failed: 429 Too Many Requests'))
      .toMatch(/quota|rate limit/i);
  });

  it('DOES advise installing when the CLI is genuinely missing', () => {
    expect(agyRemedy('agy CLI not found (install: https://antigravity.google/cli/install.sh)'))
      .toMatch(/install/i);
  });

  it('advises signing in for an auth failure', () => {
    const remedy = agyRemedy('agy exited with code 1', 'Error: 401 Unauthorized — no credentials found');

    expect(remedy).toMatch(/sign in/i);
    expect(remedy).not.toMatch(/install/i);
  });

  it('advises re-running for a timeout', () => {
    expect(agyRemedy('agy timed out producing the review')).toMatch(/time budget|re-run/i);
  });

  it('offers NO remedy for an unrecognised failure', () => {
    // The point of the whole change. A guessed remedy costs more than no
    // remedy, because the reader acts on it. The caller shows agy's raw output
    // instead.
    expect(agyRemedy('agy exited with code 1', 'Segmentation fault')).toBe('');
  });

  it('reads the reason as well as the tail, so a cause named either way is caught', () => {
    expect(agyRemedy('agy quota exhausted', '')).toMatch(/quota|rate limit/i);
  });
});
