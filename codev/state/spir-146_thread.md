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

## 2026-08-28 — plan phase

Spec gate cleared on the architect's written approval rather than a fifth CMAP
round on an already-approved artifact. Plan drafted, reviewed, revised twice.

### I falsified my own Phase 1 before review came back

The architect asked for the Effect runtime-schema question to be answered with
evidence from source, not reasoning. Reading the source got me most of the way:
under `RpcSerialization.layerJson` (`apps/server/src/ws.ts:2492`) the wire
envelope is ~10 tagged JSON shapes carrying an opaque `payload`
(`RpcMessage.ts:61-155`), so domain schemas are needed only for validation, not
to speak the protocol. That is why the spike's `Schema.Unknown` worked.

Then I actually ran Effect 4's emitter instead of trusting that conclusion, and
it changed the design. `toJsonSchemaDocument` represents every shape in the
closure, but it **drops checks on the decoded side of a `decodeTo` transform**:

- `Schema.String.check(isNonEmpty())` → `{"type":"string","allOf":[{"minLength":1}]}`
- the *same check* behind a transform → `{"type":"string"}`

`TrimmedNonEmptyString` is that second shape, and it is the base of every branded
id in t3code. Worse, Effect's own `toRepresentation` is blind to it too — both
forms serialise to the byte-identical
`{"representation":{"_tag":"String","checks":[]},"references":{}}`.

**Consequence:** a drift test built on generated artifacts cannot see a relaxed
branded id. Phase 1 now carries two layers — a source hash over the 9 closure
files as the load-bearing detector, and the generated diff to explain what
changed. Probe committed at `codev/experiments/146-schema-emitter-probe/`.

### Measurements taken (all verified, all cited in the plan)

- Vendoring closure: 9 files, 3,663 lines, not the full 19,662. `rpc.ts` excluded
  deliberately — pulling it in costs 27 files and 11,120 lines.
- Churn: **184 commits** across the closure since 2026-02-07 (~27/month), against
  the spec's 89 for `orchestration.ts` alone.
- `effect` is `4.0.0-beta.103` and the RPC lives under `effect/unstable/rpc/*`.
- `porch approve` enforces only `hasHumanFlag` (`index.ts:898`) — confirmed, and
  it **mutates before it checks**: verify auto-complete and gate auto-create both
  `writeStateAndCommit` above that line.
- Tower's request auth is a *shared* key at `~/.agent-farm/local-key`, mode 0600,
  same user a builder runs as. Machine boundary, not human-vs-agent.
- The workspace `.env` is symlinked into every builder worktree
  (`spawn-worktree.ts:88-96`).
- No `db/migrations/` directory exists and there are **no down-migrations** —
  inline `v2..vN` blocks in `db/index.ts` guarded by `_migrations` rows.
- `ProjectState` (`porch/types.ts:217`) has no `thread_id` field.
- #128 phases 1-2 already shipped (`porch gate --request-file`).

### Review round 1

gemini APPROVE. codex REQUEST_CHANGES with 8 findings — every one checked against
the code, every one real, all addressed. claude REQUEST_CHANGES. Plan went 13 → 15
phases; the changes are listed in the plan's own "Revisions after the first review
round" section.

**opencode's lane is structurally broken for this spec.** It is sandboxed out of
`/Users/chris/dev/t3code` — its log is a run of `permission requested:
external_directory (/Users/chris/dev/t3code/*); auto-rejecting`. It could not read
`orchestration.ts` or grep `ORCHESTRATION_WS_METHODS`, `layerJson` or
`toJsonSchemaDocument`, so it cannot verify a single t3code claim in this plan.
It exited with no verdict and no output file. Reported to the architect.

### Something else was writing to my plan file

While the round was running, content I did not write appeared in
`codev/plans/146-codev-client-on-t3code.md`. The writer is the `consult -m claude`
lane (pid 9541), which is a full agent with write access to this worktree, not a
read-only reviewer; its own log shows it editing the file and believing it was
coordinating with an architect who was rewriting the plan.

I checked every citation it introduced against the source before keeping any of
it. All accurate: `cron-delivery.ts:27-29` and `delayed-send.ts` do import
`db/mailbox.js`, `cleanup.ts:17` imports `dismissHeldForAgent`, `status.ts`
renders `heldCount`/`mailboxEscalated`, `pnpm-workspace.yaml` really does glob
`apps/*` so vscode needs a negation entry, and `apps/web` really is the
xterm-based legacy dashboard. So the content stands on merit and is kept.

It found one thing I had missed and it matters: **deleting the mailbox silently
removes `afx send --delay` and every cron notification**, because both features
the spec keeps import the mailbox directly. That is now a Phase 4 deliverable
rather than a Phase 14 surprise.

Recording the provenance anyway. A review lane mutating the artifact under review
is worth knowing about, and I committed defensively throughout so nothing of mine
could be lost to a concurrent write.
