# Approval capability: threat model

Spec 146, phase 6. This document is held to one rule: **every claim in it is one the code
actually makes true.** A claim that was aspirational was deleted rather than softened. Two
earlier revisions of this design were falsified against the code by review, both times for
describing a boundary that was not there.

## What was there before

`porch approve` enforced exactly one thing: that the string
`--a-human-explicitly-approved-this` appeared in argv
(`packages/codev/src/commands/porch/index.ts`, the `hasHumanFlag` test). **A builder has a
shell in its own worktree, so it could type that string.** The flag was never a control, and
this document does not inherit the assumption that it was one. It remains, as a typed
confirmation of intent, and the usage text now says so.

The same function also **mutated before it authorized**: the verify auto-completion and the
gate auto-creation branches both called `writeStateAndCommit` above the flag test, so a call
that was about to be refused had already written and committed `status.yaml`. That ordering
is fixed in this phase, and a test asserts the file is byte-identical and the commit path is
never entered on a refusal.

## Assets and adversary

The asset is **a protocol gate transition that only a human may make**: `conceived →
specified`, `committed → integrated`, and the `pr` and `verify-approval` gates.

The adversary is **an agent with a shell on the same machine, running as the same user** —
in practice, a builder in its own worktree. It is not a remote attacker and not another
user. That matters, because almost every conventional local control is defeated by "same
user": file modes, key files, and directory permissions all fail against it.

Two consequences follow, and they are the reason for the shape of the design.

**Tower's existing request authentication cannot help.** It is a *shared* key at
`~/.agent-farm/local-key`, mode 0600, owned by the same user a builder runs as. Verified on
disk: 64 bytes, `-rw-------`. A builder can read it. It is a machine boundary, never a
human-versus-agent boundary.

**The workspace `.env` is symlinked into every builder worktree.**
`symlinkConfigFiles()` in `packages/codev/src/agent-farm/commands/spawn-worktree.ts` calls
`symlinkSync(envRoot, envWorktree)`. Anything in `.env` is readable by every builder, so the
capability is never stored there, and a test drives the real symlink and asserts the issued
secret is absent from what a builder reads through it.

## Design

### Issuance root of trust

A capability exists only if `codev-agent` issued it, and `codev-agent` issues only to a
**human-paired session** — `HumanPairedSessionRegistry`, whose sessions are created solely
by the `human-client` pairing completion path, live in memory, die on restart, expire after
at most 8 hours and after 30 idle minutes.

The root of trust is therefore the pairing ceremony, not the machine and not the process.

`issueApprovalCapability` also refuses a caller that **declares itself** a builder or an
architect. That is defence in depth and nothing more. **Over loopback TCP the peer process
is not attributable**: `remoteAddress` is `127.0.0.1` for a builder, an architect and a
browser alike, and there is no peer-credential mechanism for TCP on macOS. A builder that
declares itself a human client is not caught by that check. What stops it is that it has no
paired session.

### Storage

The host stores a **verifier, never a credential**: a SHA-256 of the secret, beside the
capability id, machine, issuing session id, issue time and expiry. The secret is returned
exactly once, to the client that completed pairing, and is never written by the host in any
form.

This defeats **reading**. A builder that reads
`~/.agent-farm/approval/capabilities.json` — which it can, being the same user — obtains a
hash it cannot present. A test asserts this by taking the verifier straight out of the
persisted file, presenting it, and requiring the refusal.

**It does not defeat writing, and the same adversary writes.** The store is parsed with
`JSON.parse` and carries no signature, HMAC or ownership check, so a same-uid builder can
append a record of its own — `{ id, verifier: sha256(<a secret it chose>), machine, expiresAt }`
— and then present that secret. It can mint itself a nonce row the same way.

**There is no local mitigation and this document is not going to imply one.** Any key that
would authenticate the file has to be readable by `codev-agent`, which runs as the same user
as the builder, so the builder can read it too. Signing the file moves the problem; it does
not solve it. The honest statement is the one in the module header: what a capability adds is
not a wall, it is evidence of which credential and which human session performed an approval.
A forged record is still a record, and it is still in the artifact.

The store is outside every workspace and outside `.env`, and a test asserts that too.

### Expiry

Capabilities carry an expiry: 12 hours by default, 7 days at most. An expired capability is
refused as `APPROVAL_CAPABILITY_EXPIRED`, distinct from `CAPABILITY_REVOKED` and from
`APPROVAL_CAPABILITY_INVALID`, because those three send an operator to three different
places: wait or reissue, reissue, and fix the client.

### Revocation

`revokeMachine(machine)` marks every live capability for one machine revoked and leaves
every other machine's records untouched. A revoked capability reports `CAPABILITY_REVOKED`
for the rest of its natural life rather than reporting "unknown", so revocation is
distinguishable from a capability that was never issued.

Revocation is a tombstone rather than a deletion for exactly that reason.

### Replay

Every capability-backed approval consumes a **single-use nonce bound to the project id and
the gate name**, with a 5-minute TTL. Consumption leaves a tombstone until the TTL passes,
so a **replay** reports `APPROVAL_NONCE_REPLAYED` and a nonce this host never minted reports
`APPROVAL_NONCE_UNKNOWN`. Spelling those the same way would spell "I could not tell" the
same way as "no".

A nonce past its TTL is kept for a bounded **retention window** (four TTLs) rather than swept
at the TTL, so it reports `APPROVAL_NONCE_EXPIRED` while the record is still held. Sweeping at
the TTL made that code unreachable — the row was gone before anything could look at it, so an
expired nonce answered `APPROVAL_NONCE_UNKNOWN`, two events with one answer. Beyond the
retention window the record genuinely no longer exists and `APPROVAL_NONCE_UNKNOWN` is the
honest answer, which is why the window is bounded rather than infinite.

`porch approve` **peeks** at the nonce during authorization and **consumes** it immediately
before the gate is written. Peeking first means a bad nonce is refused in a second rather than
after a full build; consuming last means a run that stops at the already-approved return, or at
a failed phase check, does not burn a single-use nonce and force a re-mint through the
authenticated route. `consume` remains the authoritative single-use step: a replay arriving
between the peek and the consume loses there.

The nonce is also bound to **the capability that presents it**. That field was stored and not
checked in the first cut of this phase, which made it a claim rather than a constraint: a
nonce minted for capability A would authorize an approval presented with capability B.

Single-use is enforced across processes by an exclusive lock (`open(…, 'wx')`) held across the
whole read-decide-write sequence, because a read-modify-write without one lets two concurrent
`porch approve` processes each observe the same unconsumed nonce. A lock older than 30 seconds
is reclaimed, so a killed process cannot wedge approvals permanently. The tests exercise the
lock being held and being reclaimed; they do **not** run two processes, and are named so they
cannot be read as a concurrency proof.

Approval nonces are a **separate store** from `lib/nonce-store.ts`, which holds OAuth tunnel
registration state. Sharing them would let a tunnel nonce authorize a gate. A test asserts
the separation in both directions rather than leaving it to a comment.

### CSRF

The human session travels in a custom request header (`x-codev-human-session`), never a
cookie. There is no ambient credential on this surface for a cross-origin request to ride: a
cross-origin form post cannot set the header, and a cross-origin `fetch` that tries is
stopped by preflight.

### What is recorded

Every approval writes into `status.yaml`, under the gate:

- `authorization` — `capability`, `flag-only`, or `pre-approved-artifact`
- `approved_at`, `machine`
- `caller` — the attribution evidence verbatim, i.e. what was read, not a conclusion
- `session_id` and `capability_id` — present only under `capability`

`session_id` and `capability_id` are both stored because they answer different questions:
which credential was used, and which human session used it. A capability outlives a single
browser session.

`pre-approved-artifact` is the third path and it does not go through `approve()` at all:
`next.ts` consumes `approved:` frontmatter a human committed to the spec or plan on `main` and
marks the gate approved directly. It presents no capability and is not gated by this phase.
It is recorded so that an approval with no provenance is not left silently indistinguishable
from one with it; closing that path is not in this phase's scope.

## Who is asking, and the limits of the answer

`attributeApprovalCaller` reads four things and returns one of three kinds —
`builder-session`, `architect-session`, `unattributed`. Every signal is a **self-declaration
the calling process can remove from itself**:

1. `CODEV_WORKTREE_ROOT` — written into the env block by `startBuilderSession`. If it contains
   the artifact root, the caller is attributed to a builder session. **This is not present in
   every live builder**: checked on 2026-08-29 against a real `.builder-start.sh`, spawned by
   the globally installed package rather than this tree, which carried no `export` lines at
   all. The env rule is a bonus; the cwd rule is what fires in practice.
2. `CODEV_BUILDER_ID` — same origin, same caveat; recorded as evidence.
3. The **caller's** cwd, when it sits inside a builder worktree
   (`<workspace>/.builders/<id>`) — whichever project it is approving. Keying this on the
   target's worktree instead would let a builder approve a *different* builder's gate, which
   is still an agent approving a gate.
4. `CODEV_ARCHITECT_NAME`, checked **last** — an architect session is attributed as its own
   kind and **still allowed**, because issuance is reachable only through the client and
   refusing architects would leave no working approval path at all. It is checked last because
   the variable is **inherited by everything an architect spawns**, this builder's own shell
   included, so it attributes "an architect session or a descendant of one", never "an
   architect". Builder evidence wins, and a test asserts that ordering.

**This is attribution, not authentication.** A process that clears every variable *and* leaves
the worktree is not attributed. A test asserts that limit explicitly, so it cannot be quietly
forgotten.

An earlier cut of this function returned the evidence string "no builder or architect session
evidence in the environment or cwd" while reading nothing about architects at all. That string
is what an operator reads out of `status.yaml`, so it was a claim about a check that did not
run — the same class of defect this phase was written to watch for, found by the architect.

## What this does not stop

Stated plainly, because a threat model that only lists wins is a marketing document.

- **A human who holds the capability can hand it to an agent.** No design prevents that. The
  capability is a bearer credential once it reaches the human's client.
- **`status.yaml` is a file inside the builder's own worktree, and the builder can write
  it.** Nothing in this phase prevents a builder editing that file directly. What this phase
  changes is that porch will not be the instrument, and that an approval porch performed
  carries evidence of which capability and which human session performed it. An approval with
  no such evidence is now distinguishable from one with it — which it was not before.
- **An unattributed caller with no capability is still allowed**, recorded as `flag-only`.
  This is how an architect at the workspace root approves a gate today, and it is not a
  control. It is recorded rather than silent precisely so that the weaker state is visible in
  the artifact instead of reading as a verified human approval.
- **A same-uid process can forge a capability record** by appending to the store, because the
  store has no integrity protection and no local mechanism could give it one. See *Storage*.
  The verifier split defeats reading, not writing.
- **`flag-only` is the only practical human approval path until the client exists.** Issuance
  is reachable only over the `codev-agent` HTTP route with a paired session, and the client
  that would hold one arrives in a later phase. Until then every real approval is `flag-only`,
  and an agent that clears its environment and leaves the worktree can take that path. This is
  a deliberate interim state, recorded here rather than discovered later.
- **A builder that daemonizes or otherwise sheds its environment** defeats the attribution
  layer. It does not defeat the verifier property, which is the boundary that carries weight.

## For phase 7, stated here so it is not inherited by accident

Phase 7 is the transport and service security posture, and the natural assumption to carry
into it is "the capability store is the boundary". **It is not.** The capability layer buys
attribution and replay resistance, and nothing at all against a same-uid adversary that
writes. Do not build a phase-7 claim on a boundary this phase proved is not there.

## Where the boundary actually is

The verifier-not-credential property, plus issuance gated on a human-paired session, removes
the **replay** of a legitimately issued credential by anything that can read the machine. It
does not survive a same-uid writer, and the *Storage* section says so.

So the boundary is smaller than a boundary. What this phase actually delivers is that porch is
no longer the instrument of a self-approval, and that an approval which went through porch
carries evidence of which capability and which human session made it — where before, every
approval looked identical and none of them proved anything.

Everything else — the declared-principal refusal, the environment and cwd attribution — is
defence in depth, and is described that way here because describing it as more is what got the
previous two revisions falsified. A reviewer falsified the read-only framing of the paragraph
above for exactly the same reason, which is the third time on this document; the lesson is
that a claim survives only as far as the verb in it.
