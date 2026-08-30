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
Three findings in the final round were invisible to a green suite because the test agreed with
the bug.

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

None. No test was skipped or annotated as flaky during this project.

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
