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

/**
 * WHICH OF THE TWO SHAPES THIS EVIDENCE HAS.
 *
 * A completed drill produces one of two, and they are NOT the same document.
 * With upstream ahead of our base there is churn, a merged tree, a watermark to
 * check and a closure to hash. With upstream still AT our base the drill returns
 * early: it is a pass — `NO_UPSTREAM_MOVEMENT` — and it legitimately carries
 * `watermark.checked: false`, `contractClosure.checked: false`, zero churn, and
 * no `preserved` block, because nothing was cloned to preserve anything from.
 *
 * The claude lane caught this suite hard-asserting the first shape. A correct
 * zero-movement re-run would have failed three assertions and thrown on a
 * fourth, which is a test failing on a right answer — the mirror of the defect
 * this phase spent two iterations on. So the shape is named once, and each
 * branch asserts its OWN contract rather than being skipped past.
 */
const zeroMovement = evidence.signal === 'NO_UPSTREAM_MOVEMENT';

describe('spec 250 phase 11: the rebase drill evidence', () => {
  /**
   * `could-not-run` is the outcome that must never be mistaken for a pass, so it
   * is the first thing asserted rather than a branch inside a later check.
   */
  it('records a run that actually happened', () => {
    expect(evidence.outcome).not.toBe('could-not-run');
    expect(['ok', 'conflicts']).toContain(evidence.outcome);
    if (!zeroMovement) {
      expect(typeof evidence.startedAt).toBe('string');
      expect(Number.isNaN(Date.parse(evidence.startedAt))).toBe(false);
    }
  });

  /**
   * The two shapes are distinguished by a fact, not by a guess. `signal` and
   * "target equals base" must agree; if they ever disagree, every branch below
   * is keyed on the wrong one and this is where that surfaces.
   */
  it('agrees with itself about which shape it is', () => {
    expect(zeroMovement).toBe(evidence.target === evidence.base);
  });

  /**
   * THE READ-ONLY ORDER, ASSERTED AGAINST THE EVIDENCE.
   *
   * The drill re-reads both checkouts after it runs. This is what makes that
   * self-check load-bearing rather than decorative: an evidence file recording a
   * moved checkout fails here instead of sitting in the repository looking green.
   */
  it.runIf(!zeroMovement)('proves nothing real moved', () => {
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
  it.runIf(!zeroMovement)('carried the customization rather than an empty range', () => {
    expect(evidence.commitsCarried).toBeGreaterThan(0);
    expect(evidence.target).not.toBe(evidence.base);
  });

  /**
   * The whole surface is the number that matters, and a rebase stopping at the
   * first conflict always understates it. Asserted as a superset so the two
   * measurements cannot silently disagree.
   */
  it.runIf(evidence.outcome === 'conflicts')(
    'measures the whole conflict surface, not just where the rebase stopped',
    () => {
      // `it.runIf` rather than an early `return`: a return inside a test body is
      // recorded by vitest as a PASS with zero assertions, which is the shape
      // this whole phase exists to refuse.
      expect(Array.isArray(evidence.wholeSurface?.conflictedFiles)).toBe(true);
      for (const file of evidence.conflictedFiles as string[]) {
        expect(evidence.wholeSurface.conflictedFiles).toContain(file);
      }
    },
  );

  /**
   * Whether the vendored contract survives is a different size of problem from
   * whether the customization conflicts somewhere, so it is its own field — and
   * this asserts it was actually computed, not merely absent.
   */
  it.runIf(!zeroMovement)('says whether the contract is regenerable after the rebase', () => {
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
  it.runIf(!zeroMovement)('regenerates the contract from the rebased tree, and says so', () => {
    const regen = evidence.contractRegeneration;
    expect(regen?.attempted).toBe(true);
    expect(regen.generated).toBe(true);
    // The commit generated from must be one that did not exist before the drill —
    // if it were `pin.commit`, the generator ran against the FORK and the whole
    // answer is the fork compared to itself.
    expect(regen.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(regen.source.commit).not.toBe(pin.commit);
    expect(regen.source.commit).not.toBe(evidence.base);
    expect(regen.source.commit).not.toBe(evidence.target);
    expect(typeof regen.shapeCheckHolds).toBe('boolean');
    expect(Array.isArray(regen.artifactsDiffering)).toBe(true);
    // Every shape artifact reported as moved must also be in the full list; two
    // lists that can disagree are two answers to one question.
    for (const file of regen.shapesDiffering as string[]) {
      expect(regen.artifactsDiffering).toContain(file);
    }
    expect(regen.shapeCheckHolds).toBe(regen.shapesDiffering.length === 0);
  });

  /**
   * `generate.mjs`'s own dangerous case, restated on this path because it is the
   * other place it can occur: the closure source moved and the emitted schema did
   * not. That is NOT "no effect" — every branded id in the contract emits
   * unconstrained, so a relaxed constraint lands here with a zero-byte schema
   * diff. The drill must compute it rather than leave it to a reader.
   */
  it.runIf(!zeroMovement)('computes the hash-moved-shapes-did-not case rather than implying it', () => {
    const regen = evidence.contractRegeneration;
    expect(typeof regen.hashMovedShapesDidNot).toBe('boolean');
    expect(regen.hashMovedShapesDidNot).toBe(
      (regen.artifactsDiffering as string[]).includes('source-hash.json')
        && (regen.shapesDiffering as string[]).length === 0,
    );
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
  it.runIf(!zeroMovement)('measures the closure off the merged tree rather than the fork against itself', () => {
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
  it.runIf(!zeroMovement)('counts upstream churn over the range it rebased across', () => {
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
  it.runIf(!zeroMovement)('re-checks the watermark, and does not count "not checked" as holding', () => {
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

  /**
   * THE OTHER SHAPE, ASSERTED ON ITS OWN TERMS.
   *
   * `NO_UPSTREAM_MOVEMENT` is a pass, and its three "not checked" fields are the
   * right answer rather than a gap: with upstream still at our base there are no
   * new migrations to shadow and no merged tree to hash. What must never happen
   * is those fields going ABSENT, because an absent field reads as an oversight
   * and a `checked: false` with a reason reads as the fact it is.
   *
   * Skipped while the committed evidence is a moved-upstream run, and it reports
   * as skipped rather than as passed.
   */
  it.runIf(zeroMovement)('spells its three vacuous checks as refusals carrying reasons', () => {
    expect(evidence.outcome).toBe('ok');
    expect(evidence.watermark.checked).toBe(false);
    expect(typeof evidence.watermark.reason).toBe('string');
    expect(evidence.contractClosure.checked).toBe(false);
    expect(typeof evidence.contractClosure.reason).toBe('string');
    expect(evidence.upstreamChurn.commits).toBe(0);
    expect(evidence.upstreamChurn.closureTouching).toBe(0);
    // The stated refusal is carried on this path too — it was the one most
    // likely to be forgotten, being an early return. Nothing was rebased and
    // nothing merged, so there is no tree to generate from, and that is spelled
    // differently from "the contract does not regenerate".
    expect(evidence.contractRegeneration.attempted).toBe(false);
    expect(evidence.contractRegeneration.reason).toContain('no tree to generate');
  });
});
