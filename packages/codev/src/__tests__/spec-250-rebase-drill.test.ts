/**
 * Spec 250 phase 11 — the drill's own evidence, checked rather than trusted.
 *
 * The drill writes `codev/research/250-rebase-drill.json`. A committed evidence
 * file is only worth what its checks are worth, and the failure mode here is
 * specific: **an evidence file that says nothing, read as an evidence file that
 * says everything is fine.** So this asserts the shape AND that the run actually
 * ran, and it refuses the two ways a drill can look successful without being.
 *
 * It does not re-run the drill. That takes a scratch clone of a 439MB repository
 * and belongs in the phase, not in every suite run.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const evidence = JSON.parse(
  readFileSync(join(repoRoot, 'codev', 'research', '250-rebase-drill.json'), 'utf8'),
) as Record<string, any>;
const pin = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'types', 'src', 't3', 'pin.json'), 'utf8'),
) as Record<string, any>;

describe('spec 250 phase 11: the rebase drill evidence', () => {
  /**
   * `could-not-run` is the outcome that must never be mistaken for a pass, so it
   * is the first thing asserted rather than a branch inside a later check.
   */
  it('records a run that actually happened', () => {
    expect(evidence.outcome).not.toBe('could-not-run');
    expect(['ok', 'conflicts']).toContain(evidence.outcome);
    expect(typeof evidence.startedAt).toBe('string');
    expect(Number.isNaN(Date.parse(evidence.startedAt))).toBe(false);
  });

  /**
   * THE READ-ONLY ORDER, ASSERTED AGAINST THE EVIDENCE.
   *
   * The drill re-reads both checkouts after it runs. This is what makes that
   * self-check load-bearing rather than decorative: an evidence file recording a
   * moved checkout fails here instead of sitting in the repository looking green.
   */
  it('proves nothing real moved', () => {
    expect(evidence.preserved.upstreamStillAtBase).toBe(true);
    expect(evidence.preserved.upstreamClean).toBe(true);
    expect(evidence.preserved.forkUnmoved).toBe(true);
    expect(evidence.preserved.forkClean).toBe(true);
    expect(evidence.preserved.pinCommitUnchanged).toBe(true);
  });

  /** The drill must describe THIS fork, not a stale one. */
  it('was run against the pinned fork head', () => {
    expect(evidence.forkHead).toBe(pin.commit);
    expect(evidence.base).toBe(pin.upstreamBase);
  });

  /**
   * A drill that carried nothing would report no conflicts and mean nothing.
   * `commitsCarried` is what makes "3 files conflict" a fact about our
   * customization rather than about an empty range.
   */
  it('carried the customization rather than an empty range', () => {
    expect(evidence.commitsCarried).toBeGreaterThan(0);
    expect(evidence.target).not.toBe(evidence.base);
  });

  /**
   * The whole surface is the number that matters, and a rebase stopping at the
   * first conflict always understates it. Asserted as a superset so the two
   * measurements cannot silently disagree.
   */
  it('measures the whole conflict surface, not just where the rebase stopped', () => {
    if (evidence.outcome !== 'conflicts') return;
    expect(Array.isArray(evidence.wholeSurface?.conflictedFiles)).toBe(true);
    for (const file of evidence.conflictedFiles as string[]) {
      expect(evidence.wholeSurface.conflictedFiles).toContain(file);
    }
  });

  /**
   * Whether the vendored contract survives is a different size of problem from
   * whether the customization conflicts somewhere, so it is its own field — and
   * this asserts it was actually computed, not merely absent.
   */
  it('says whether the contract is regenerable after the rebase', () => {
    expect(typeof evidence.contractClosure?.regenerationReachable).toBe('boolean');
    expect(evidence.contractClosure.files).toEqual(
      (pin.closure as string[]).map((file) => `${pin.contractsRoot}/${file}`),
    );
  });

  /**
   * The watermark check replaces "upstream must not have reached 900", which was
   * the wrong invariant: the danger is upstream's migrations being SKIPPED, not
   * upstream taking our number.
   *
   * `checked: false` is a legitimate state and is NOT a pass — asserted here so
   * an unreadable migration directory cannot masquerade as a holding invariant.
   */
  it('re-checks the watermark, and does not count "not checked" as holding', () => {
    expect(evidence.watermark?.checked).toBe(true);
    expect(evidence.watermark.holds).toBe(true);
    expect(evidence.watermark.shadowed).toEqual([]);
    // A real migration must have arrived, or the invariant had nothing to bite
    // on and "holds" would be vacuous.
    expect(evidence.watermark.addedByUpstream.length).toBeGreaterThan(0);
    for (const id of evidence.watermark.addedByUpstream as number[]) {
      expect(id).toBeGreaterThan(evidence.watermark.watermarkAtBase);
    }
  });
});
