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
