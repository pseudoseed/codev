# spir-146 — Codev client on a self-hosted t3code server

## 2026-08-28 — spawn, specify skipped, entering plan

Spawned strict SPIR against spec 146. Spec was already approved on `main`
(`codev/specs/146-codev-client-on-t3code.md`, frontmatter `approved: 2026-08-28`,
`validated: [gemini, codex, claude]`), so porch's specify phase was a no-op:
`porch check` passed both criteria, and I cleared `spec-approval` on the
architect's explicit written approval rather than running a fifth CMAP round on
an already-approved artifact. The architect (`architect:uiv2`) directed this.

### Architect context that the spec does not carry

The spec went through **four** CMAP rounds. Final verdicts: gemini APPROVE,
codex and claude REQUEST_CHANGES. The architect closed every falsifiable finding
and deliberately deferred three to plan work:

1. **The approval threat model** — issuance root of trust, storage, expiry,
   revocation, replay/CSRF.
2. **Contract-vendoring mechanics** — how the t3code RPC contract is pinned.
3. **A failure matrix for `codev-agent`.**

Warning attached: the spec's *Gate approval* section has already had two earlier
versions of its central claim **falsified against the code**. Do not restate a
boundary I have not verified myself.

### Proof already on main

- `codev/research/146-t3code-porch-execution-proof.md` — all three execution
  proofs passed.
- Spike harness: `codev/experiments/146-t3code-porch-proof/` (`proof.mjs`,
  `resume-check.mjs`).
- Simpler spike: `/Users/chris/dev/t3code-spike/spike.mjs`.
- t3code itself: `/Users/chris/dev/t3code`, cloned **read-only**, full history.
  Needs Node 22 — `PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH`.

### The open architectural question (phase 1 of the plan)

codex raised it and the architect could not settle it from docs: the spike used
`Schema.Unknown`, but a production Effect RPC client needs **runtime** schemas.
Vendoring those into `packages/types` would put Effect runtime code into a
package that today has **zero runtime dependencies** — which the server/client
isolation boundary tests (#1189) exist to protect. This must be answered with
evidence from the t3code source, not from reasoning.

### Plan shape directed by the architect

Risky, falsifiable work first. UI last.

### Context refresh

Porch emitted a `enter:plan` context-refresh task. I skipped it: I was ~30k
tokens into a fresh context and the only state not already on disk was the
architect's instruction message, which is now recorded above. The boundary is
recorded in `status.yaml` and will not fire again.
