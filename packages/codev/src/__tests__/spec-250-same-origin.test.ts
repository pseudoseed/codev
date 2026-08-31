/**
 * Spec 250, phase 10 — the same-origin predicate that the security claim rests on.
 *
 * The Playwright spec asserts that the page never makes a cross-origin request,
 * and THIS function is what decides that. The review found the first version
 * silently unable to fail: it compared with `url.startsWith(origin)`, a prefix
 * match, against a fixed `http://localhost:5733` — so an agent host that landed
 * on ports 57330-57339 (ten ports inside macOS's ephemeral range) would have had
 * a genuinely direct browser-to-agent request counted as same-origin.
 *
 * A rare false PASS on a security claim is worse than a common one: it makes the
 * test look reliable while it is not, and ~0.06% of runs is exactly the rate at
 * which nobody ever sees it fail. Hence a test for the predicate itself.
 */

import { describe, expect, it } from 'vitest';

import { crossOrigin } from './e2e/spec-250-same-origin.js';

const ORIGIN = 'http://localhost:5733';

describe('spec 250 phase 10: the same-origin predicate', () => {
  it('passes same-origin requests through', () => {
    expect(
      crossOrigin(
        [`${ORIGIN}/`, `${ORIGIN}/api/codev/agent/local/api/agent/v1/session`],
        ORIGIN,
      ),
    ).toEqual([]);
  });

  /**
   * THE ONE THE PREFIX MATCH FAILED. `http://localhost:57330` starts with
   * `http://localhost:5733`, so the first version filtered it as same-origin —
   * and it is exactly the shape a direct browser-to-agent request would take,
   * because the agent host binds an ephemeral port.
   */
  it('catches a port that merely starts with the right one', () => {
    for (const port of [57330, 57339, 57331]) {
      expect(crossOrigin([`http://localhost:${port}/api/agent/v1/session`], ORIGIN)).toEqual([
        `http://localhost:${port}/api/agent/v1/session`,
      ]);
    }
  });

  it('catches an ordinary cross-origin request', () => {
    expect(crossOrigin(['http://127.0.0.1:4100/api/agent/v1/session'], ORIGIN)).toEqual([
      'http://127.0.0.1:4100/api/agent/v1/session',
    ]);
    // Same port, different host — the other half of what a prefix match misses.
    expect(crossOrigin(['http://evil.example:5733/x'], ORIGIN)).toEqual([
      'http://evil.example:5733/x',
    ]);
  });

  /**
   * Exempt as a CLASS, not by name. `new URL('data:…').origin` is the string
   * `"null"`, so comparing these by origin would report a false FAILURE — and
   * naming `data:` alone leaves `blob:` and `about:` to break the run later.
   */
  it('ignores schemes that are not requests to another origin', () => {
    expect(
      crossOrigin(
        ['data:image/png;base64,AAAA', 'blob:http://localhost:5733/abc', 'about:blank'],
        ORIGIN,
      ),
    ).toEqual([]);
  });

  it('is case-insensitive about the scheme and handles https', () => {
    expect(crossOrigin(['HTTP://localhost:5733/x'], ORIGIN)).toEqual([]);
    expect(crossOrigin(['https://box.example.ts.net:5733/x'], 'https://box.example.ts.net:5733')).toEqual([]);
  });
});
