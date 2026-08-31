# air-271 — architect created by afx lands with codev_role empty

Issue #271. AIR, strict mode.

## What the investigation actually found

The role is **not** lost anywhere in the merged tree. Every layer the architect named
forwards it, and I verified the whole chain end to end against a live fork server.

The thing running on hardware was a **stale global install**:

```
/Users/chris/.nvm/versions/node/v20.19.2/lib/node_modules/@cluesmith/codev
  dist/agent-farm/porch-thread-engine.js   forwards roleContent/roleFilePath only, never input.role
/Users/chris/.nvm/.../@cluesmith/porch-driver
  dist/thread.js                            no role on the thread.create payload at all
```

Both are pre-spec-250 builds carrying version 3.3.1, the same version as the source, so
nothing about the version string says they are behind. `pnpm -w run local-install` is the
step that was missed after #266 merged.

The decisive evidence is the event, not the projection:

```
sqlite3 ~/.t3/dev/state.sqlite "select payload_json from orchestration_events where event_type='thread.created'"
{"threadId":"2e2bd2c7-...","title":"architect-lan",...,"role":null,"parentThreadId":null,...}
```

`role: null` in the event means the decider was handed a command with no role — the client
never sent one. The server, the event payload and the projection writer are all innocent;
all three were read and all three carry it.

## Two corrections to the report

**The architect WAS registered.** `global.db` has it, written 24 ms after the thread:

```
/Users/chris/dev/codev-1455|lan|0|0||2026-08-31T15:37:09.219Z|||2e2bd2c7-...|claude|claude-haiku-4-5
```

So `createArchitectThread` returned and `setArchitectByName` ran. What could not see it was
`afx status`, which built its Architects section entirely from Tower's terminal list —
and a thread-backed architect has no terminal, by definition. Registered and invisible,
which reads from outside exactly like a command that did nothing.

**The 2-minute hang is a third fault, not the same one.** The thread branch of
`workspace-add-architect` returned without `closeThreadBackend`, so the open WebSocket kept
the event loop alive and the process never exited. `afx interrupt` already carries this fix
with a comment describing the identical symptom.

## What shipped

1. `issue-271-architect-role-live.e2e.test.ts` — drives `createArchitectThread` against a
   `start-fork` server and reads `codev_role` out of the server's own `projection_threads`.
   Nothing in it writes `role` on a payload. Verified failable: removing the forwarding in
   `porch-thread-engine.ts` reproduces `role: null` exactly, the hardware symptom.
2. `closeThreadBackend` in a `finally` in `workspace-add-architect`, so the command exits.
   Ordering asserted (register, then close) — closing first would exit a process whose
   registration had not landed.
3. `afx status` lists thread-backed architects from state, de-duplicated against the ones
   Tower already listed, with `threadId` added to the `--json` payload as
   nullable-not-optional.

All six new assertions were confirmed to fail with their fix reverted.

## Notes for whoever runs this next

- The fork checkout `/Users/chris/dev/t3code-codev` had an uncommitted `tools/lan-serve.mjs`,
  and `t3-server.mjs start-fork` refuses a dirty checkout. I parked it, ran, and restored it
  byte-identical. It is untracked work someone will want; do not delete it. A run of the live
  e2e test will skip with a reason while it sits there.
- The live test needs `T3_NODE` pointing at a Node 22 binary and `T3_HARNESS_PORT`. It skips
  with a stated reason otherwise; it never passes for want of a server.
- `~/.t3/dev` is the fork's `vp dev` server, not the harness's. The harness uses
  `tools/t3-server/.runtime/data/userdata/state.sqlite` and starts on empty data.

## Left out, deliberately

Nothing in a new build can stop an OLD build from dropping a field silently — the old code
is what runs. Making a stale install detectable (a build-provenance check on `afx`) is real
and is a different issue; raised with the architect rather than grown into this one.
