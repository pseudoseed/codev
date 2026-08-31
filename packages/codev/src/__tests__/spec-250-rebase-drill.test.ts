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
   * THE DOCUMENTED VOCABULARY AND THE ASSIGNABLE ONE, HELD TOGETHER.
   *
   * Both review lanes found the same defect in iteration 1: the header defined
   * `ok` as "rebase clean, contract regenerated, shape-check held" and listed
   * `regenerate-failed` and `shape-check-failed` beside it, while the code
   * assigned neither and ran neither tool. A comment claimed what nothing
   * checked, on the tool whose whole subject is that distinction.
   *
   * A prose fix alone cannot fail. This reads the file: every outcome the header
   * documents must be one the code can assign, and every outcome the code can
   * assign must be documented. Re-adding an unreachable state to either side
   * fails here — which is the check that was missing when it was added.
   */
  it('documents exactly the outcomes it can assign, and no others', () => {
    const source = readFileSync(join(repoRoot, 'tools', 't3-fork', 'rebase-drill.mjs'), 'utf8');
    const header = source.split('*/')[0];
    const documented = [...header.matchAll(/^ \*   ([a-z][a-z-]*)  +\S/gm)].map((m) => m[1]);
    const assigned = [
      ...source.matchAll(/outcome:\s*'([a-z-]+)'/g),
      ...source.matchAll(/outcome\s*=\s*'([a-z-]+)'/g),
    ].map((m) => m[1]);

    // A regex that matched nothing would make the comparison trivially true.
    expect(documented.length).toBeGreaterThan(0);
    expect(assigned.length).toBeGreaterThan(0);
    expect([...new Set(documented)].sort()).toEqual([...new Set(assigned)].sort());
  });

  /**
   * WHAT THE DRILL DID NOT DO, ASSERTED AS A STATED FACT.
   *
   * `generate.mjs` refuses a checkout whose HEAD is not `pin.commit`, so no
   * rebased tree can be regenerated from without moving the pin — the adoption
   * this drill exists not to perform. That makes "shape-check did not run" a
   * permanent property of the evidence, and an absent field would read as
   * nobody having considered it. If the drill ever does regenerate, this test
   * fails and the evidence prose has to be rewritten with it.
   */
  it('records that regeneration and shape-check did not run, with the reason', () => {
    expect(evidence.contractRegeneration?.attempted).toBe(false);
    expect(typeof evidence.contractRegeneration.reason).toBe('string');
    expect(evidence.contractRegeneration.reason.length).toBeGreaterThan(80);
  });

  /**
   * THE MEASUREMENT THAT REPLACES THE CLAIM.
   *
   * `regenerationReachable` only says the generator would FIND its source. This
   * says whether that source still hashes to what the vendored contract came
   * from, using the layer `generate.mjs` names as its load-bearing detector.
   *
   * The ordering inside the drill is what makes it able to fail: the hash is
   * taken off the merged worktree, before `merge --abort`. Taken afterwards the
   * worktree is the fork again and `moved` is `[]` on every run — verified by
   * hashing the unmerged fork, which reports exactly that. So a non-empty
   * `moved` here is evidence the measurement is reading the merged tree.
   */
  it('measures the closure off the merged tree rather than the fork against itself', () => {
    const sourceHash = evidence.contractClosure?.sourceHash;
    expect(sourceHash?.checked).toBe(true);
    expect(sourceHash.comparedTo).toBe(pin.commit);
    expect(Object.keys(sourceHash.files)).toEqual(pin.closure);
    expect(Array.isArray(sourceHash.moved)).toBe(true);
    for (const file of sourceHash.moved as string[]) {
      expect(pin.closure).toContain(file);
    }
    // Upstream moved 5 closure-touching commits in this range, so a `moved` of
    // zero would mean the hash was taken after the abort — the tautology.
    if ((evidence.upstreamChurn?.closureTouching ?? 0) > 0) {
      expect(sourceHash.moved.length).toBeGreaterThan(0);
    }
  });

  /**
   * The churn numbers were prose in the first draft of the evidence — the rot
   * the collector exists to stop. Counted from the preserved clone over the same
   * range the drill rebased across, so the two can never describe different
   * ranges, and `null` (could not count) is not 0 (nothing to count).
   */
  it('counts upstream churn over the range it rebased across', () => {
    expect(typeof evidence.upstreamChurn?.commits).toBe('number');
    expect(typeof evidence.upstreamChurn.closureTouching).toBe('number');
    expect(evidence.upstreamChurn.commits).toBeGreaterThan(0);
    expect(evidence.upstreamChurn.closureTouching).toBeGreaterThan(0);
    expect(evidence.upstreamChurn.closureTouching)
      .toBeLessThanOrEqual(evidence.upstreamChurn.commits);
    expect(evidence.upstreamChurn.range)
      .toBe(`${evidence.base.slice(0, 12)}..${evidence.target.slice(0, 12)}`);
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
