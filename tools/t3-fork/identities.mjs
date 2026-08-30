/**
 * Spec 250, phase 1 — the two vendoring identities, resolved in one place.
 *
 * Spec 146 had one checkout and one meaning, so `T3CODE_ROOT` and `pin.commit`
 * could be read directly by whoever needed them. Spec 250 adds a second checkout
 * with a *different* meaning, and the failure mode that creates is not a missing
 * feature — it is a tool that thinks it is looking at one identity while pointing
 * at the other. `acquire()` checking a fork SHA out into the read-only upstream
 * clone is that failure, and it writes.
 *
 * So the mapping lives here, once, and every tool asks rather than re-deriving:
 *
 *   upstream  the read-only clone of pingdotgg/t3code, pinned at `upstreamBase`.
 *             Every piece of spec 146 and 236 evidence reproduces against it, so
 *             it must never move and nothing here ever writes to it.
 *   fork      our private customization checkout, pinned at `commit`, whose
 *             merge-base with `upstreamBase` must still BE `upstreamBase`.
 *
 * `commit` keeps its spec 146 meaning — "the commit the generated artifacts came
 * from" — and that source becomes the fork from phase 5. Until then the two SHAs
 * are equal, which is deliberate: while they are equal every assertion added here
 * has a known answer, so a harness bug cannot hide inside a real diff.
 */

/** Exit codes, shared so "could not determine" is spelled the same everywhere. */
export const OK = 0;
export const MISMATCH = 1;
export const UNDETERMINED = 3;

export const DEFAULT_UPSTREAM_ROOT = '/Users/chris/dev/t3code';
export const DEFAULT_FORK_ROOT = '/Users/chris/dev/t3code-codev';

export const UPSTREAM_REPO = 'https://github.com/pingdotgg/t3code.git';

/**
 * Resolve both identities from a parsed pin plus the environment.
 *
 * A pin without `upstreamBase` is a pre-250 pin: one checkout, one meaning. It
 * resolves to two identities that happen to name the same commit rather than
 * throwing, because the alternative is that every tool grows a version check.
 * `pin.upstreamBase` absent is not an error; a fork *root* that does not exist is
 * `UNDETERMINED`, and that is a different question answered elsewhere.
 */
export function resolveIdentities(pin, env = process.env) {
  if (!pin || typeof pin.commit !== 'string' || pin.commit === '') {
    throw new Error('pin.json has no `commit`; there is no identity to resolve.');
  }
  const upstreamBase = typeof pin.upstreamBase === 'string' && pin.upstreamBase !== ''
    ? pin.upstreamBase
    : pin.commit;

  return {
    upstream: {
      name: 'upstream',
      root: env.T3CODE_ROOT ?? DEFAULT_UPSTREAM_ROOT,
      rootVar: 'T3CODE_ROOT',
      commit: upstreamBase,
      repo: pin.repo ?? UPSTREAM_REPO,
    },
    fork: {
      name: 'fork',
      root: env.T3CODE_FORK_ROOT ?? DEFAULT_FORK_ROOT,
      rootVar: 'T3CODE_FORK_ROOT',
      commit: pin.commit,
      base: upstreamBase,
      repo: pin.forkRepo ?? null,
      branch: pin.forkBranch ?? null,
      contractSource: contractSource(pin),
    },
    /** True while the fork has not diverged. Phases 1-4 run in this state on purpose. */
    diverged: pin.commit !== upstreamBase,
  };
}

/**
 * Where the VENDORED CONTRACT was generated from — not where the fork checkout is.
 *
 * `pin.commit` means "the vendored contract came from this commit", and only
 * regeneration is allowed to move it. So between the fork's first customization
 * commit and the regeneration that follows, the fork checkout is legitimately
 * AHEAD of `pin.commit`, and that state has to be distinguishable from a fork
 * sitting on the wrong commit.
 *
 * `'upstream'`  the contract has not been regenerated from the fork yet, so a
 *               fork head that DESCENDS from `pin.commit` is expected.
 * `'fork'`      regeneration has happened; the fork head must equal `pin.commit`,
 *               and being ahead is an error like any other mismatch.
 *
 * Absent means `'upstream'`: a pin that has never named a fork cannot have been
 * generated from one.
 */
export function contractSource(pin) {
  const declared = pin?.contractSource;
  if (declared === 'fork' || declared === 'upstream') return declared;
  return 'upstream';
}

/**
 * Classify a fork HEAD against `pin.commit`, given how the two relate in git.
 *
 * `descendant` is the caller's answer to "is HEAD a descendant of pin.commit?",
 * which only git can answer; passing it in keeps this decidable without a
 * subprocess and therefore unit-testable.
 *
 * Three outcomes, deliberately not two:
 *   at-contract     HEAD === pin.commit. Always fine.
 *   ahead           HEAD descends from pin.commit. Expected while the contract is
 *                   upstream-sourced; an error once it is fork-sourced.
 *   wrong-commit    HEAD does not descend from pin.commit. An error at any time.
 */
export function classifyForkHead({ head, commit, descendant, contractSource: source }) {
  if (head === commit) return { state: 'at-contract', ok: true, signal: null };
  if (!descendant) {
    return {
      state: 'wrong-commit',
      ok: false,
      signal: 'FORK_CHECKOUT_MISMATCH',
    };
  }
  return {
    state: 'ahead',
    ok: source !== 'fork',
    signal: 'FORK_AHEAD_OF_CONTRACT',
  };
}

/**
 * The two churn questions, as two ranges read from two checkouts.
 *
 * They are different questions and an earlier design let one flag answer both:
 * "what did upstream do since we pinned it" and "what have we changed" have
 * different ranges, different roots, and different consequences. Conflating them
 * reports our own customization as upstream movement.
 */
export const CHURN_MODES = {
  'upstream-movement': {
    identity: 'upstream',
    describe: (i) => `${i.commit}..origin/main`,
    range: (identities) => ({
      root: identities.upstream.root,
      from: identities.upstream.commit,
      to: 'origin/main',
    }),
  },
  'fork-drift': {
    identity: 'fork',
    describe: (i) => `${i.base}..HEAD`,
    /**
     * Measured to the checkout's HEAD, NOT to `pin.commit`.
     *
     * They were the same thing until `pin.commit` was ruled to stay at
     * `upstreamBase` until regeneration. After that ruling, measuring to
     * `pin.commit` reports `upstreamBase..upstreamBase` — zero drift — for a fork
     * carrying real customization commits. That is "I could not tell" spelled
     * exactly like "nothing changed", on the one tool whose entire job is
     * answering "what have we changed?".
     *
     * HEAD is correct on both sides of phase 5, so it does not need revisiting
     * when `contractSource` flips.
     */
    range: (identities) => ({
      root: identities.fork.root,
      from: identities.fork.base,
      to: 'HEAD',
    }),
  },
};

/**
 * Build the range for one churn mode. Unknown or absent mode throws rather than
 * defaulting: picking one silently is how the two questions get conflated.
 */
export function churnRange(mode, identities) {
  const spec = CHURN_MODES[mode];
  if (!spec) {
    throw new Error(
      `Unknown churn mode ${JSON.stringify(mode)}. Pass exactly one of ` +
        `${Object.keys(CHURN_MODES).map((m) => `--${m}`).join(' or ')} — they are different ` +
        `questions read from different checkouts, and there is no sensible default.`,
    );
  }
  return { mode, identity: spec.identity, ...spec.range(identities) };
}
