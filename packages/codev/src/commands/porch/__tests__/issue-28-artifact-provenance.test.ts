/**
 * Issue #28 — porch handed the consultation a different project's spec.
 *
 * Project 13 is CI forge concepts and runs PIR, which has no spec phase, so it
 * has **no spec at all**. Asked for "spec 13", the resolver's zero-stripping
 * fallback returned `0013-document-os-dependencies.md` — an unrelated 2025
 * document that collides on the number — and the reviewer began reviewing
 * against "Document OS Dependencies".
 *
 * Nothing reported the substitution. `parseVerdict` saw a well-formed
 * `VERDICT:` line and porch counted it. Combined with #20, the review record
 * could read as complete while containing a review of an unrelated spec.
 *
 * The lenient fallback cannot be removed — it is what makes genuinely
 * zero-padded legacy projects resolve. And it cannot be disambiguated by title:
 * a status.yaml title (`add-ci-concepts-to-the-forge-l`) is derived from the
 * issue and does not match the artifact slug (`13-ci-forge-concepts`), so
 * comparing them would reject correct artifacts.
 *
 * What it CAN do is stop hiding that it guessed.
 */

import { describe, it, expect } from 'vitest';
import { findByProjectId, findByProjectIdDetailed } from '../artifacts.js';

const TREE = [
  '0013-document-os-dependencies.md',
  '13-ci-forge-concepts.md',
  '0364-terminal-refresh-button.md',
  '1313-afx-send-mailbox-first.md',
];

describe('#28: exact matches are reported as exact', () => {
  it('prefers the canonical unpadded artifact and calls it exact', () => {
    const m = findByProjectIdDetailed(TREE, '13');
    expect(m.name).toBe('13-ci-forge-concepts.md');
    expect(m.exact).toBe(true);
    expect(m.ambiguousWith).toEqual([]);
  });

  it('does not let 13 reach 1313', () => {
    // The zero-strip collision only goes one way; pinning it so a future
    // "simplification" of the matcher has to notice.
    expect(findByProjectId(TREE, '13')).toBe('13-ci-forge-concepts.md');
  });
});

describe('#28: a fallback match is reported as a guess', () => {
  it('marks a zero-padded-only resolution NOT exact', () => {
    // The real failing case: no `13-*` spec exists, so only `0013-*` remains.
    const specsWithNoCanonical = ['0013-document-os-dependencies.md'];

    const m = findByProjectIdDetailed(specsWithNoCanonical, '13');

    expect(m.name).toBe('0013-document-os-dependencies.md');
    expect(m.exact).toBe(false);
    expect(m.ambiguousWith).toEqual(['0013-document-os-dependencies.md']);
  });

  it('still resolves a genuinely zero-padded legacy project', () => {
    // The reason the fallback exists. Project 364's artifact really is 0364-*,
    // and removing the fallback would break it — hence disclosure, not removal.
    const m = findByProjectIdDetailed(TREE, '364');
    expect(m.name).toBe('0364-terminal-refresh-button.md');
    expect(m.exact).toBe(false);
  });

  it('reports nothing at all when the project has no artifact', () => {
    // "This project has no spec" is a real and common state — PIR projects have
    // none by design. It must be expressible.
    const m = findByProjectIdDetailed(['99-unrelated.md'], '13');
    expect(m.name).toBeUndefined();
    expect(m.exact).toBe(false);
    expect(m.ambiguousWith).toEqual([]);
  });

  it('keeps findByProjectId behaviour identical for existing callers', () => {
    // The detailed form is additive. Every existing lookup must resolve the
    // same file it did before, or this fix breaks artifact resolution
    // everywhere to fix a reporting problem.
    for (const id of ['13', '364', '1313']) {
      expect(findByProjectId(TREE, id)).toBe(findByProjectIdDetailed(TREE, id).name);
    }
  });

  it('handles bugfix-style prefix ids as exact', () => {
    const names = ['bugfix-42-fix-login.md', '42-something-else.md'];
    const m = findByProjectIdDetailed(names, 'bugfix-42');
    expect(m.name).toBe('bugfix-42-fix-login.md');
    expect(m.exact).toBe(true);
  });
});
