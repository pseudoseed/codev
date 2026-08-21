/**
 * Zero-padded artifact collision (found on project #2).
 *
 * `matchesProjectId` zero-strips both sides, so id `2` matches BOTH `2-foo.md` and
 * `0002-foo.md`. Every lookup used `Array.find`, which resolved that ambiguity by
 * readdir order — i.e. by chance.
 *
 * This fork restarted issue numbering at 1 against a tree carrying legacy artifacts
 * numbered into the 1400s, so the collision is systematic. Concretely: project 2's
 * review resolved to `0002-architect-builder-tick-001.md`, a 2025 TICK review of an
 * unrelated spec, and `review_has_arch_updates` then greped the wrong document — it
 * reported a missing section in a review that was correctly written. Renaming the
 * legacy artifacts was rejected: they are upstream files, and the collision recurs
 * for every id whose zero-padded twin exists.
 *
 * The rule: exact (canonical, no leading zeros — CLAUDE.md) wins; the zero-stripped
 * match stays as a fallback so genuinely zero-padded legacy projects still resolve.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalResolver, matchesProjectIdExact, findByProjectId } from '../artifacts.js';

describe('zero-padded artifact collision (project #2)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-collision-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }

  it('resolves id 2 to the canonical review, not the legacy 0002 one', () => {
    // The exact case that blocked project #2.
    write('codev/reviews/0002-architect-builder-tick-001.md', 'LEGACY TICK REVIEW\n');
    write('codev/reviews/2-harness-model-params.md', '## Architecture Updates\nCANONICAL\n');

    const content = new LocalResolver(root).getReviewContent('2', 'ignored');

    expect(content).toContain('CANONICAL');
    expect(content).not.toContain('LEGACY');
  });

  it('applies to specs and plans too, not just reviews', () => {
    write('codev/specs/0002-architect-builder.md', 'LEGACY\n');
    write('codev/specs/2-harness-model-params.md', 'CANONICAL\n');
    write('codev/plans/0002-architect-builder.md', 'LEGACY\n');
    write('codev/plans/2-harness-model-params.md', 'CANONICAL\n');

    const r = new LocalResolver(root);
    expect(r.getSpecContent('2', 'ignored')).toContain('CANONICAL');
    expect(r.getPlanContent('2', 'ignored')).toContain('CANONICAL');
  });

  it('still finds a zero-padded legacy artifact when nothing canonical exists', () => {
    // The fallback that keeps genuinely zero-padded legacy projects resolving.
    write('codev/reviews/0073-legacy-only.md', 'LEGACY ONLY\n');
    expect(new LocalResolver(root).getReviewContent('73', 'ignored')).toContain('LEGACY ONLY');
  });

  it('is order-independent — the legacy file winning by readdir order was the bug', () => {
    // Assert on both orderings directly, since readdir order is not something the
    // test can pin and was precisely what made the original failure look arbitrary.
    const names = ['0002-architect-builder-tick-001.md', '2-harness-model-params.md'];
    expect(findByProjectId(names, '2')).toBe('2-harness-model-params.md');
    expect(findByProjectId([...names].reverse(), '2')).toBe('2-harness-model-params.md');
  });

  describe('matchesProjectIdExact', () => {
    it('requires literal leading digits, without zero-stripping', () => {
      expect(matchesProjectIdExact('2-foo.md', '2')).toBe(true);
      expect(matchesProjectIdExact('0002-foo.md', '2')).toBe(false);
      expect(matchesProjectIdExact('0002-foo.md', '0002')).toBe(true);
    });

    it('does not match a longer number that merely starts with the id', () => {
      expect(matchesProjectIdExact('20-foo.md', '2')).toBe(false);
      expect(matchesProjectIdExact('1455-foo.md', '145')).toBe(false);
    });

    it('treats prefix-N ids as already exact', () => {
      expect(matchesProjectIdExact('bugfix-237-stale-cache.md', 'bugfix-237')).toBe(true);
      expect(matchesProjectIdExact('bugfix-238-other.md', 'bugfix-237')).toBe(false);
    });
  });
});
