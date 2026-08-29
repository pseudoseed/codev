# codev-agent failure matrix (Spec 146, Phase 5)

Each row is a distinct signal. An unreachable server, an empty result and a
malformed file must never share a code: a partial answer reads as a complete
negative one. A thread with no matching porch record renders as **unmanaged**,
never hidden. Disagreement is reported, never auto-resolved.

`Auto-resolved` means the server mutates `status.yaml` or `global.db` to make
the failure go away. Transient rows clear on the next successful snapshot once
the cause lifts; that is not a repair.

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
