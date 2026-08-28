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

### Phase 1 review round: three lanes, one defect, and it was mine

gemini, codex and claude all returned REQUEST_CHANGES and all three independently
found the same thing. They were right and it was serious.

**`emit()` returned `doc.schema ?? doc` and threw away `doc.$defs`.** That left
**105 dangling `$ref`s** in `schema.json`. `shape-check.ts` listed `$ref` as a
supported keyword but never resolved it — so it walked into nothing, found no
constraints, and returned `matches: true` at all 105 positions. `types.d.ts` fell
through to `unknown` at 111 positions. Claude confirmed it empirically:
`defaultModelSelection: 12345` returned `matches: true`, zero mismatches.

That is the **fifth** instance of the same failure shape on this project — a
check reporting success while measuring nothing — and the first one that was in
the deliverable rather than in my tooling. The module whose entire stated purpose
is "I could not tell must never be spelled the same as yes" was doing exactly
that.

`shapeCheck` had **no tests at all**, which is why nothing caught it. It now has
18, weighted towards the ways a checker can lie: an unresolvable `$ref` throws,
an unimplemented keyword throws, every generated schema is walked asserting no
`UnresolvedRefError`, and one test asserts `shapeCheck` **accepts** `cwd: ''`
because the server rejects it — so nobody can mistake `matches` for validity.

Claude also verified a claim before recommending the fix, and it changed the fix:
`#/$defs/Objects_` names four *different* shapes across four documents, so merging
definitions naively would alias unrelated schemas. The fix namespaces per
top-level schema.

**Other findings, all verified before acting:**

- **Licence.** ATTRIBUTION.md said "Copyright (c) 2026 t3code contributors".
  Upstream says "Copyright (c) 2026 T3 Tools Inc." I paraphrased a legal notice
  from memory. It is now read verbatim from the pinned `LICENSE` at generation
  time, and generation fails if that file is absent.
- **A silent skip in my own test.** The hash-verification test `return`ed early
  with a `console.warn` when no checkout was present, and vitest reported it
  green. Now `ctx.skip()`.
- **`TrimmedString` missing from LOSSY.md.** My detector required a `.check(`;
  `TrimmedString` is a bare `decodeTo`. But a transform with no check still loses
  information — it trims, and `{"type":"string"}` does not say so. 22 lossy now.
- **`UNREPRESENTED.md` overclaimed**, saying every schema in the closure was
  representable while only covering schemas that passed through `record()`.
- **`ForwardCompatibleArray` missing** — a function returning a schema, so it had
  no `.ast` and was skipped. Combinators are now probed by application.

**Rejected:** codex said the loss detector should implement "transform-stripping
comparison" as planned. The heuristic finds all three named cases and the
committed probe proves the underlying claim directly; a second mechanism would
add surface without adding evidence.

### The criterion that gates Phase 2 — passed

`tools/t3-server/smoke.mjs`, two runs, both green: stop → acquire → verify →
start → ready → authenticate → dispatch a real `orchestration.dispatchCommand` →
`Exit: Success` → port free after teardown.

**It also confirmed Phase 2's central premise early.** `smoke.mjs` speaks the
`layerJson` envelope as plain JSON with **no Effect at all**, and the server
accepted it. That was the finding the whole plan rests on, and it is now
demonstrated against a live server rather than inferred from reading
`RpcMessage.ts`.

Two real bugs found by actually running it:

1. **I invented the auth endpoints.** t3 uses `POST /oauth/token`, form-encoded,
   with its own `urn:t3:params:oauth:token-type:environment-bootstrap`, and
   `/api/auth/websocket-ticket`. The proven spike had all of this; I should have
   read it rather than guessed.
2. **`stop` did not free the port.** It killed the recorded pid, but that is the
   `npx` wrapper and the server is its grandchild. A later "cold" start would
   have silently reused the previous server — making a start-twice proof a proof
   of nothing. It now sweeps the port, including when there is no pid file.

Also fixed: the server came up and then died with its parent, because I piped its
stdio through the spawning process. stdio now goes to a file descriptor directly.

### Note to self, per the architect

**Read the proven spike before writing anything that talks to the t3code
server.** I invented `/api/auth/token` with an RFC-standard subject_token_type
and got a 404, when the working flow was sitting in
`codev/experiments/146-t3code-porch-proof/` and `/Users/chris/dev/t3code-spike/
spike.mjs` the whole time: `POST /oauth/token`, form-encoded,
`urn:t3:params:oauth:token-type:environment-bootstrap`, then
`/api/auth/websocket-ticket`.

The pid bug is the more dangerous of the two. A `stop` that reports success while
leaving the grandchild alive makes a later cold start silently warm — the same
failure family as the other five, wearing different clothes.

**Verified, not assumed:** with `T3CODE_ROOT` pointing at nothing, the suite
reports `23 passed | 1 skipped`. The hash test skips rather than passing. I had
marked that criterion done before testing it, which would have been the sixth
instance; testing it made the checkbox earned.

Phase 1 closed: build green, full suite 6201 passed / 48 skipped, plus 180 in the
v2 suite. 42 spec-146 tests.

### The pattern, for the review doc

Nine instances on this project of one failure shape: **a check that reports a
result it never measured.** Recording it once as a pattern rather than nine times
as incidents.

**It is not a builder problem, and the review doc must not frame it as one.**
Five are mine, two are porch's, one is the harness's, and the ninth is the
architect's — their verification of my remediation piped a grep into `head` and
chained the verdict `echo` on `head`'s exit code. `head` exits 0 on empty input,
so it printed FOUND for all 25 commits it examined, including provably clean
ones. They caught it only because the output was too uniform to be true. A check
that reports positive regardless is the same defect as one that reports negative
regardless; the direction is incidental.

The instance that best shows the cost is the near-miss: the architect handed me
`git rebase --onto 8f2a2c195 a8c583dc4~1`, but `a8c583dc4~1` **is**
`8f2a2c195`, so it would have rebased onto itself, replayed the blob-carrying
commits unchanged, and exited 0. Had I trusted that exit code we would have
force-pushed the secrets back up while believing they were gone.

Mine, five:

1. **The emitter probe.** I could have reasoned that `toJsonSchemaDocument`
   preserves constraints. Running it showed it drops checks behind a `decodeTo`
   transform, so a drift test built on it would report success on a relaxed
   branded id. Caught *before* review, by predicting what the check should find
   and noticing it found nothing.
2. **The loss detector's `typeof` guard.** Effect 4 schemas are callable, so
   `typeof candidate === 'object'` skipped every schema and `LOSSY.md` said
   "none detected" on a contract that degrades 22.
3. **The churn classifier staging into `/tmp`,** where Node cannot resolve
   `effect`. Every commit came back `unbuildable`, which reads as "nothing to
   classify" rather than "the harness is broken".
4. **`shapeCheck` at 105 `$ref` positions.** The module whose stated purpose is
   preventing this did it: `$ref` was listed as supported, never resolved, so it
   walked into nothing and returned `matches: true`. It had no tests.
5. **`stop` that did not free the port.** It killed the recorded pid — the `npx`
   wrapper — while the server, its grandchild, kept listening. A later "cold"
   start would silently have been warm.

Framework and process, four:

6. **porch cannot distinguish contention from failure.** It reported
   `CHECKS FAILED` for a suite that passes, because "another run holds the lock"
   and "the tests failed" arrive at the same exit code.
7. **`porch done` from the wrong cwd exits 0 having done nothing.** It resolves
   the project from cwd, printed "Project 146 not found", and returned success.
8. **`classify-churn` exited 1 on an empty commit range** — the normal state
   right at the pin — so `REFRESH.md`'s own step 2 failed whenever it had
   nothing to report.
9. **A verification whose verdict was chained on `head`'s exit code**, so it
   reported FOUND unconditionally. The architect's, on my remediation.

Three things generalise. **A verdict must never be chained on a pipeline's last
stage** — `head`, `tail` and `grep -c` all exit 0 on empty input, so
`cmd | head && echo FOUND` is an unconditional FOUND. **Predicting what a check
should find before running it**
is what caught 2 and would have caught 4 sooner — a test that only proves the
happy path passes against the broken version too. And **a distinct signal for
"could not tell"** is the fix in every case: three exit codes in the harness,
`unclassifiable` as a third churn verdict, `ctx.skip()` instead of an early
`return`, and `UnresolvedRefError` instead of a silent walk.

And **two tests of the same kind are one test run twice.** When the architect
gated the secret-scrub on two `--diff-filter=A` greps, I added a third that
walks each commit's *tree* instead of its diff. They kept it, on the reasoning
that the first two shared a failure mode.

### Correction: PID 61593 was not in my worktree

I told the architect another agent was running test suites in my worktree and
colliding with porch. Half wrong. 61593 is a legitimate builder in a **different
repository** (`dvarr/.builders/aspir-230`), and `--dangerously-skip-permissions`
is normal for a builder start script.

The real cause is #130's fix working as designed: `vitest-global-setup.ts` holds
a loopback mutex on port **13999** so two full-suite runs cannot collide on
shared Tower state, and that lock is **machine-wide, not workspace-scoped**. Any
project running its suite blocks mine. Two builders queueing, nothing wrong.

Worth keeping because the shape of my error is familiar: I saw a `claude
--dangerously-skip-permissions # Role: Builder` process, matched it against the
agent that *had* genuinely been editing my plan file earlier, and concluded it
was the same actor. It was not. I checked my own pid chain before acting and
asked rather than killing, which is the only reason this is a note and not an
incident.
