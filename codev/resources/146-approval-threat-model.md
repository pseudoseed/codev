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
**paired client session** — `HumanPairedSessionRegistry`, whose sessions are created solely
by the pairing completion path, live in memory, die on restart, expire after at most 8 hours
and after 30 idle minutes.

`issueApprovalCapability` also refuses a caller that **declares itself** a builder or an
architect. That is defence in depth and nothing more. **Over loopback TCP the peer process
is not attributable**: `remoteAddress` is `127.0.0.1` for a builder, an architect and a
browser alike, and there is no peer-credential mechanism for TCP on macOS.

### What the pairing ceremony does NOT establish

**An earlier version of this section said the root of trust was the pairing ceremony, and
that what stopped a builder declaring itself a human client was having no paired session.
Both statements were false**, and they were the more dangerous kind of false: a document
asserting a property its code never had, which the next person builds on.

Minting a pairing token requires nothing but write access to the pairing store
(`PairingStore.issue`). Every agent on this host runs as the same user as the operator, so a
builder can construct that store, mint a token, redeem it at
`POST /api/agent/v1/human-sessions`, hold a session this surface cannot distinguish from a
browser's, and approve its own gate through the advertised path.

**This is not fixable on a single-uid host by anything in this design.** Every channel
available to the operator — a file, a TTY, a spawned process, an environment variable — is
available to a builder running as that operator. A mechanism that merely *looked* like
out-of-band authority would be a second false guarantee stacked on the first, and harder to
see than the one it replaced.

`agent-approval-path.test.ts` pins the residual under the name *"lets anything with
filesystem access complete the ceremony — the stated residual"*: it constructs the store the
way a builder would, completes the whole ceremony, and asserts what the record says
afterwards. A future design that adds real authority makes that test fail, which is where
the change belongs.

### What the ceremony DOES establish, and what is recorded

Three things, all real, all enforced, none of them human presence:

| Established | Enforced by |
|---|---|
| A live, scoped, revocable per-machine credential | `MachineCredentialStore`; revoking one machine leaves the others untouched (criterion 15) |
| One session per deliberate mint, countable and single-use | The pairing token is spent on redemption and tombstoned |
| A token cannot be diverted between ceremonies | `PairingPurpose` — a token minted for `machine-credential` cannot open a `client-session`, and the reverse. A token refused for the wrong purpose is **not** consumed |

On top of that the system **records rather than asserts**. Every mint names an `authority`:
the minter's own account of what authorized it, required and non-empty. That string travels
verbatim from the token to the session, to the capability, and into
`status.yaml` as `gates.<name>.approval.authority`.

So a reader of `status.yaml` sees the claim an approval was made under. What they must never
read into it is that a person was there: `authorization: 'capability'` means a verified
**credential** and a spent single-use nonce, and nothing about who held it.

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

A store that **exists but will not parse** reports `APPROVAL_STORE_UNREADABLE`, never
`APPROVAL_CAPABILITY_UNKNOWN`. Returning an empty fallback would have a corrupt file assert
that the credential was never issued — the same distinction the codev-agent failure matrix
draws between `GLOBAL_DB_LOCKED` and `GLOBAL_DB_UNREADABLE`. A store that has never been
written is absence, and still answers `UNKNOWN`.

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

#### Who can revoke, and the trade that decides it (Spec 236)

**Until spec 236 the operator who wanted to withdraw access was the one who could not.**
`DELETE /api/agent/v1/machines/<id>` and
`DELETE /api/agent/v1/approval-capabilities/machine/<id>` are both declared `human-session` in
the route table, and `human-session` includes `machine-credential` — so revoking required
already holding the credential being revoked. Minting, meanwhile, required nothing but write
access to a file. A real credential on the development machine (`dev-check`, issued by a smoke
test) sat unrevokable for exactly that reason.

`afx pair revoke` writes the two stores directly. Revoking now costs precisely what minting
costs, and works with no credential and with Tower not running — which is when an operator most
wants it.

**The objection this has to answer is availability, not confidentiality.** The route table's own
rationale privileges revocation because *"an agent that could revoke could deny a human their
gate"*. That is a denial-of-service argument, and the reply that fits the *Storage* section
above — a same-uid agent can already forge a capability — does not reach it.

What does reach it: **a same-uid agent can already write these stores directly.** It can revoke,
forge, delete or corrupt them, exactly as it can mint itself a token. So it can already perform
that denial. The command makes the denial *convenient*, not *possible*.

And the alternative on offer was not "an operator who cannot be denied". It was the status quo,
in which the human cannot revoke and the agent still can. That is the trade, stated as a trade:
convenience of an attack that was already available, in exchange for withdrawal being possible
at all.

**What it does not change.** Revocation still cannot be made trustworthy against a same-uid
adversary, because nothing on a single-uid host can be. The HTTP routes keep their
`human-session` requirement for clients that hold one; the command is not a relaxation of them,
it is a second path with a different — and honestly weaker — boundary, which is filesystem write
access to `~/.agent-farm`.

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
- **`flag-only` is still not a control**, and it is still reachable: an agent that clears its
  environment and leaves the worktree takes that path, and every CLI approval takes it too.
  What has changed since this bullet was written (spec 236) is that it is no longer the ONLY
  practical path — the client exists, `afx pair issue --purpose client-session` mints the token
  a session costs, and a capability-backed approval is reachable by a person. The earlier text
  said flag-only was the only practical path "until the client exists"; that sentence has
  expired, and this document's rule is that a claim survives only as far as the verb in it.
- **A builder that daemonizes or otherwise sheds its environment** defeats the attribution
  layer. It does not defeat the verifier property, which is the boundary that carries weight.

## A session belongs to one device (spec 236)

The registry stored no machine, and the machine credential and the human session were verified
**independently of each other**. Both valid, neither compared — so a session opened on one device
could be presented alongside another device's credential, and every check passed.

That is the per-device ownership and revocation model of this whole document defeated without
breaking either credential. It is also the same conflation as the `machine` / `pairedMachine` one
recorded above, one layer up: two names for two different things, treated as interchangeable
because nothing ever put them side by side.

**What holds now.** A session records the machine it was opened from, and the single
authentication choke point requires the presented session to be that machine's. Enforced there
rather than per handler: a route that forgot would be a hole with no visible cause. `mayRead`
carries the same rule independently, because it is exported and decides who may read an approval's
outcome — a rule that holds only because its one caller checks first is a rule that will be wrong
when a second caller appears.

**Refused with 403, not 401.** The session is real and its holder may be using it legitimately on
the other device; what is refused is using it *from here*. Answering "authenticate" would send a
client into a re-pair loop that cannot fix what is actually wrong.

**What it does not stop.** A session presented from the right device by something else on that
device. Sessions are bearer credentials once issued, and a same-uid process can read them — the
same limit the *Storage* section states for every other secret here. This binds a session to a
machine, not to a person, and nothing in this document claims otherwise.

## The approval receipt (spec 236)

Asynchronous approval added a **fourth** bearer secret, and it is listed here because a
credential absent from this document is one nobody reasons about.

**What it is.** A random value returned once when an approval is submitted. It authorises
reading *that one operation's* outcome, and nothing else — it approves nothing, and it is
useless for any other operation, workspace or gate.

**Why it exists.** Human sessions live in the host's memory, so the restart that resolves an
operation to `interrupted` destroys the session that submitted it. Authorising the poll on
session identity alone meant the durable record whose entire purpose is surviving a restart
could never be read by the client that needed it.

**What bounds it.** The receipt is checked *with* the machine credential, never instead of it:
a receipt lifted from one device is not usable from another. Reading an operation reveals its
state, gate, project and approving session — not the capability, and not the ability to approve
anything.

**Where it must not go.** Headers only. It travelled as a query parameter first, which put it
in every URL Tower logs on an authentication failure — the exact request a client makes when
polling across a restart — and in every reverse-proxy access log, which is outside our control
entirely. `spec-236-receipt-not-in-url.test.ts` asserts the absence, and asserts the server
*refuses* the query channel rather than merely not using it.

**Stored in the clear, like every other record here.** The operations file has no integrity
protection, for the same reason the capability store has none: no local mechanism could give it
one against a same-uid writer. So a same-uid process can read a receipt out of the store — which
is strictly weaker than what it could already do, since it can write the store's records
outright. The receipt raises the cost of reading an approval's outcome from another *machine*,
which is the boundary it was added for.

## For spec 146 phase 7, stated here so it is not inherited by accident

Phase 7 is the transport and service security posture, and the natural assumption to carry
into it is "the capability store is the boundary". **It is not.** The capability layer buys
attribution and replay resistance, and nothing at all against a same-uid adversary that
writes. Do not build a phase-7 claim on a boundary this phase proved is not there.

## Where the boundary actually is

The verifier-not-credential property, plus issuance gated on a paired client session, removes
the **replay** of a legitimately issued credential by anything that can read the machine. It
does not survive a same-uid writer, and the *Storage* section says so — nor does the pairing
ceremony itself, which *What the pairing ceremony does NOT establish* sets out above.

So the boundary is smaller than a boundary. What this phase actually delivers is that porch is
no longer the instrument of an *unrecorded* self-approval, and that an approval which went
through porch carries evidence of which capability, which session and which stated authority
made it — where before, every approval looked identical and none of them recorded anything.

That is provenance, not prevention. Against a same-uid adversary the difference is that the
approval is **visible in `status.yaml` afterwards**, not that it was stopped.

Everything else — the declared-principal refusal, the environment and cwd attribution — is
defence in depth, and is described that way here because describing it as more is what got the
previous two revisions falsified. A reviewer falsified the read-only framing of the paragraph
above for exactly the same reason, which is the third time on this document; the lesson is
that a claim survives only as far as the verb in it.
