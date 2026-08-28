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

### Review round 2 (claude, re-run to porch's path)

Second claude review verified every load-bearing citation in the plan against
the tree independently and they held. It then found six real defects I had
missed. All verified before acting:

1. **A circular dependency between Phase 5 and Phase 8.** Phase 5's thread
   registry reads `architect.thread_id` / `builders.thread_id`; Phase 8 added
   those columns and depended on Phase 5. Neither was buildable. Fixed by
   splitting schema from use: the columns land in Phase 5 (the first phase that
   needs them to exist), Phase 8 keeps everything that writes them.
2. **Phases 11 and 12 asserted criteria owned by phases they did not depend on**
   — criterion 9b needs Phase 6's capability, criterion 15 and the iPad run need
   Phase 7's credentials and pairing. A builder could legally have started the
   client with no auth layer built.
3. **Phase 14's PTY surgery was under-specified and mis-scoped.** The spec says
   five files reach the PTY manager; the measurement says twelve. Worse, four of
   them are components the spec *keeps* — `tower-routes.ts` (7 terminal refs),
   `tower-server.ts` (2), `tower-tunnel.ts` (1), `session-log-sweep.ts` (1). A
   flat delete list would have removed the HTTP server the spec preserves. Each
   file is now marked delete or edit.
4. **The sdk terminal surface does not die with `apps/web`.** An earlier revision
   of my plan said it did. `apps/vscode/src/connection-manager.ts:2-3` imports
   `TowerClient` and `backoffDelayMs`, `terminal-manager.ts:7` imports
   `TerminalType`. Phase 13 keeps `apps/vscode` in the tree *specifically* so
   upstream's 173 commits merge cleanly, and Phase 14 would have removed the
   exports it compiles against — destroying the benefit Phase 13 exists to buy.
   Ruled: `tower-client` is retained as a compile-only surface.
5. **MIT attribution was missing.** `@cluesmith/codev-types` is published,
   Apache-2.0, `files: ["src","dist"]`. Generated artifacts derived from MIT
   t3code source would have shipped inside a distribution with no notice. That
   is a licence obligation, not tidiness.
6. **`tools/` is outside the workspace globs** (`packages/*`, `apps/*`), so the
   codegen's `effect` devDependency would never install.

One reviewer claim did **not** hold: `afx shell` was flagged as PTY-coupled.
`commands/shell.ts` has no import from `terminal/`. Only `attach.ts` does.
Recorded in the plan as checked so it is not re-opened.

### The opencode / porch conflict

Porch enforced a 4-way review while the architect had ruled opencode dropped
(issue #150 — it is sandboxed out of `/Users/chris/dev/t3code` and could not read
a single file the plan is about). I refused to hand-edit `status.yaml` and put
the decision to the architect. They resolved it through the supported path:
removed opencode from `porch.consultation.models` in `.codev/config.json`, which
is the setting porch reads to build its required-lane list. The 4-way became a
3-way without touching state by hand.

### Gate

`plan-approval` requested with structured content. 15 phases, checks green,
3-way review complete: gemini APPROVE, codex REQUEST_CHANGES addressed, claude
REQUEST_CHANGES twice, both addressed.

## 2026-08-28 — Phase 1: vendored contract, drift detection, churn

Plan approved by the human. Phase 1 built and its checks run.

### What shipped

- `packages/types/src/t3/` — generated artifacts, `pin.json`, `shape-check.ts`,
  `index.ts`. Zero runtime deps preserved; a test asserts it.
- `tools/t3-codegen/` — the only place `effect` exists in this repo, as a
  devDependency. `generate.mjs`, `classify-churn.mjs`, `REFRESH.md`.
- `tools/t3-server/` — the pinned-server harness.
- `tools/*` added to `pnpm-workspace.yaml`; without it nothing installs the
  codegen's `effect`.
- `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` — 18 tests.

Tests live in `packages/codev` because that is where the suite actually runs:
root `test` is `pnpm --filter @cluesmith/codev test` and `packages/types` has no
runner. A test in `packages/types` would look present and never execute.

### Two bugs I wrote and caught

**The loss detector reported zero loss.** I guarded on
`typeof candidate === 'object'`, but Effect 4 schemas are *callable* — `typeof`
is `'function'`. Every schema was skipped and LOSSY.md said "none detected" on a
contract that degrades 20 schemas. Caught it only because the plan predicted the
loss and the empty report contradicted the prediction. The test now asserts
LOSSY.md is non-empty, so this cannot regress into a quiet clean bill.

**The churn classifier reported every commit unbuildable.** It staged files in
`/tmp`, where Node's upward walk for `effect` finds nothing. That failure read as
"nothing to classify" rather than "the harness is broken". Fixed by staging
inside the tool, same as the generator already did.

Both are the same shape of bug: a broken check reporting success.

### The measurement that matters

**Criterion 12: 21 of 54 classifiable commits — 39% — change a shape Codev
consumes.** `dispatchCommand` (15) and `subscribeThread` (13) absorb nearly all
of it, which are exactly the two methods `porch-driver` is built on.

Three limits, all recorded in the report rather than smoothed over:

1. The spec's 184-commit window starts 2026-02-07, but the closure did not exist
   until 2026-05-02 (`vcs.ts`, `sourceControl.ts`; `auth.ts` 2026-04-09,
   `providerInstance.ts` 2026-04-29). Before that "changed against the vendored
   types" has no referent.
2. Commits before ~2026-06-01 cannot be emitted with the pinned Effect at all —
   they fail inside `SchemaAST` because they predate `4.0.0-beta.103`. Reported
   as `unclassifiable`, a third verdict, never folded into breaking or safe.
3. `source-only` is not "safe". A relaxed branded id lands there with a zero-byte
   schema diff. 32 source-only commits means 32 whose effect is *invisible to the
   emitter*.

### Harness

`verify` is the load-bearing verb, not `start`, per the architect's instruction
that a later phase must not quietly test against the wrong server. Three exit
codes — 0 verified, 1 mismatch, 3 could-not-determine — because a missing
checkout must not exit like a passing one. All three paths tested.

Its real limit is in the README: it pins the *checkout*, not the `t3` CLI binary
that serves it. If those diverge, `verify` cannot see it.

### Plan corrections from implementation

- `resolveJsonModule` deliverable superseded. Emitting `schema.ts` as a module
  and passing the schema to `shapeCheck` removes the JSON-import machinery, and
  with it the copy-into-dist step that would pass CI and fail at runtime.
- Criterion 12 marked done with the real figure and its caveats.
