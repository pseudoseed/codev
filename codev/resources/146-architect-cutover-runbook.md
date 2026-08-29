# Architect cutover runbook (Spec 146 Phase 9)

Cutover is per workspace. An architect conversation cannot be migrated. Do one workspace, live with it, then the next.

**Do not run this against `codev-1455` while its architect session is in program.** This file was dry-run against the procedure only. The live `/arch-save` capture is not in this run.

## Preconditions

- Phase 8 `thread_id` columns exist on `architect` and `builders`.
- A ThreadEngine is registered in-process (`setThreadEngine`). Without one, `afx spawn` stays on the PTY path.
- `ps aux | grep -c '[s]hellper'` shows headroom under Tower's 100-session cap. If you see `Maximum 100 sessions reached`, stop. Do not retry. (#171 leaks a process on every rejected create.)

## Procedure

1. In the target workspace, `/arch-save` the PTY architect. Confirm `codev/state/<name>.md` was written and is not a stub.
2. Record what the saved file contains: identity, in-flight work, pins, anything the next session must know.
3. Stop the PTY architect (`afx workspace stop` is not enough if siblings must live; stop that named session only).
4. Start the thread-backed architect: `afx workspace add-architect --name <same-name>` with a ThreadEngine registered. Worktree is the workspace root.
5. Re-init from the saved state (`/arch-init` or the harness equivalent).
6. Live with it. Send `afx send architect:<name>` and confirm it is a turn on that thread, not a PTY write.

## Rollback trigger

The spec names the rollback: an architect cutover that loses state the saved file did not capture.

**What `/arch-save` did not capture on this run:** not measured. This runbook was dry-run; `/arch-save` was not executed, so the missing fields are unknown. The first live cutover must fill this section before the next workspace.

## Rollback

1. Stop new thread-backed spawns (`setThreadBackedSpawnsEnabled(false)`). `afx spawn` returns to PTY immediately.
2. Restore the architect from the `/arch-save` file on a PTY session.
3. Do not drop a thread with unmerged work.
