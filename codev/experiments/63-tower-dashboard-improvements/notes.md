# Experiment 63: Tower dashboard improvements

**Status**: Complete · **Date**: 2026-08-23

**Provenance.** Produced by a spawn-path collision (issue #65), not by assignment. `afx spawn 63` named `codev/specs/0063-tower-dashboard-improvements.md` because afx zero-pads the issue number. Spec 0063 is Status: Conceived. It was never approved, never planned, never built. It has sat in the tree since v1.6.0. This experiment answers that spec. It is not the work GitHub issue #63 asked for.

Same collision as experiments 38 and 39. Those builders noticed. This one did not.

## Goal

**Question.** Can spec 0063's one-row list, five action buttons, and closeable command-output terminal be met on today's Tower landing without ttyd and without bringing back `afx start --remote`?

**Hypothesis, locked before the prototype ran.**

1. One row per running workspace is a markup change. Recents already render that way. The nested Overview / terminal / New Shell list is what makes a running card taller than one row. Flattening does not need a new API.
2. The five buttons cannot all run the commands the spec names.
   - Local open maps to `POST /api/launch`, not `afx start`.
   - Remote open cannot map to `afx start --remote`. That command is gone. Cloud connect is a different product.
   - Create maps to `POST /api/create`, which already runs `codev init --yes`. The landing page never calls it.
   - Adopt is implicit inside `launchInstance`. There is no adopt-only route.
   - Update has no route. `codev update` exists only as a CLI.
3. Real-time command output cannot come from `/api/launch` or `/api/create`. Both use `execAsync` and return a toast. `POST /api/terminals` can stream a one-shot command over the existing terminal WebSocket.
4. Close-after-complete cannot be driven by a WebSocket exit frame. `ControlMessage` has no `exit` type. `tower-websocket.ts` never sends one. `GET /api/terminals/:id` returns `status` and `exitCode` for 30 seconds after exit. The UI would have to poll, or production would add a control frame.
5. A native file picker cannot give Tower an absolute path it can exec in. Browser `File` objects expose `name` and `webkitRelativePath`, not a filesystem path. `/api/browse` text input is the only working picker.
6. Modal vs panel is UX, not a capability gap. Two concurrent one-shot PTYs are possible today. Setup commands do not need a multiplexer on the landing page.

**Success.** Scored against this list, not against whatever the run produces:

- A command-mapping artifact exists. Each of the five buttons is marked maps / missing / wrong-command, with the current CLI or route named.
- `afx start` and `afx start --remote` are probed and recorded as missing, or the hypothesis is revised if they still exist.
- Live Tower is probed without launching or stopping a workspace. `POST /api/create` with an empty body returns 400. `POST /api/update` is 404.
- One ephemeral PTY (`printf` then `exit 7`) streams bytes over the terminal WebSocket. After exit, `GET /api/terminals/:id` reports `status=exited` and `exitCode=7`. Control frames seen during that run include no `exit` type.
- A layout fixture of three running workspaces, two terminals each, scores current card rows vs flattened rows. Flattened default is exactly one row per workspace.
- Experiment code lives under `codev/experiments/63-tower-dashboard-improvements/`. Production files are not edited.
- Each of spec 0063's six acceptance criteria is scored pass / fail / partial against current production plus this spike.

**Failure of the hypothesis.**

- `afx start --remote` still exists and starts a remote farm.
- `/api/launch` or `/api/create` already stream command output.
- The terminal WebSocket already sends an exit control frame.
- A browser file picker can return a path Tower can exec in.
- One-row layout cannot keep Open / Stop without a new API.

**Not a failure.** Tower is down, so the live PTY probe cannot run. The notes must say so and score that gate "not run".

## Approach

A v2-owned spike under the experiment directory. No edit to `tower.html` or `tower-routes.ts`.

The spike has four measurements and one static prototype.

**Command map.** Spawn the spec's CLI names and the current replacements. Record exit status and the first line of help or error.

**Tower probe.** Read `~/.agent-farm/local-key`. Hit the live daemon on :4100. Create one ephemeral PTY in `/tmp`, attach the WebSocket, delete the session. Do not call `/api/launch` or `/api/stop`.

**Layout score.** Render a fixture with the current card shape and a flattened row shape. Count visual rows.

**Picker score.** Record what the File API gives a web page vs what `launchInstance` requires (`path.isAbsolute`).

**Prototype.** `prototype/index.html` is a static landing: five buttons, one-row list, path prompt with typed suggestions, modal and sliding panel for the same fake command stream, Close locked until the command ends, a red error state. It does not talk to Tower. The live probe answers the stream question. The HTML answers the three open questions in the spec.

**Why not edit tower.html.** This is an experiment. The spec is from v1.6.0 and the landing has already grown launch, auto-adopt, and cloud connect. A production change needs a SPIR that names the current commands. This spike says which of those commands exist.

**Why not ttyd.** The changelog replaced it with xterm.js plus WebSocket. A new ttyd dependency would fight that migration.

## Environment and reproduction

Node 20. No extra packages.

```
node codev/experiments/63-tower-dashboard-improvements/src/run-all.mjs
```

The live Tower probe needs a running daemon on port 4100 and `~/.agent-farm/local-key`. It creates one short-lived PTY and deletes it. Node 20.19 has no global `WebSocket`. The probe loads `ws` from main's `packages/codev/node_modules/ws` when the global is missing.

Open the prototype with any browser:

```
open codev/experiments/63-tower-dashboard-improvements/prototype/index.html
```

Untouched check after the run:

```
git diff --stat -- packages/codev/templates/tower.html packages/codev/src/agent-farm/servers/tower-routes.ts
```

## Code

| File | What it is |
|---|---|
| `src/run-all.mjs` | Runs the four measurements and writes artifacts. |
| `src/map-commands.mjs` | Probes the spec's CLI names and the current replacements. |
| `src/probe-tower.mjs` | Live Tower: create route, update 404, one-shot PTY stream, exit poll. |
| `src/score-layout.mjs` | Fixture row counts for current card vs flattened row. |
| `src/score-picker.mjs` | File API fields vs the absolute path `launchInstance` requires. |
| `prototype/index.html` | Static one-row landing with five buttons, modal, and panel. |
| `fixtures/workspaces.json` | Three running workspaces used by the layout score and the prototype. |
| `artifacts/run.md` | Scored-run table. |
| `artifacts/command-map.json` | CLI probes and button verdicts. |
| `artifacts/tower-probe.json` | Live create/update/PTY capture. |
| `artifacts/layout-score.json` | Card vs flattened row counts. |
| `artifacts/picker-score.json` | File API vs absolute path. |

## Results

The hypothesis holds. Spec 0063 cannot ship as written. The landing can still get one row, a Create button, and a closeable command panel. It cannot get SSH remote start, and it should not grow a ttyd dependency to do it.

Scored run: `artifacts/run.md`, timestamp `2026-08-23T21:15:15.989Z`. First run had two probe bugs. Those are below. This table is the second run only.

| Metric | Value | Source |
|---|---|---|
| `afx start` | `unknown command 'start'`, exit 1 | `artifacts/command-map.json` |
| `afx start --remote` | `unknown command 'start'`, exit 1 | same |
| `afx workspace start --help` | `Usage: afx workspace start`, exit 0 | same |
| `POST /api/create {}` | 400 `Missing parent or name` | `artifacts/tower-probe.json` |
| `POST /api/update` | 404 `Not found` | same |
| PTY data | `hello-0063\r\ndone\r\n` | same, session `94a7703d-…` |
| PTY `exitCode` via GET | 7 | same |
| WS control types | `seq` only | same |
| WS `exit` frame | none | same |
| Current card rows / workspace | 7 | `artifacts/layout-score.json` |
| Flattened rows / workspace | 1 | same |
| Production `tower.html` / `tower-routes.ts` diff | empty | `git diff --stat` |

**Hypothesis 1, confirmed.** Three running workspaces with two terminals each cost 21 visual rows today, 3 if flattened. Recents are already one row. No API change.

**Hypothesis 2, confirmed.** Local open is `/api/launch`. Create is `/api/create`, unused by the page. Adopt is a side effect of launch. Update has no route. Remote SSH start is gone. `afx tower connect` is Cloud, not `user@host:/path`.

**Hypothesis 3, confirmed for the routes we were willing to hit.** `/api/create` answers JSON. `/api/update` does not exist. I did not call `/api/launch`. That handler is `execAsync` then a toast. A one-shot `POST /api/terminals` did stream. That is the output path.

**Hypothesis 4, confirmed.** After `exit 7`, GET reported `status=exited` and `exitCode=7`. The WebSocket sent `seq`. It never sent `exit`. `ControlMessage` has no such type. Close-after-complete is a poll, or a new control frame.

**Hypothesis 5, held on spec evidence, not a live browser.** Browser `File` has no absolute path. `launchInstance` rejects anything that is not `path.isAbsolute`. `/api/browse` is already on the page. I did not open a file picker in Chrome this run.

**Hypothesis 6, not user-tested.** The static prototype has both hosts. Two concurrent one-shot PTYs were not run. I would still ship one panel, one command at a time. The workspace SPA already multiplexes real terminals.

### Spec 0063 acceptance criteria

Scored against production today, not against the prototype.

| AC | Verdict |
|---|---|
| 1. One row per registered project | Fail. Running workspaces are multi-row cards. |
| 2. All five action buttons present and functional | Fail. None of the five named buttons exist. |
| 3. Clicking a button opens a terminal with command output | Fail. Launch is a toast. |
| 4. Commands execute correctly | Partial. Launch and auto-adopt work. Init API exists and is unused. Update and SSH remote do not. |
| 5. Terminal can be closed after the command completes | Fail. No command terminal. The spike can detect completion only by polling GET. |
| 6. Error states are clearly communicated | Partial. Toasts exist. There is no command stream to show a failed `codev update`. |

### Open questions

1. **Modal or sliding panel?** Panel. `codev init` has a 60s timeout in `/api/create`. A modal that blocks the list for that long is rude. The prototype has both. Pick panel in the SPIR.
2. **Multiple concurrent terminals?** No, not on the landing page. These are setup commands. One panel is enough.
3. **Native file picker or text input?** Text input plus `/api/browse`. A browser picker cannot feed `launchInstance`.

## What worked / what didn't

The live PTY probe is the useful part. Create a throwaway session, attach, read bytes, poll exit, DELETE. Session `94a7703d-a782-44bb-a4e1-e4f9447c733a` is gone (204).

`/api/create` is already the Create button. Someone built the route and never put it on the page. That is cheaper than a new endpoint.

The first detector was wrong. `afx start --help` prints the root `Usage: afx [options] [command]` and exits 0. That looks like a real command if you only check the status. `afx start` with no flag is the honest probe: `unknown command 'start'`.

Node 20.19 has no global `WebSocket`. The first PTY run created session `5289b513-…`, got `exitCode` 7 via GET, and recorded `wsError: WebSocket is not defined`. Data stream was then unknown. The second run loaded `ws` from main's `packages/codev/node_modules`. Same pattern as experiment 38. Do not treat the first run as a stream failure.

I did not click through the HTML in a browser. The prototype is a visual argument, not a measured one.

I did not call `/api/launch` or `/api/stop`. Those start and kill real workspaces on this machine.

## Next steps

Do not implement spec 0063 as written.

The Tower landing is the surface v2 replaces. Building the five buttons onto `tower.html` invests in a UI that is being retired. The two parts that are not additive, SSH remote and ttyd, are decisions v2 has already made differently: multi-machine as paired environments, and terminals over the existing PTY path. Shipping 0063 as written would also re-solve remote access in a way that already has a different answer.

One-row layout and a Create button that calls `POST /api/create` are still cheap if someone wants them on the current landing before v2 ships. They are paint on a wall that is coming down.

If a short-lived patch is wanted anyway:

- Flatten running cards to the recent-item row. Overview and per-terminal links already live in the workspace SPA.
- Rename Launch to Open dashboard (local). It already is that button.
- Wire Create to `POST /api/create`.
- Leave Adopt as launch-on-a-bare-directory.
- Add `POST /api/update` only if update has to live on this page. One-shot PTY plus GET poll is enough. An `exit` control frame is a types change.
- Do not restore `afx start --remote`. Do not add ttyd.

Spec 0063 can stay Conceived. Close it or fold the additive scraps into v2. Use `Refs #65` for the collision that produced these notes.

Open the prototype:

```
open codev/experiments/63-tower-dashboard-improvements/prototype/index.html
```

