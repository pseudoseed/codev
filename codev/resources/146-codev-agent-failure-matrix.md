# codev-agent failure matrix (Spec 146, Phase 5)

Each row is a distinct signal. An unreachable server, an empty result and a
malformed file must never share a code: a partial answer reads as a complete
negative one. A thread with no matching porch record renders as **unmanaged**,
never hidden. Disagreement is reported, never auto-resolved.

`Auto-resolved` for two authorities (`status.yaml` vs thread state) means the
server picks a winner and writes a store: **never**. For a projection and its
source (the stream vs `status.yaml`) it means the server re-reads the file and
emits a visible repair. Transient rows clear on the next successful snapshot
once the cause lifts; that is not a repair.

| Failure | Signal | Client renders | Auto-resolved |
|---|---|---|---|
| `codev-agent` down | `CODEV_AGENT_UNREACHABLE` | Protocol state unavailable. Not an empty project list. | No |
| `codev-agent` up, t3code down | `T3CODE_UNREACHABLE` | Porch state still shown; thread liveness unknown. Threads not dropped. | No |
| t3code up, `codev-agent` down | `CODEV_AGENT_UNREACHABLE_T3CODE_LIVE` | Threads from t3code remain; protocol badges unavailable. Missing porch state is not "no projects". | No |
| Artifact root gone (builder row outlives its worktree) | `ROOT_MISSING` | Root is missing, not an empty project list. | No |
| `status.yaml` unreadable | `STATUS_UNREADABLE` | Named project marked unreadable, not missing. | No |
| `status.yaml` malformed | `STATUS_MALFORMED` | Named project marked malformed, not missing. | No |
| Thread with no porch record | `THREAD_UNMANAGED` | Thread shown as **unmanaged**. | No |
| Porch record whose thread is gone | `PORCH_THREAD_NO_LONGER_EXISTS` | Porch record kept; thread marked gone, not deleted. | No |
| `global.db` locked | `GLOBAL_DB_LOCKED` | Identity maps unavailable. Empty maps are not "no architects". | No |
| Revoked human-session credential presented | `HUMAN_SESSION_REVOKED` | Rejected as revoked, not as never-paired (`UNKNOWN` / `HUMAN_SESSION_REQUIRED`). Phase 5's revokeable object is the human-paired session Phase 6 issues against. Phase 6 emits a distinct `CAPABILITY_REVOKED` rather than reusing this code — see the row below. | No |
| Revoked approval capability presented (Phase 6) | `CAPABILITY_REVOKED` | Rejected as **revoked**, which sends the operator to reissue — never collapsed into `APPROVAL_CAPABILITY_EXPIRED` (wait or reissue), `APPROVAL_CAPABILITY_INVALID` (fix the client) or `APPROVAL_CAPABILITY_UNKNOWN` (never issued here). Revocation is a tombstone, not a deletion, for exactly that reason. | No — a human revoked it; only a new issuance clears it |
| `status.yaml` vs thread disagreement | `THREAD_ID_DISAGREEMENT` | Both values shown; porch remains authoritative. Human resolves. | **Never** |
| Watcher cannot be established on a root | `STATE_STREAM_WATCH_FAILED` | That root is announced as degraded: its changes now arrive only via the 5s reconciliation backstop. The initial snapshot still arrives — a failed watcher is not a failed stream. Not spelled as a healthy stream. | No — reported; the backstop covers delivery but the degradation stands |
| Stream lagged `status.yaml` (watcher miss) | `STREAM_PROJECTION_REPAIRED` | Snapshot applied; event type is `PROTOCOL_STATE_RECONCILED`, not a plain snapshot. Repair is visible. Bounded schedule (5s). Does not claim the macOS `watch()` arming window is closed. | **Yes** — projection repaired from its source |

## Codes the emitter produces beyond the rows above

The rows above cover the plan's required minimum plus `ROOT_MISSING`,
`STATE_STREAM_WATCH_FAILED` and `STREAM_PROJECTION_REPAIRED`. The service emits three
further codes, listed here because a matrix that omits them is a map with roads
missing.

**No count is stated here on purpose.** An earlier version of this document and the
test both carried one, and the test's number described the `FAILURE_MATRIX_SIGNAL`
constant rather than the emitter — so it read as a completeness claim while codes it
had never seen shipped past it. The guarantee now lives in
`agent-failure-matrix.test.ts`, which scans the emitters directly and fails on any
code that is neither a row here nor an explicitly justified exclusion. A number in
prose cannot do that, and a number that drifts is worse than none.

| Failure | Signal | Client renders | Auto-resolved |
|---|---|---|---|
| `global.db` unreadable for any non-lock reason (corrupt, schema mismatch) | `GLOBAL_DB_UNREADABLE` | Identity maps unavailable and **not retryable**, unlike `GLOBAL_DB_LOCKED`. Reporting a corrupt database as "locked" invites a retry loop instead of a restore. | No |
| A builder worktree holds several porch records and none names the thread | `PORCH_JOIN_AMBIGUOUS` | The managing record is **unknown, not absent**. Distinct from `THREAD_UNMANAGED`, which asserts nothing manages the thread — a different fact with a different remedy. Resolved once Phase 8 writes `thread_id`. | No |
| Porch record names a thread, t3code still has it, but `global.db` has no identity row | `PORCH_RECORD_UNMAPPED` | Record kept; the missing join is named. Distinct from `PORCH_THREAD_NO_LONGER_EXISTS`, which asserts t3code lost the thread — a different fact with a different remedy. | No |
| A row carries both terminal-backed and thread-backed state | `IDENTITY_SHAPE_CONFLICT` | Row is refused as a join and reported. This is the guard behind Phase 8's "a row carrying both a `terminal_id` and a `thread_id` is rejected". | No |

## Spec 236: the t3code session provider and asynchronous approvals

Three additions to the emitter, each a row because each is a state an operator
diagnoses rather than a request that was wrong.

| Failure | Signal | Client renders | Auto-resolved |
|---|---|---|---|
| This host stopped while an approval was running | `APPROVAL_OPERATION_INTERRUPTED` | **Not a failure of the approval.** The record carries what `status.yaml` says about that gate NOW — including `approved`, because a host can die after porch wrote the gate. Rendered as unknown, never as refused: telling a human their gate was not approved would send them to approve one that already is. | No — but the gate state IS re-read, so the answer is current |
| An approval operation id this host has never held | `APPROVAL_OPERATION_UNKNOWN` | "No such operation", which sends a caller to check the id it was given. Distinct from the row below. | No |
| The approval operation store exists and will not parse | `APPROVAL_OPERATION_STORE_UNREADABLE` | "The store could not be read", which sends someone to the host. Spelling this as `UNKNOWN` would tell a client its approval never existed because a file is corrupt. The client retries it rather than reporting a refusal, because an unreadable store is not a verdict on the gate. | No |

### Session state is not in this matrix, and that is deliberate

Spec 236 wired the `t3codeSnapshot` provider, and the eight statuses it publishes
(`not-provided`, `not-configured`, `misconfigured`, `connecting`, `cooling-down`,
`unreachable`, `available`, `stale`) are **not** matrix rows. Only `unreachable`
and `cooling-down` are failures at all, and both already emit the existing
`T3CODE_UNREACHABLE` row. The rest describe what this host is doing — reading
config, connecting, waiting out a timer, holding content it has stopped watching
— and a matrix that listed them would be describing a state machine, not
diagnosing a fault.

The distinction the matrix does care about is preserved: `not-configured`
(this workspace names no t3code server) never borrows `T3CODE_UNREACHABLE`, because
sending an operator to check a server that does not exist is a confident wrong
diagnosis, which is worse than a missing one.

### Where the completeness guarantee lives

Unchanged, and worth restating because this section adds emitters:
`agent-failure-matrix.test.ts` scans the emitting files directly — now including
`lib/approval-operations.ts` and `commands/pair.ts` — and fails on any code that
is neither a row above nor an explicitly justified exclusion. The successes and
refusals from both (`APPROVAL_OPERATION_SUBMITTED`, `APPROVAL_OPERATION_SETTLED`,
`APPROVAL_ALREADY_IN_FLIGHT`, `APPROVAL_CONCURRENCY_LIMIT`,
`APPROVAL_OPERATION_ALREADY_SETTLED`, `APPROVAL_OPERATION_STORE_LOCKED`,
`APPROVAL_OPERATIONS_NOT_AVAILABLE` and the seven `PAIR_*` codes) are exclusions
carrying a reason each: they answer "your request was wrong, or it worked", never
"a service or file failed".
