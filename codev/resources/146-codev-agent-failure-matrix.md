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
| Capability presented after revocation | `HUMAN_SESSION_REVOKED` | Rejected as revoked, not as never-paired (`UNKNOWN` / `HUMAN_SESSION_REQUIRED`). Phase 5's revokeable object is the human-paired session Phase 6 issues against. Phase 6 must emit a distinct `CAPABILITY_REVOKED` rather than reuse this code. | No |
| `status.yaml` vs thread disagreement | `THREAD_ID_DISAGREEMENT` | Both values shown; porch remains authoritative. Human resolves. | **Never** |
| Stream lagged `status.yaml` (watcher miss) | `STREAM_PROJECTION_REPAIRED` | Snapshot applied; event type is `PROTOCOL_STATE_RECONCILED`, not a plain snapshot. Repair is visible. Bounded schedule (5s). Does not claim the macOS `watch()` arming window is closed. | **Yes** — projection repaired from its source |

## Codes the emitter produces beyond the twelve rows

The twelve rows above are the plan's required minimum. The service emits three
further codes, listed here because a matrix that omits them is a map with roads
missing. `FAILURE_MATRIX_SIGNAL` holds twelve entries by design; a length check
against it tests the constant, not the emitter, and cannot see these.

| Failure | Signal | Client renders | Auto-resolved |
|---|---|---|---|
| `global.db` unreadable for any non-lock reason (corrupt, schema mismatch) | `GLOBAL_DB_UNREADABLE` | Identity maps unavailable and **not retryable**, unlike `GLOBAL_DB_LOCKED`. Reporting a corrupt database as "locked" invites a retry loop instead of a restore. | No |
| Porch record names a thread, t3code still has it, but `global.db` has no identity row | `PORCH_RECORD_UNMAPPED` | Record kept; the missing join is named. Distinct from `PORCH_THREAD_NO_LONGER_EXISTS`, which asserts t3code lost the thread — a different fact with a different remedy. | No |
| A row carries both terminal-backed and thread-backed state | `IDENTITY_SHAPE_CONFLICT` | Row is refused as a join and reported. This is the guard behind Phase 8's "a row carrying both a `terminal_id` and a `thread_id` is rejected". | No |
