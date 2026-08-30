# Review: Spec 236 — production t3code snapshot, async gate approval, and an operator pairing command

Three mechanisms named in #228 as missing, each needing a decision before code. All three
landed; spec 146's criteria 3 and 9b are met, and the credential the issue was written around is
revoked.

## What was verified live, and what was not

Stated first, because the spec asked for it explicitly and because this initiative's recurring
defect is code that passes its tests and production never reaches.

| Verified by running the real thing | How |
|---|---|
| `afx pair issue / list / revoke` | Driven through `runAgentFarm(['pair', …])` against a scratch `CODEV_AGENT_FARM_DIR`: both purposes, list showing outstanding/redeemed/expired, revoke on a name with nothing live, exit code 1 for missing and unknown `--purpose` |
| **Revoking the real `dev-check` credential** | `afx pair revoke dev-check` against the operator's actual `~/.agent-farm`, once, by hand — see below |
| The client's whole approval path | Playwright/Chromium, 7 e2e passing, including a checks-enabled project approved from the UI |
| Every server and client unit path | 7132 + 265 passing |

| Not verified live | Why, and what stands in |
|---|---|
| **Criterion 3 against a live t3code server** | No thread-configured workspace exists on this machine, and this one has no `threads` block in `.codev/config.json`. The provider is verified against the **generated contract** (`packages/types/src/t3/generated/schema.json`) and a driven fake. The enumerating test reads its value list out of that contract rather than from a typed list, so a server that adds a session status fails a test here rather than rendering UNKNOWN in the field. |
| A second physical machine | The existing two-machine e2e stands up two hosts in one process. |

Criterion 3 is **met in the sense the spec defined it** — the distinctions are now sayable — and
the limit above is real: a row with no `thread_id` still has no session, and every architect and
builder row in `global.db` is terminal-backed today. Those rows now report *this row has no
t3code thread*, which is a third answer distinct from "not provided" and from "t3code returned
nothing". That distinction was what was missing; a `WORKING` stamp on a row with nothing running
would have been the older failure wearing a newer word.

## The `dev-check` revocation

The issue's context paragraph named a real credential that could not be revoked through the API.
Confirmed on 2026-08-29 by reading `~/.agent-farm/machines/`: one record, `dev-check`, expiring
`2026-11-28T02:28:09.850Z`, not revoked.

Run once, by hand, on 2026-08-30:

```
$ afx pair revoke dev-check
machine    dev-check
credential revoked
approvals  0 capability record(s) revoked

Every request from that machine now fails closed with MACHINE_CREDENTIAL_REVOKED.
No other machine was touched. Re-pair it with `afx pair issue` if that was a
mistake — revocation is a tombstone, so the old secret can never be revived.
```

Read back from the store afterwards: `dev-check REVOKED at 2026-08-30T10:19:11.703Z`.

**This is not a suite step and must not become one.** It writes the operator's real
`~/.agent-farm`, outside `CODEV_AGENT_FARM_DIR` isolation, and `revoke()` returns false on an
already-revoked record, so it is not idempotent. Automating it would have CI revoke real
credentials. **Recovery, if it was a mistake:** re-pair that machine —
`afx pair issue --purpose machine-credential`, redeem it — which mints a new credential; the old
secret is gone for good, which is the point of a tombstone.

## The three decisions the issue existed to force

### 1. Where per-workspace t3 config lives, and the staleness policy

**It already lived somewhere.** `.codev/config.json`'s `threads` block, read through the
five-layer loader by `readThreadBackendConfig()`, with `requestThreadBackend()` as a
non-blocking connector — all of it shipped in phase 9. Nothing new to invent; the answer to the
issue's first question is "there, and it has been since phase 9".

**Staleness:** `observedAt` tracks **subscription liveness**, not event arrival.
`orchestration.subscribeThread` has no cadence — an idle session emits nothing — so a window
keyed on events would age a live, watched, healthy session into `stale`. Ageing starts when a
subscription *drops*, so `stale` means "I am no longer watching this", which is a fact this
process holds. Content is discarded after ten minutes: an hours-old status is a wrong answer
with a disclaimer on it, and the disclaimer stops being read long before the content stops
being wrong.

The snapshot type went from three statuses to eight so the distinctions are sayable at all.
`connecting` and `cooling-down` are deliberately not folded into `unreachable`: one resolves on
its own, the other will not until a timer passes.

### 2. Where an asynchronous approval is stored, and what it reports while running

A **file-backed store** beside the capability and nonce stores — same root, same lock, same
"exists but will not parse" discipline. Not `global.db`: a schema migration for a record whose
natural retention is hours, in the store shared with every workspace's live agent state, is the
wrong trade.

**Six states**, kept apart because they send an operator six different places. `refused` is
deliberately not `failed`: porch declining a precondition is porch working. `running` carries
the phase and the check set — asked with porch's own `getPhaseChecks` after overrides — because
"running" with nothing beside it is a spinner.

Each record names its **owning host, pid and run id**. The store is keyed by
`CODEV_AGENT_FARM_DIR`, not by host, so an unscoped recovery pass would let a second Tower mark
a live host's operations interrupted. The run id exists for the case a pid check alone never
heals: a Tower that crashes and restarts with the same pid.

### 3. How `afx pair revoke` works for someone holding nothing

**Every subcommand is a direct store operation**, so revoking costs precisely what minting
costs and works with Tower down. `--purpose` is required with no default, because a token is
bound to one ceremony and a wrong guess fails at redemption — a different process, a different
route, a message about a token rather than about the choice made silently for the operator.

The trade is recorded in `146-approval-threat-model.md` under *Who can revoke*, and answers the
**availability** objection the route table actually raises rather than the confidentiality one:
a same-uid agent can already write these stores, so it can already deny a human their gate; the
command makes that denial convenient, not possible. Both route `rationale` strings now say so,
rather than the repository asserting the opposite of its own command in two places.

## What the reviews found that I would not have

Nineteen review rounds across seven phases. The findings worth carrying forward:

- **The wire could not carry the mapping.** Both lanes, on the plan: `t3code` was a bare string
  on both sides, so `observedAt` and settledness had no path to the client and criteria 3 and 4
  were unimplementable as planned. Caught before any code was written.
- **Two statuses that claimed more than the process knew.** An unobserved thread published as
  `available`; a ready backend with no threads reported `connecting` *forever* — the state every
  real workspace is in.
- **A lock timeout spelled as a corrupt file.** In the store whose entire purpose is keeping
  such pairs apart.
- **`pairRevoke` reporting a failure for a revocation that had succeeded**, then answering
  "nothing live to revoke" on the re-run, which reads as "never paired".
- **A running operation that never said what it was running** — the store accepted the fields,
  the response spread them, and the one call that would fill them passed neither.
- **A poll that could not read the state reported as a refusal** — collapsing, in the client,
  the unreadable/unknown distinction the server had spent four phases preserving.

**One shape accounts for most of them:** the rule applied in one place and not the adjacent one.
Poll but not submit. 403 but not 401. Element but not its CSS rule. Thrown fetch but not 5xx.
401/403 but not 404. Each fix was correct and each was too narrow by exactly one step.

**A second shape, and it is the more dangerous one: the fixture sharing the code's premise.**
Six separate instances in this one project, which makes it a pattern rather than bad luck — and
**all four were found by reverting the fix and watching what failed, never by a test going red on
its own.** That is the whole reason the habit is worth the minutes it costs: a fixture that agrees
with the bug is, by construction, invisible to the suite it lives in.

The four:

1. `pair revoke` set the capability store's host and the paired device both to `'ipad'`, so
   revocation matching on the host passed while the command withdrew nothing in any real
   deployment.
2. The subscription-cancellation test called the fake stream's `forget()` itself, so it asserted
   the effect while production never called the caller.
3. The receipt-in-query guard sent its attempt from a *different* machine, so `mayRead` refused it
   on the machine mismatch — the test passed with the query channel wide open.
4. The different-gate regression test drove a real approval for `plan-approval`, which is not
   valid for that protocol and phase, so the operation settled instantly and the test measured
   nothing.
5. Three auth tests built human sessions with no machine, and one seeded an operation with no
   machine — so nothing in the suite ever presented two identities that could disagree, and a
   session usable from any device looked exactly like one bound to its own.
6. Twenty-four client fixtures omitted the `projectId`, `gateName` and `receipt` that the real
   contract always sends, so the identity check could not fire in a test even when it worked —
   and the check itself had been written to tolerate exactly that absence.

Every one of them was invisible to a green suite, because the test agreed with the code.

**The fifth is a different and worse kind, and it is the one worth remembering.** The first four
were fixtures I wrote, or wrote beside, agreeing with a bug I had just introduced. The fifth
predated this project entirely: three pre-existing tests built sessions with no machine and one
seeded an operation with no machine, so the suite never presented two identities that *could*
disagree. It was not weak at checking the binding — it was **structurally incapable of testing
it**, and would have stayed that way through any number of careful reviews of its assertions.

A suite can only fail on a distinction its fixtures are able to express.

- `pair revoke` had a passing test in which the capability store's host and the paired device
  were both `'ipad'`. Capabilities key on the *verifying host*, so `revokeMachine('laptop')`
  matched nothing: the command reported `0 capability record(s) revoked` — truthfully — while the
  device kept a live capability. It worked only where the operator's laptop and the Tower host
  share a name, which is a fixture and never a deployment.
- The subscription-cancellation test called the fake stream's `forget()` itself, so it passed
  while production never called it. It asserted the effect and skipped the caller.
- Ownership of an approval operation persisted the *host's* name, which is the same string for
  every paired device — and the tests could not see it, because they configured one name.

The fix in each case is the same and it is not "add a test": make the fixture stop agreeing.
Two names where the code assumes one, and the test starts measuring what the operator does.

**And a fix can be correct while the request never reaches it.** Round 1 fixed a 403 in the
authorisation check; round 2 showed the same request now died at 401, one layer earlier, at route
authentication. Both rounds the durable record survived and the client still could not read it.
What broke the loop was the architect's instruction to write the *real* restart test first and let
it name each stop, rather than fixing the rejection in front of me.

## What running the real thing found that tests could not

Twice, and both times it was the decisive check:

1. **`afx pair issue` printed nothing, silently, with exit code 0.** `cli.ts` uses `parseAsync`,
   which awaits what an action returns; my actions wrapped their body in a discarded promise, so
   the process exited before the dynamic import resolved. Every unit test passed — they call the
   functions directly, and the defect was entirely in the wiring between Commander and the
   module.
2. **The e2e "shows what it is running" test asserted a spinner.** With instant checks the
   approval settled before the first poll, so the panel never left "Submitted" and the running
   frame — the deliverable — was never observed. The stand's checks now take longer than the
   poll interval, so the running state is reached by construction rather than by luck.

## Mechanisms added so a class of defect cannot recur

- `styled.test.ts` — every class the components emit must have a rule. Phase 6 shipped
  `.gate-progress` with no CSS, rendering at 16px inside an 11px panel, while every test passed
  because nothing in a suite can see a font size. It claims only that a rule exists, never that
  it is right; judging appearance still means opening the page.
- The failure-matrix collector now scans `lib/approval-operations.ts` and `commands/pair.ts`. It
  caught two of my own codes unclassified, one commit after I extended it.
- The enumerating session-status test reads the contract, so a t3code that adds a state fails a
  test rather than rendering UNKNOWN in the field.

## Mistakes worth recording

**A NUL byte in source.** `#ensureSubscribed` built its subscription key as
`` `${key}\x00${threadId}` `` — a literal NUL where a space was intended. Harmless while one
place both wrote and read the key; a silent failed `delete` the moment a second call site had to
agree with it. Invisible in an editor and in a diff. Both sites now go through one function, and
all 29 files changed on this branch were scanned for NUL bytes.

**`porch next` piped into `porch done`, twice.** Both times it marked the *next* phase's build
complete before that phase existed. Caught at the same point both times — the consultation would
have reviewed nothing — and the phase was implemented before any review ran, so no reviewer was
misled. But writing the lesson down after the first did not prevent the second. The rule that
replaced the resolution: after any approval, run `porch status` and read which phase is open
before running anything else.

## The rule was written down three lines away

The receipt — the bearer secret that makes an interrupted approval readable after a restart —
travelled as `?receipt=`. Both review lanes found it independently.

`agent-auth.ts` already carried the rule, immediately above where the receipt's constant now
sits: credentials are headers, because "a URL lands in access logs and a command line lands in
`ps` output". So this was not an unforeseen hazard; it crossed a documented line in the file next
door, in a project whose recurring finding is the rule applied in one place and not the adjacent
one.

Tower logs `req.url` in two places, and the second one matters more than the first: the boot
window 503, **and every authentication failure** — which is exactly when a client polling across
a restart arrives. The leak fired in the scenario the receipt exists for. Reverse proxies log
query strings as a matter of course, so the exposure was never bounded by our own logging.

The fix is a header, read from the request, advertised in preflight. The part worth keeping is
the guard: the query channel is asserted **closed at the server**, not merely unused by our
client, and no source file may build `?receipt=` or read one from `searchParams`. Assert the
absence, because the query string is the convenient place to put a value and convenience is what
put it there.

**And the first version of that guard measured the wrong refusal.** The query-string attempt used
a different machine credential, so `mayRead` refused it on the machine mismatch and the test
passed with the channel wide open. Caught by reverting the fix and watching what failed. Same
machine, no session, and the receipt is the only thing that can authorise — now the status
reports the channel. Third instance in this project of a fixture agreeing with the bug.

## The fix that broke the contract it depended on

Round 2's negative cache computed its config signature *above* `requestThreadBackend`'s try
block. `configLayerPaths` reaches `resolveProjectConfigPath`, which throws on a legacy
`af-config.json` — so the function whose entire value is that it **cannot throw**, the
synchronous always-answers contract #221 spent three rounds establishing for Tower's drain tick,
could now throw.

The failure mode is this project's own subject: one caller catches and leaves the workspace at
`connecting` forever, the other does not catch at all. An "I could not tell" rendered as a state,
with no error anywhere.

A signature that cannot be computed is a reason to **read**, never a reason to throw. It now
degrades to an uncacheable answer inside the try.

Two things worth keeping from this. First, the shape: *making something cheaper put a new failure
into the one path that had none*, and nothing in the change looked like it touched error
handling. Second, my test for it initially wrote `af-config.json` to `.codev/` instead of the
workspace root, so it did not throw and the green meant nothing — caught by reading
`resolveProjectConfigPath` rather than trusting the pass.

## A conflict is not a refusal

`APPROVAL_ALREADY_IN_FLIGHT` was rendered as a plain refusal, which the panel paints in the same
red as a genuinely refused approval. The case that produces it is the **retry after a lost 202**:
the human clicked, nothing came back, they clicked again. So the operator was told their gate was
refused — about a run that might be succeeding, on the one action the client exists to perform.
It was the last place in this project where "I could not tell" was still spelled the same as
"no", and it was on the deliverable.

Fixed as a recovery rather than as a better error message. The host recognises the submitter —
same session *and* same machine — and hands back the operation it already started, id and receipt
included, so the existing poll loop resumes the original run. Another session still gets a 409,
because it did not start that run and must not receive its receipt; but the operation id is now a
field instead of a sentence to parse, and the client reports it `unconfirmed`.

The server's comment already said "poll that one rather than submitting a second run" while the
structured rejection omitted the id — a comment describing behaviour the code did not support.
That is the sixth instance of that shape in this program and the first that was mine.

**The test needed a run that was still running.** With instant checks the first operation settles
before the retry lands, so the retry legitimately starts a new one and the test measures nothing
— exactly how the e2e "shows what it is running" case failed earlier here. What makes it a
recovery rather than a claim of one: the outcome observed is the ORIGINAL operation's, and
exactly one operation exists for the episode, so the checks did not run twice.

## Absent read as permitted, four times

The single most repeated defect in this project, and it took four instances before it was named as
one shape rather than four bugs:

1. `identityMismatch` rejected an operation's project and gate **only when they were present**, so
   a body that omitted them settled the gate.
2. A 202 **without a receipt** was accepted, and then polled on a footing that cannot survive the
   restart the receipt exists for.
3. `mayRead` authorised on `caller.machine === undefined || …`, so a caller that named no machine
   passed the machine check.
4. `recognize(presentation, machine?)` took the machine as **optional**, so a caller that omitted
   it got no binding and no error — the same defect as (3), one call further out.

Each was written as a considered check. Each was written by someone (me) who had just spent a
round arguing that unknowns must not be reported as answers. The inversion is what makes it hard
to see: everywhere else this project removed *"I could not tell" spelled as "no"*, and here
a silence was read as a **yes**, which does not feel like the same mistake while you are making
it.

**The fourth was found by grep, not by a lane** — the architect asked for a sweep of my own new
code for `=== undefined ||` and `if (x) check(x)` shapes on any authorisation or identity path,
and it turned one up immediately. That is the transferable part: once a defect has appeared three
times it is cheaper to search for the shape than to wait for the fourth report.

**The fix that generalises is a type, not a condition.** Making `machine` required produced three
compiler errors on the spot, because `AgentAuthOutcome.machine` and `verify().machine` are both
`string | undefined` — the optional parameter had been silently accepting exactly the values that
cannot be bound. Where a value genuinely may be missing, the two dispatch sites now pass a
sentinel that can never match a stored name, so absence **refuses** instead of skipping the check.
A conditional would have been the fifth instance.

## A failing retry kept stale content fresh

`settle()` stamped an entry's drop time on every subscription end, and the maintainer retries a
failed subscription every sweep. So an entry observed once, whose subscription then failed
permanently, had its drop time reset twelve times a minute — indefinitely. It never aged past the
freshness window, never became `stale`, and was never discarded.

The failure refreshed the freshness. It also removed the last bound: a reviewer had noted that
`available` was ultimately limited by t3-client's 300s stream idle timeout, and a retry loop that
re-stamps never reaches any timeout.

Measured from when watching **stopped**, and it stops once — only a true-to-false transition
stamps.

## The command no agent could find

`afx pair` is the operator entry point this project existed to build; #228 named its absence as
the reason criterion 9b was unreachable in production. It was documented in the remote-access
runbook and the client README — both places a human looks.

`CLAUDE.md` instructs every agent to check the skill rather than guess a command. So the command
existed and was, to every agent in the system, invisible. The next builder needing it would have
concluded it does not exist — which is exactly what happened when this project's own gap was
filed.

Grepping for files that enumerate afx subcommands found **six**, not the one named: the `.claude`
and `.codex` skills in both trees, and `resources/commands/agent-farm.md` in both. Documentation
in this repo is mirrored in more places than it looks, and the number is not guessable.

Checking the new entry against the CLI rather than against memory corrected two flags in it.

## Absent is not agreement

The client-side gate check added in round 5 was written as *reject if present and different*. A
body that **omitted** the project and gate therefore passed — and a body that says nothing about
which gate it describes is exactly the body that must not settle one.

This is the project's own subject inverted. Every other finding removed "I could not tell" being
spelled as "no". Here a silence was read as a yes.

Two things make it worth more than its one-line fix. The first is that the check had already been
argued for correctly, in the review of the round before: *two checks that share an assumption are
one check*. This one shared a different assumption — that the field would be there — and the
argument that produced it did not reach that far.

The second is that **the fixtures demonstrated the hole**. Twelve 202 bodies and twelve poll
bodies in the client suite omitted the identity fields the real contract always sends, so the
check could never fire in a test even when it was working. Sixth instance, and like the fifth the
blindness predated the check: nothing in the file ever sent a body that *could* disagree.

Requiring the fields is safe against every host that can produce a 202 here — a host predating the
route answers 404 and a current host with no operation store answers 501, and both take the
synchronous path. Absent and different get different words in the message, because they send a
reader to different places: one is a host that did not say, the other is a host that said
something else.

The same shape appeared once more in the same round: a 202 without a receipt was accepted and then
polled on the memory-backed session alone. That works right up until the host restarts, which is
the one case the receipt was built for. The contract always returns one, so its absence is not an
older host to accommodate.

## A count nobody recomputed

`seven emitted by this provider` appeared in the spec, the client README, a test's docblock and
that test's own title — while the assertion inside it listed **six**.

Two statuses are excluded and for two unrelated reasons: `unreachable` has no connector state
behind it, and `not-provided` is what a host wiring *no* provider reports. The sentence was
written when only the first was known, and the second never sent anyone back to the number.

Worth recording because of how it was found: grepping for the *claim* rather than fixing the two
lines a reviewer named turned two sites into four. A count is a derived fact stated as a literal,
and nothing recomputes it.

## Two credentials, never compared with each other

The strongest finding in the project, and it needed no bug in either credential.

A human session and a machine credential were both verified, correctly, and **independently**.
Nothing compared them. So a session opened on one device could be presented alongside another
device's credential and every check passed — the per-device ownership and revocation model this
spec exists to build, defeated by presenting two valid things that were never put side by side.

It is the same conflation as an earlier round's, one layer up. Round 2 separated `machine` (the
verifying host) from `pairedMachine` (the device) because two different things shared one name.
This was two names for two different things that were never compared at all. **A verification is
not a check of identity unless something joins the pieces.**

Bound at three points on purpose: at issuance, where the route supplies the authenticated caller's
own machine rather than a value the client asks for; at the single authentication choke point,
because a route that forgot would be a hole with no visible cause; and inside `mayRead`
independently, because it is exported and a rule that holds only because its one caller checks
first will be wrong the moment a second caller appears.

Refused with 403 rather than 401: the session is real and may be in legitimate use on the other
device, so what is refused is using it *here*. A 401 sends a client into a re-pair loop that
cannot fix what is actually wrong.

`mayRead` was the sharp end. Its receipt branch had always required the machine to match; its
session branch returned true on a session id alone. **The path holding the weaker credential
carried the stronger check.**

That asymmetry is why this survived six rounds of review. The receipt path was added last, under
scrutiny, for the hard case — so it got the careful thinking. The session path is what almost
every caller actually takes, and it was already there. **Scrutiny went where the novelty was, not
where the traffic is**, which is a bias worth naming because it is invisible from inside a review:
the new code is the code you are looking at.

And the fixtures hid it, for the fifth time: three tests built sessions with no machine at all, so
nothing in the suite ever presented two identities that could disagree.

## The panel said "Submitted" before anything was

`onProgress` fires only once the host answers 202, so a null progress is the window covering
capability issuance, nonce minting and the POST — any of which may be hanging. It rendered
"Submitted. Waiting for the server to start the work."

A small text defect and the same class as the rest: telling a human that a thing happened when it
has not, on the one action the panel performs. The `data-state` attribute was changed alongside
the words, because a test asserting the state would otherwise have gone on agreeing with the claim
the text used to make.

## Making one report honest opened a way for another to lie

This is the strongest thing this project has to say, and it is an argument for reviewing the FIX
rather than only the bug.

Round 4 fixed a real reporting defect: an in-flight approval was rendered as a refusal, so the
operator was told their gate was refused about a run that might be succeeding. The fix was a
recovery — recognise the submitter, hand back the operation it already started, resume polling it.
Correct in its own terms, tested, and reviewed.

Round 5 found that the fix had opened a worse defect than the one it closed. Single-flight is
project-wide, so the operation handed back might belong to a different gate, and the client would
then report **that** gate approved from **this** record.

Nothing about the round-4 change looked like it touched correctness of attribution. It was
recognisably a fix to how an outcome is *reported*, and it created a way for an outcome to be
reported about the wrong object. A review that had checked only the original bug — is an in-flight
approval still rendered as refused? — would have passed it.

The corollary, which is why the client-side check exists: **two checks that share an assumption
are one check.** The client validates the operation's project and gate independently of the
server's restriction, because the server getting it wrong is precisely the case that needs
catching, and a check derived from the same premise cannot catch it.

## The worst shape, and it was mine for one round

Round 4's recovery matched an in-flight operation on session and machine. Single-flight is
PROJECT-wide, so the operation found for a request is not necessarily that request's gate — and a
request to approve gate B could be handed gate A's operation, polled to success, and reported as
**gate B approved**.

Every other conflation this project removed was a true thing reported as unknown, or an unknown
reported as false. This one is a false thing reported as true, attributed to the wrong object, on
the approval path. It is worth recording plainly that it was introduced by a fix for a different
reporting defect: **making one report honest opened a way for another to lie**, and nothing in the
change looked like it touched correctness of attribution.

Fixed on both sides on purpose. The server restricts recovery to the same workspace, project and
gate. The client independently compares the operation's project and gate against the one it asked
about, on the 202 and on every poll, and reports `unconfirmed` on a mismatch. The client check is
not redundant with the server's: it is the half that does not depend on the other half being
right, and an approval outcome is not a place to trust one implementation.

The regression test seeds the in-flight record rather than driving a second real approval — the
first version drove one for a gate that is not valid for that protocol and phase, so it settled
instantly and measured nothing.

## The fallback that could not fire

The client fell back to the synchronous route on HTTP 501, under a comment promising compatibility
with "a host running an older build". A host running an older build has no such route at all: its
dispatcher answers 404 `AGENT_ROUTE_NOT_FOUND`. 501 is a CURRENT host that recognises the route
and wires no operation store — a real case, and not the one described.

So an upgraded client lost gate approval entirely against an older Tower, while the code said it
would not. The fixture was named `NO_ASYNC` and commented "the 501 an older host answers": the
fixture agreeing with the code, for the fourth time in this project.

Now: 501 **or** 404 carrying that signal. Narrow on the signal rather than the status, because
other 404s from this route — an unknown workspace, one this host does not serve — are real answers
that must not silently take the synchronous path.

## A record from a host that never comes back

`resolveInterrupted` refuses to settle another host's records, correctly: this host cannot tell a
dead foreign process from a slow one, and declaring a live one dead would report an approval
interrupted while it runs. But retention sweeps only TERMINAL records — so a host permanently
removed from the fleet left nonterminal records that nothing could ever settle, blocking that
project's approvals forever, with no message and no command to clear it.

The fix separates two rules that had been one:

- **Single-flight stays cross-host.** Two runs of one project's checks racing is exactly what it
  exists to prevent, so it must see every host's records. What changed is that a foreign
  nonterminal record older than a six-hour lease is settled `interrupted`, naming the host, with
  `gateAfterInterruption: 'unreadable'` — because only that host could say. There is no heartbeat,
  so the lease is deliberately longer than any check here; the point is that it is finite.
- **The concurrency cap is per host now.** It bounds this machine's load — each operation is a
  build and test suite inside this process — so another host's runs must not consume it. A
  host-wide cap was added alongside the per-workspace one, because per-workspace alone does not
  bound a Tower serving fifty workspaces.

## A knob only tests could turn

`submit(…, { maxConcurrent })` was a parameter with a hardcoded default of 2 and no production
caller — #222's pattern, and this one was mine rather than inherited. It reads as configurable,
so the first person needing a different limit changes a call site nothing in production reaches
and believes they have configured the host.

Dropped to a named constant rather than wired: the store is one object serving every workspace
while the limit is per-workspace, so a config key has no obvious home yet. It gets one when a
host actually needs a different number, together with the caller that reads it. The two tests
that tuned the parameter now exercise the real limit — they would previously have passed with the
shipped number set to anything at all.

## A freshness guarantee borrowed from another package

`observedAt` records subscription liveness rather than event cadence, deliberately: a quiet
thread is not a stale one. The consequence is that an entry cannot age into `stale` while the
subscription is believed open, and what bounds that belief is `packages/t3-client`'s 300s stream
idle timeout — not anything in this module. A silently dead socket reads as `available` for up to
five minutes.

Recorded at the constant rather than fixed. A second timer racing the first is worse than the
borrowed one; what was missing was anyone knowing the guarantee was borrowed, so raising
`streamIdleTimeoutMs` in that package now has a comment saying what it silently lengthens here.

## What the sweep cost while nothing was wrong

`requestThreadBackend` answers `ready`, `connecting` and `cooling-down` from memory. The two
verdicts that needed the config read — `not-configured` and `misconfigured` — are the verdicts of
every workspace that never opted into threads. So Tower's 5s sweep ran a full five-layer
`loadConfig` per unconfigured workspace per pass: four reads, four deep merges and the validators,
twelve times a minute each, on the event loop, **scaling with accumulated `known_workspaces`
rather than with active use.** #221 spent three rounds getting a network call and then a sync
syscall off that loop.

Cached against a signature (mtime and size of the config layers, plus the env vars that
short-circuit them), not a TTL. A TTL makes an operator who has just written their t3 config wait
it out, and the number becomes something to argue about; a signature invalidates on the pass after
the edit and has no dial. `configLayerPaths` is extracted so `loadConfig` and the cache walk one
list — a second copy of the layer order would go stale silently the moment a sixth layer is added,
and the cache would keep answering from before it existed.

Measured at `fs.readFileSync` rather than asserted: 12 reads per workspace per minute to 0, with
the test failing at 12 when the cache is disabled. The known limit is stated in the code: identical
size *and* identical mtime read as unchanged, which every mtime cache carries and which the
alternative is the read it exists to avoid.

## Flaky Tests

No test was skipped or annotated as flaky by this project, and nothing was routed around.

One pre-existing test timed out once on the round-5 full run —
`src/terminal/__tests__/session-manager.test.ts > "no stderr tail logged for file-based stderr
(Bugfix #324)"`. It passes running its file alone (91/91), it is `it.skipIf(!!process.env.CI)` so
CI never runs it, and it touches the PTY session manager, which this project does not.

It then recurred on the round-8 run — a different head, 40+ other files changed, an identical
30211ms timeout at the same line, and 91/91 alone again immediately after. Two runs differing by
most of a branch and producing the same signature points at total suite load, not at content.

**Recorded on issue #200, not here.** That issue is exactly this failure — the test runs out a
poll and then asserts, so a timeout and a product failure are spelled the same way — and it
already carries a night of evidence from another builder. One more instance is worth more
attached to that evidence than sitting in a review nobody will grep. Annotating someone else's
test as flaky on the strength of one timeout would have been a claim not earned here.

## Environment notes for the next builder in a fresh worktree

Both cost real time here and neither is a code problem:

- A fresh builder worktree has **no `node_modules`**. `pnpm install --frozen-lockfile` first.
- **`packages/codev/skeleton/` is a gitignored build output, and its absence fails 18 test files
  / 80 tests** that have nothing to do with any change — protocol resolution falls back and it
  surfaces as `Unknown review type "pr" … protocols available here: "impl"`. `packages/codev/dist/`
  similarly fails the shellper integration tests. `pnpm -w run build` clears both. I nearly
  reported those 80 as a regression.
- This worktree was spawned **49 commits behind `origin/main`** and had none of the phase-11 code
  the issue describes. Nothing in the issue reproduced until `origin/main` was merged in.

## References

- Issue #236; issue #234 (phase 12's tiling and static mount, explicitly out of scope here).
- `codev/specs/236-spec-146-production-t3code-sna.md`, `codev/plans/236-spec-146-production-t3code-sna.md`.
- `codev/resources/146-approval-threat-model.md` — *Who can revoke, and the trade that decides it*.
- `codev/resources/146-codev-agent-failure-matrix.md` — *Spec 236* section.
- `codev/state/aspir-236_thread.md` — the running narrative, including every review round.
