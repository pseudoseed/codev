# air-173

Implementing phase 9 as AIR after the architect's scrutiny note.

ThreadEngine is injectable. `installThreadSpawnFactory` is called from `spawn()` only when an engine is already set, so existing PTY spawn tests stay on PTY. Tests install the memory engine.

#167: attach/stop/reset throw `thread-backed, unsupported here`. status/send/interrupt/cleanup/dev have thread implementations. Render gate (`resolveLiveSessionForAgent`) throws rather than holding `no-live-pty`.

Identity: `CODEV_THREAD_ID` wins over cwd. Spoofing stays in `resolveTarget` / `resolveAgentInRegistry` (codev-agent).

Cutover runbook is dry-run only. Did not cut over the codev-1455 architect. Did not run the 1+6 concurrency measurement (session-cap risk, #171).

