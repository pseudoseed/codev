# Codev v2 UI — Functional Requirements & Options

**Status:** Decided — Option 2, multi-machine in v1, built as an additive fork-owned app.
Not a spec. No implementation authorized; spikes in the appendix come first.
**Date:** 2026-08-21 (rev. 5, design language approved)
**Author:** Architect (main)
**Reviewed by:** Claude Opus 5, Grok 4.6 (Codex unavailable, Gemini unauthenticated)
**Decided by:** the human, 2026-08-21 — **multi-machine ships in v1**, and **this is a
bespoke UI for one person on a fork that must keep merging upstream.**

> ⚠️ **The reviews predate the fork constraint.** Both reviewers recommended Option 1
> (refactor `apps/web` in place) over Option 2. Neither knew this repository is a fork of
> an active upstream. Part 0 explains why that reverses their conclusion.

FRD = Functional Requirements Document: what the system must *do*, in
user-observable terms, before anyone chooses how to build it. Part 3 gives the
architectural options; Part 4 gives the requirements those options must satisfy.
Part 7 records what the reviews changed.

---

## Part 0 — The fork constraint (governs everything below)

This repository is `pseudoseed/codev`, a fork of `cluesmith/codev`, which is active
(upstream PRs in the 1500s). Upstream changes must keep merging cleanly. **The v2 UI is
bespoke — for one person, on this fork only. Upstream will never adopt it.**

That single fact reverses the ordinary cost model.

| | Ordinary repo | Fork tracking an active upstream |
|---|---|---|
| Edit an existing file | Cheap | **A merge conflict paid at every sync, forever** |
| Add a file upstream lacks | Costs dual maintenance | **Nearly free — upstream has no such path** |
| Two front-ends | A trap to escape | **The goal.** The old UI is what stays mergeable |

### The fork already behaves this way

Measured at rev. 4, against merge-base `ff855d3e7`:

- **130 commits ahead, 0 behind.**
- **11,642 insertions against 300 deletions** across 137 files. The fork adds; it barely
  edits.
- **Untouched entirely:** `packages/codev/templates/tower.html`, `packages/sdk`,
  `packages/codev/src/terminal` (including `pty-session.ts`), `apps/vscode`.
- **Lightly touched:** `apps/web` (6 files, 291 insertions, 10 deletions — including 8
  lines in `Terminal.tsx`), `tower-routes.ts` (3 lines).

This discipline is why merges still work. **v2 must not break it.**

### What this does to the options

**Option 1 is now the worst option, not the safest.** It was "merge `tower.html` into
`apps/web` and restructure the router" — heavy modification of two hot upstream files,
one of which the fork has never touched. Both reviewers preferred it; neither knew about
the fork. Their reasoning is void here.

**Option 2 is right, but not for the reason rev. 3 gave.** The justification is no longer
"multi-machine needs a new auth model" (though it does). It is that **a new pnpm workspace
is the only change shape that survives upstream merges.**

### The additive seam

| Layer | Approach | Conflict surface |
|---|---|---|
| Client | New `apps/v2/` pnpm workspace, fork-owned | **Zero** — upstream has no such path |
| Server | New fork-owned `v2-*.ts` modules under `agent-farm/servers/` | **Zero** for the modules |
| Mount | One `if (url.pathname.startsWith('/v2/'))` block in `tower-routes.ts`'s existing path chain | **One small, stable block** |
| Client runtime | Reuse `packages/sdk` **unmodified** — it is untouched and already environment-agnostic | **Zero** |
| PTY | v2-owned attach wrapper; **do not change `PtySession`'s contract** | **Zero** |

The rule: **v2 owns new files and mounts through one insertion point.** Any requirement
below that cannot be met additively is a requirement to renegotiate, not an edit to make.

### Where the real risk moved

Not dual maintenance — that is now intended. The risk is the two items rev. 3 put on the
critical path, both of which want to edit hot upstream files:

- **Option 0 (server events)** wants `tower-server.ts` and `tower-routes.ts`, where the
  fork already carries 419 insertions and upstream is active. **Must be additive:** a new
  v2-owned event route, not modifications to existing handlers.
- **FR-38 (resize)** wants `pty-session.ts:567`, a file the fork has **never** touched.
  Rev. 3 called this spike 1. **Solve it in the v2 layer instead** — negotiate per-viewer
  dimensions in the v2 attach wrapper rather than changing what `resize()` means for every
  existing client.

### The open question this creates

`Terminal.tsx` is an upstream file the fork has already edited by 8 lines. §1.4 says import
it rather than re-earn its scar map, and rev. 3 recommended refactoring it to accept an
injected channel — **which is now a significant intrusion into an upstream file.** Three
ways out, and this is a real decision:

1. **Vendor a copy** into `apps/v2/`. Zero conflict; accepts drift from upstream fixes.
2. **Import unmodified** and make v2's transport fit `Terminal.tsx`'s existing WebSocket
   rather than the reverse. Zero conflict; constrains FR-32.
3. **Contribute the channel-injection refactor upstream first**, then import. No fork
   divergence at all, but gated on someone else's review and timeline.

*Recommendation: (2) for v1.* It keeps the scar map, adds no divergence, and its cost —
v2's terminal transport looks like today's — is the cheapest of the three to reverse.

---

## Part 1 — Why the current UI is the way it is

The complaint "poor and inefficient" has three specific structural causes, all
verified in the tree.

### 1.1 It is two disconnected front-ends, not one app

| Surface | What it is | Location |
|---|---|---|
| Tower shell | 1,894-line hand-rolled HTML with inline CSS + one inline `<script>`. Lists workspaces. | `packages/codev/templates/tower.html` |
| Workspace app | React 19 + xterm SPA, ~5,100 LOC, scoped to **one** workspace | `apps/web/src` |

The SPA mounts per-workspace at `/workspace/<encoded>/`. Switching workspaces is
a **full page navigation out of a vanilla HTML page into a fresh React app**.
Every xterm instance, WebSocket, and SSE stream is destroyed and rebuilt on each
hop. No amount of styling fixes this; it is the shape of the thing.

There are in fact **four** Tower clients, not two: `tower.html`, `apps/web`,
`apps/vscode`, `apps/streamdeck`. Any transport change is a four-client change.
This materially raises the cost of a new RPC contract and lowers the cost of
extending the existing one.

### 1.2 The data layer polls because the server has nothing to push

**This section was wrong in rev. 1 and the correction changes the options.**

Rev. 1 claimed the app "maintains a persistent event stream whose whole purpose is
to say 'something changed,' and then polls anyway" — implying redundancy that the
client could simply drop. That is not what the code does.

`broadcastNotification` (`tower-server.ts:259`) is the **only** SSE emitter. Its
shape is `{type, title, body, workspace}` — a notification bus, not a state
stream. The complete set of emitted types is `architects-updated`,
`builder-spawned`, `overview-changed`, `codev-config-updated`,
`mailbox-escalation`. And `tower-routes.ts:643` says why it exists:

> `// Spec 823: emit architects-updated so VSCode's WorkspaceProvider refreshes when remove happens via CLI (the dashboard polls and doesn't need an explicit event; VSCode subscribes to this notification).`

**The SSE bus was built for the VS Code extension.** The dashboard's polling is not
redundancy — it is the dashboard's only state-sync mechanism. `useSSE.ts` confirms
it from the client side: it discards every payload
(`if (/^data:/m.test(frame)) notify()`) and uses the stream purely as a doorbell.

The polls are real and excessive: `POLL_INTERVAL_MS = 1000` in
`apps/web/src/lib/constants.ts:3` drives a full `/api/state` refetch every second
(`hooks/useBuilderStatus.ts:23`); `useOverview` adds 2500ms; `FileTree.tsx:153`
adds a third at 5s.

The consequence that matters: **there is no server-side event for builder status
transitions, gate arrival, porch phase change, or terminal lifecycle.**
`overview-changed` is a cache-invalidation ping meaning "refetch," not a delta.

So the work splits in two, and only the first half is cheap:

- **Cheap (about a day):** stop refetching on a timer, refetch on the doorbell
  instead. Delete the three intervals. This is available today, in the current
  app, under the current tests.
- **Not cheap, and uncosted in rev. 1:** real per-node events and scoped
  subscriptions, which FR-4 and FR-31 require. **This is server work, it is on the
  critical path, and no choice of client architecture avoids it.**

`useSSE.ts` also documents the ceiling this design runs into: browsers cap
HTTP/1.1 at 6 connections per origin, so the SSE stream had to become a
hand-rolled singleton to stop hooks from exhausting the connection pool. Note
that HTTP/2, which TLS gets you anyway, removes this limit without any
multiplexing work.

### 1.3 The nesting exists at the wrong level

`ArchitectTabStrip` + `SplitPane` already nest architects and builders — but
*inside a single workspace*. There is no container that holds workspaces, and no
concept of a machine at all. `tower-instances.ts:279` guards a `remote:` path
prefix that nothing in the codebase ever constructs: a stub, not a feature.

### 1.4 What is genuinely worth keeping

`apps/web/src/components/Terminal.tsx` is 825 lines backed by ~14 dedicated
regression tests — IME dedup, reconnect, replay-scroll, fit-scroll, clipboard,
input filtering. That file is a scar map. Its *shell* is the problem; its
*terminal handling* is hard-won and should not be re-earned from zero.

**Caveat that undercuts the "just import it" plan:** `Terminal.tsx` constructs its
own WebSocket, and `VirtualKeyboard.tsx` reaches into `wsRef` and hand-encodes
frames with a duplicated `const FRAME_DATA = 0x01` (its own comment: *"must match
Terminal.tsx"*). **The scar map is partly the transport.** Change the channel and
you rewrite the file you promised not to touch. See FR-27 and the spike list.

### 1.5 What already exists (and rev. 1 missed)

Four things rev. 1 treated as missing or unknown are already in the tree:

| Claimed | Actually |
|---|---|
| "No path to a phone/tablet client beyond CSS breakpoints" (Option 1) | `apps/web/src/components/MobileLayout.tsx` and `VirtualKeyboard.tsx` both exist, with a 768px breakpoint. The path is built and unused. |
| "Shared client-runtime package" as an Option 2 advantage | `packages/sdk` already is one. Its own package.json: *"the single implementation of how anything talks to Tower. Environment-agnostic (browser, Node, React Native); auth and transport arrive as injected adapters."* `apps/web` imports it today. |
| "Whether Tower's PTY layer can serve multiple concurrent clients" (appendix, not investigated) | It does. `PtySession.clients` is a `Set` (`pty-session.ts:153`), broadcast at 462-467, attach at 615, detach at 698, with tests. |
| Multi-device is an open question | Attach works. **Resize does not.** `resize(cols, rows)` (`pty-session.ts:567`) is a single global call: last-writer-wins. A laptop at 80x24 and an iPad at 40x12 will fight, and Claude Code redraws on every flip. This is a confirmed bug, not a risk. |

---

## Part 2 — Reference scan

### 2.1 T3 Code (pingdotgg/t3code, MIT)

The closest existing thing to the stated vision, and open source. Worth studying
in detail because it has already solved the multi-device problem.

**What it gets right, and what we should take:**

- **Environments model.** The client holds a saved list of backends — local,
  LAN, Tailscale, SSH-launched, tunnel. Each is a separate server that owns its
  own projects, files, git state, terminals, and provider sessions. Adding a
  project asks *which environment it lives on*. This is exactly "two computers,
  one interface," and it is a client-side list, not a server mesh.
- **One authenticated RPC WebSocket per environment** (`/ws`), with a typed
  contract and **per-method authorization scopes** — "holding a valid socket is
  not authorization to call everything on it." Streaming subscriptions replaced
  their broadcast push bus: a client subscribes only to what it needs.
- **Pairing tokens, not long-lived secrets.** Server mints a one-time token
  (printed as a QR code); the device exchanges it for a session. `t3 auth`
  revokes.
- **Tailscale as the transport answer**, not raw SSH. Their docs recommend a
  tailnet for a stable address, network-layer transport security, and less
  exposure. Tailscale Serve gives each machine a real HTTPS MagicDNS name. They
  document the mixed-content trap directly: `https://app.t3.codes` cannot open
  `ws://192.168.x.y:3773`.

**What does not transfer:** T3 Code is thread/chat-oriented — a thread per task,
event-sourced turns, provider CLIs driven over JSON-RPC. Codev is
terminal-oriented: real PTYs running Claude Code under porch protocol
orchestration, with architects, builders, gates and worktrees. Their orchestration
model is not ours and should not be imported.

**Their native mobile apps also do not transfer.** They ship iOS/Android because
they are building a consumer product with App Store distribution. We have one
user, one LAN, and no distribution requirement. Copying a distribution decision
from a product that has distribution is a cargo cult. Take the architecture, not
the shipping surface.

### 2.2 BridgeSpace (BridgeMind)

Less documented (site is bot-walled; details are second-hand). Relevant shape:
multi-pane layouts up to 16 terminals, Warp-style command blocks, integrated
kanban that dispatches agents, automatic agent launch, themes. Confirms the
"many live terminals tiled at once" affordance is a real product direction, and
that a board view over agent work is a proven companion to the terminal grid.

### 2.3 Layout library

**dockview** (MIT, ~3.3k stars, 540k monthly downloads, **zero dependencies**,
React 16.8–19 bindings) is the mature choice for IDE-style tiling: split-views,
grids, dockable groups, drag-and-drop, floating groups, popout windows, and
**layout serialization/deserialization** — which is what makes saved tile
arrangements possible.

Critically, it supports an `always` rendering mode that keeps a panel's element
in the DOM and merely `display:none`s it when hidden. **This is the property that
lets a terminal survive being tabbed away from** — the exact failure the current
UI has.

⚠️ **Verify before committing:** dockview's site now claims "touch and mobile
ready," but as of the Jan 2025 HN thread the maintainer said touch support was
partial and planned, and users reported the demo failing on iPad Safari (since
fixed). Treat iPad touch support as **unproven and requiring a spike on a real
device** before it becomes load-bearing.

⚠️ **Second, sharper risk:** `always` render mode plus tiling plus WebGL is bad on
iPad. Safari caps live WebGL contexts at a small number, and keeping every hidden
pane alive means N terminals each holding one. FR-21 does not protect you — iPad
is 1024px and therefore tiles. See the FR-8 amendment.

---

## Part 3 — The options

**Rev. 1 framed this as a three-way choice between client architectures. That was
the document's biggest error:** the data-layer problem (§1.2) is at least half
server-side, and its cost is identical under all three. That work is now Option 0,
and it is not optional.

### Option 0 — Server events (prerequisite, not a choice)

Real per-node change events plus scoped subscriptions, replacing the
notification-bus-plus-poll arrangement. Required by FR-4 and FR-31. Costs the same
whichever client wins, so it should be priced and scheduled *before* the client
question is settled — and it can be proven incrementally by deleting the polls in
the current `apps/web`.

Ships a user-visible win in days. Also the only credible way to time-box anything
that follows, because it turns the client project into a **UI** project rather
than a UI + transport + data project.

### Option 1 — Shell merge over existing `apps/web`

Merge `tower.html` into the React app, root the router at `/`, keep terminals
mounted across workspace switches the same way `activatedTerminals` already keeps
them alive across tab switches within a workspace (Bugfix #205).

- ✅ Cheapest; keeps ~30 test files green
- ✅ Fixes the workspace-hop teardown (§1.1) and, with Option 0, the data layer
- ✅ **Mobile components already exist** (`MobileLayout.tsx`, `VirtualKeyboard.tsx`)
- ✅ `packages/sdk` is available to it identically
- ❌ Keeps the component structure the user dislikes
- ❌ Does **not** fix auth: `window.__CODEV_TOWER_KEY__` is injected same-origin
  and persisted to localStorage. A phone talking to two machines cannot use a
  page-injected loopback key.
- ❌ No environment list, no pairing, no session revoke

~~Rev. 1 said Option 1 "keeps the poll-plus-SSE data layer" and has "no path to a
phone/tablet client beyond CSS breakpoints." Both were false.~~

### Option 2 — Codev v2 client

A new app alongside the existing one. New shell, new transport, new state layer.
Imports `Terminal.tsx` as the terminal engine. Keeps the Tower server and its
existing REST surface during migration.

- ✅ Fixes §1.1 and §1.3 cleanly
- ✅ Environments model gives multi-machine as a first-class concept
- ~~✅ Shared client-runtime package makes iPad/phone a real client~~ **STRUCK:
  `packages/sdk` already does this and Option 1 gets it too.**
- ❌ Largest scope
- ❌ **Two front-ends coexist** — and rev. 1's "accepted cost, time-boxed" named no
  date, no parity definition, and no kill criterion. That is not a time-box.
- ❌ The FR-16/34/35 auth work (pairing, scopes, revocation) is **Tower server
  work**, not "keep the Tower server." Rev. 1 budgeted it as neither.

**The honest case for Option 2** is not that Option 1 *cannot* work. It is that the
whole SPA is 5,120 LOC — smaller than `tower-routes.ts` alone — so an aggressive
refactor and a new app cost about the same, and the new app avoids carrying test
files that encode the old component shape. That is a modest, legitimate argument.

**Option 2 is only right if multi-machine, pairing and revocable sessions ship in
v1** — that genuinely is a new auth and connection model the current key-in-the-page
cannot grow into. If decision 4 lands on "one machine in v1," Option 2 is a rewrite
in search of a problem.

**~~Kill criteria~~ — withdrawn in rev. 4.**

Rev. 3 carried five: freeze `apps/web`, write a parity checklist, set a calendar date,
one URL, delete v1 surfaces as v2 reaches parity. **All five are withdrawn.** They were
Grok's answer to the two-front-ends-forever trap, and that trap does not apply here:

- **"Freeze `apps/web`"** is actively harmful. It is the surface that stays mergeable with
  upstream; freezing it means refusing upstream improvements.
- **"A calendar date, then delete v2"** gates nothing. There is no deadline, no user
  waiting, and the old UI remains usable throughout and after.
- **"One URL, delete v1 counterparts"** is backwards. v2 mounts at its own prefix
  precisely so v1 keeps working untouched.

**What replaces them — the constraints that actually bind:**

1. **v2 adds files; it does not edit upstream ones.** The single permitted edit is the
   mount block in `tower-routes.ts`.
2. **The old UI keeps working, permanently, by design.** Not "until parity." It is the
   fallback and the upstream-merge surface.
3. **Any requirement that cannot be met additively gets renegotiated,** not forced through
   as an upstream-file edit.
4. **Upstream merges keep passing.** That is the health check that replaces a parity date.

### Option 3 — Fork T3 Code as the shell

Take their client, graft codev concepts (architects, builders, porch gates, worktrees) on.

- ✅ Their remote/pairing/environment problem is already solved and battle-tested
- ❌ Their data model is threads-and-turns; codev's is terminals-under-protocol. This
  is a deep impedance mismatch, not a skinning exercise
- ❌ Forking a fast-moving upstream that explicitly is "not accepting big contributions"
- ❌ Effect-heavy stack is a large new dependency and idiom for this repo

### Decision

**Option 0 first, unconditionally. Then Option 2.**

The client question reduced to one input — does multi-machine ship in v1? — and the
answer is **yes**. That is the condition both reviewers named as the one that makes
Option 2 legitimate rather than a rewrite in search of a problem: pairing, scopes and
revocable sessions are a genuinely new auth and connection model, and the current
page-injected loopback key cannot grow into it.

Two consequences follow immediately, and neither is optional:

1. **v2 is built additively** (Part 0). A new `apps/v2/` workspace plus fork-owned server
   modules, mounted through one insertion point. The old UI is never frozen and never
   deleted.
2. **The critical path is server work, and it must be additive.** Option 0 (per-node
   events, scoped subscriptions) plus FR-16, FR-34, FR-35 (pairing, per-method scopes,
   session revocation) plus FR-38 (resize policy) are all Tower changes. Rev. 1 budgeted
   them as none of the three options' cost — they are most of the project — and rev. 4
   adds that each must land as **new v2-owned modules**, not edits to existing handlers.

Steal T3 Code's *patterns* — environments, scoped control socket, pairing tokens,
Tailscale — without their orchestration model or their code. Option 3 was rejected by
both reviewers and is closed.

---

## Part 4 — Functional requirements

Numbered so they can be argued with individually. **MUST** = v1. **SHOULD** = v1 if
cheap. **LATER** = explicitly deferred. Requirements changed in rev. 2 are marked ⟳.

### Structure and navigation

- **FR-1 ⟳ (MUST)** One window shows the whole hierarchy — **machine → workspace →
  architect → builder** — all four levels navigable without a page load. **Containment,
  not an outline.** *Rev. 5 strikes the word "tree": the approved design shows hierarchy
  as nested space (machine lot → workspace plot → architect header → builder row), and
  an indented list with disclosure triangles is the thing being replaced. See
  `v2-mockups/design-language.md`.*
- **FR-2 (MUST)** Selecting any node opens its view in the work area. Navigating
  between nodes MUST NOT tear down or reconnect any already-open terminal.
- **FR-3 (MUST)** A builder appears nested under the architect that spawned it, and
  under the workspace it belongs to.
- **FR-4 ⟳ (MUST)** Every node shows live status — running / idle / needs-attention /
  held mail / gate-waiting — updated by push, never by timer refetch. **This has no
  server implementation today (see Option 0); cost it separately.**
- **FR-41 ⟳ (MUST)** Every builder carries an **activity trace**: a sparkline of output
  volume over time, so working and stalled are distinguishable at a glance without
  reading. *New in rev. 5, from the approved design. No agent tool currently shows this.*
- **FR-42 ⟳ (MUST)** A builder producing no output for a threshold period is shown as
  **stalled** (`NO OUTPUT 6 MIN`), distinct from idle and from gate-waiting. Stalled is
  derived server-side, not inferred by each client.
- **FR-5 (SHOULD)** A global command palette (⌘K) jumps to any node by name.
- **FR-6 (LATER)** A board view over builders/issues, in the BridgeSpace vein.

### Tiling and layout

- **FR-7 ⟳ (MUST desktop / SHOULD tablet)** The work area tiles: split horizontally
  and vertically, drag panes between groups, resize. **Tablet tiling stays SHOULD
  until a real iPad has dragged a split in dockview** — rev. 1 flagged touch as
  unproven and then made it MUST anyway.
- **FR-8 ⟳ (MUST)** A pane hidden by tab-switching keeps its process, scrollback and
  connection alive. **Its renderer may be released and restored on show** — required
  because Safari caps live WebGL contexts and `always` mode would hold one per pane.
- **FR-9 (MUST)** Layouts persist across reload, per machine+workspace.
- **FR-10 (SHOULD)** Named saved layouts the user can switch between.
- **FR-11 (LATER)** Pop-out panes into separate browser windows.

### Multi-machine

- **FR-12 (MUST)** The client holds a list of **environments** (machines). Each has a
  name, a reachable address, and its own credential.
- **FR-13 (MUST)** Two machines' workspaces appear in the same tree simultaneously,
  each labelled with its machine.
- **FR-14 (MUST)** Tower control actions — start/stop workspace, spawn, send, cleanup —
  work against any connected environment from either device.
- **FR-15 (MUST)** One environment being down or unreachable degrades that subtree only.
  It MUST NOT block, error, or slow the rest of the UI.
- **FR-16 (MUST)** Adding an environment is a pairing flow: the server mints a one-time
  token, the client exchanges it for a session. No hand-copied long-lived secrets.
  **This is Tower server work.**
- **FR-17 (SHOULD)** Pairing offers a QR code so a phone can join by scanning.
- **FR-18 (LATER)** Discovery of machines on the LAN without typing an address.

### Gates (new in rev. 5)

The approved design makes gates the emotional centre of the product, and rev. 4 had no
requirements for them beyond a node status.

- **FR-43 (MUST)** Gates appear in a **persistent queue**, not as a badge on a list item.
  Each entry carries the builder's actual question, how long it has been held, and where
  it lives. The longest wait is marked.
- **FR-44 (MUST)** A gate view shows: the question verbatim, the terminal output that led
  to it, the worktree, branch and commit count, and how long work has been stopped.
- **FR-45 (MUST)** **The consequences of each ruling are shown before the human rules** —
  what the builder will do next under each choice.
- **FR-46 (MUST)** Gate actions are **named for their consequence** (`KEEP FOR AUDIT` /
  `APPROVE DROP`), never generic `Approve` / `Reject`. *FR-45 and FR-46 together serve the
  standing rule that a gate is never approved without an explicit human decision: a
  human who cannot see what a button does has not made one.*
- **FR-47 (SHOULD)** A gate accepts an optional note back to the builder.
- **FR-48 (SHOULD)** Ruling on a gate advances to the next queued gate automatically.

### Multi-client (new in rev. 2)

- **FR-38 ⟳ (MUST)** Two clients attached to the same terminal MUST NOT fight over
  dimensions. `resize()` is last-writer-wins today. Pick a policy: follow the
  focused client, ignore resize from hidden panes, or per-viewer local cols with
  server-side reflow. **Server change; spike first.**
- **FR-39 ⟳ (MUST)** Mutating RPCs carry a client-generated idempotency key and the
  server deduplicates. iOS drops the socket on every backgrounding; a retried
  "approve gate" is a **safety** issue under the rule that a gate is never approved
  without an explicit human decision.

### Mobile and tablet

Governed by the universal mobile rules (iOS HIG / Material 3 / WCAG 2.2 AA).

**iPad is the primary away-from-desk target, and the phone is secondary** (human,
rev. 5). The iPad tiles two panes and usually has a hardware keyboard. The phone is a
**consolidated** surface: one pane at a time, hierarchy chosen through a breadcrumb
picker rather than a tree, and a bottom bar for destinations. A phone is for ruling on a
gate and glancing at output, not for driving work.

- **FR-19 ⟳ (MUST, split)** Rev. 1 said "full function on iPad Safari and on a phone,
  over LAN, with no native app install" — which forbids the notification path,
  because **Web Push does not work in a Safari tab**. Split it:
  - **(a) MUST** Usable in Safari over HTTPS on iPad and phone.
  - **(b) MUST** Add to Home Screen is required for notifications and standalone
    chrome. "No native app" still holds; "no install step at all" does not.
  - **(c) MUST** No App Store, no native binary.
- **FR-20 (MUST)** Breakpoints tested at 375 / 414 / 768 / 1024 px.
- **FR-21 (MUST)** Below 768px the UI **does not tile**. One pane at a time, with the
  tree reachable as a drawer and panes switched by a bottom tab bar or segmented
  control. Tiling on a phone is an anti-pattern; do not ship it.
- **FR-22 (MUST)** Touch targets ≥ 44pt with ≥ 8pt separation. This applies to terminal
  chrome, tab close buttons and tree disclosure triangles — the usual offenders.
- **FR-23 (MUST)** Respect `safe-area-inset-*`. Any sticky bottom bar adds
  `env(safe-area-inset-bottom)` or the home indicator eats it.
- **FR-24 ⟳ (MUST)** A usable terminal input path on touch, with modifier keys
  (Ctrl/Esc/Tab/arrows) reachable without the system keyboard. **`VirtualKeyboard.tsx`
  already ships Esc/Tab/Ctrl/Cmd and lacks only arrows.** Spike the existing one on a
  device before specifying a replacement. It must also stop writing the socket
  directly and route through the terminal channel.
- **FR-25 (MUST)** Any text input ≥ 16pt to prevent iOS Safari auto-zoom on focus.
- **FR-26 (SHOULD)** Primary actions sit in the lower two-thirds of the viewport.

### Terminals

- **FR-27 ⟳ (MUST)** Terminal fidelity at least matches today **on desktop**, and
  **fixes** today's iPad defects rather than matching them. Verified by porting the
  existing test suite, not by re-deriving the behavior. Note that `Terminal.tsx` is
  coupled to its own WebSocket and framing (§1.4): **refactor it to accept an
  injected channel first, in the current app, under the current tests.** Otherwise
  this requirement cannot be met by any option that changes the transport.
- **FR-28 (MUST)** A terminal survives network interruption and reconnects with
  scrollback intact.
- **FR-29 ⟳ (MUST, was SHOULD)** Terminal output continues to buffer server-side while
  its pane is hidden or the client is disconnected. **Promoted because iOS suspends
  the socket on every screen lock; this is what stands between a locked iPad and a
  lost session.**
- **FR-40 ⟳ (SHOULD)** Default to the Canvas renderer on iOS rather than
  WebGL-then-fallback. `Terminal.tsx:270-289` already handles context loss, but on
  iOS that path is routine, not exceptional, and each hit costs a renderer swap.

### Efficiency

- **FR-30 ⟳ (MUST)** No `setInterval`-driven **refetch of server state**. Timers are
  permitted for liveness (heartbeat, reconnect backoff, watchdog) and local UI
  (relative timestamps). *Rev. 1's absolute ban was dogma the server already
  violates in four places: `sseHeartbeatInterval` at 30s (`tower-server.ts:285`),
  SSE max-age eviction, `seqInterval` at 10s (`tower-websocket.ts:149`), and
  `useSSE`'s reconnect jitter.* Enforce the narrow version with an ESLint rule.
  Known exception to document: `FileTree.tsx`'s 5s refresh — an fsevents watcher
  over a `node_modules`-bearing worktree is not obviously a win; it may stay a
  poll, gated on visibility.
- **FR-31 (MUST)** Subscriptions are scoped: the client receives updates for what is
  visible/open, not a full-state broadcast. **Depends on Option 0.**
- **FR-32 ⟳ (MUST)** **One *control* connection per environment, multiplexed, for
  state/spawn/send/gates. Terminal data streams remain independent connections.**
  The HTTP/1.1 6-connection ceiling is removed by serving over HTTP/2, not by
  multiplexing PTY streams. *Rev. 1's "one connection per environment, multiplexed"
  would have folded PTY bytes into the control channel, causing head-of-line
  blocking: one builder emitting a large build log would stall every other pane and
  the control channel, and the per-terminal `bufferedAmount` drop policy
  (`tower-websocket.ts:52-58`) would silently become global.*
- **FR-33 (MUST)** A backgrounded tab drops to near-zero network and CPU, and
  resynchronizes on focus without a full reload. *Already how `useSSE` behaves; the
  polls are what violate it.*

### Security

- **FR-34 (MUST)** Every RPC method carries a required scope; a valid session is not
  blanket authorization. **Tower server work.**
- **FR-35 (MUST)** Sessions are listable and individually revocable. **Tower server work.**
- **FR-36 ⟳ (MUST)** Default bind stays loopback. Exposing to LAN is an explicit,
  visible opt-in that shows the bind address, the Tailscale URL, and what it means
  in plain words. A phone on the LAN *is* the opt-in; do not invent a third
  exposure mode.
- **FR-37 ⟳ (MUST, was SHOULD)** Tailscale-aware: detect a tailnet and offer the
  MagicDNS HTTPS endpoint as the preferred address. **Promoted by both reviewers
  independently.** A plain `http://192.168.x.x` LAN address is not a secure context,
  which costs service workers, Web Push, installability, Clipboard API and parts of
  WebCrypto. Self-signed certs require a manually installed profile plus a trust
  toggle in Settings, on every device, surviving every OS upgrade. Mixed content is
  worse: an HTTPS UI cannot open `ws://192.168.x.x`. Tailscale Serve gives a real
  Let's Encrypt cert and a MagicDNS name that iOS trusts with zero configuration.
  **Alternative wording if Tailscale is rejected: "the LAN endpoint MUST present a
  certificate iOS trusts without a manually installed profile."** Without either,
  the mobile half of this document is fiction.

---

## Part 5 — Non-functional targets

Numbers, so "fast" is falsifiable.

| Metric | Target | Today |
|---|---|---|
| Workspace switch | < 100ms, no terminal teardown | Full page load + reconnect all |
| Keystroke → echo, LAN | p95 < 50ms | — |
| Cold load, LAN | < 2s to interactive | — |
| Idle network per environment | < 1 KB/s with nothing happening | Full state snapshot every 1s |
| Foreground resume ⟳ | consistent state in < 2s, no reload | — |
| Reconnect after network drop | < 3s, scrollback intact | — |

⟳ Rev. 1's "backgrounded tab: ~0 network, ~0 CPU" is a useless target on iOS — the
tab is suspended rather than throttled, so it is met trivially while measuring
nothing. Replaced with foreground resume, which is the thing that can actually be
wrong.

### Acceptance scenario ⟳

Latency numbers do not refute "poor and inefficient," which is a feeling about a
workflow. One end-to-end scenario is a better spec driver than FR-1 through FR-40,
and it exercises the cert, push, reconnect-replay and gate paths at once:

> **From a locked iPad on the sofa:** a notification arrives that builder X is
> gate-waiting. Tap it. Read the last 50 lines of that builder's terminal. Approve.
> Confirm the next phase started. **Under 30 seconds, no page reload.**

Testing tiers: Playwright at the four widths is mandatory for CI, **and real iOS
Safari on a physical iPad/iPhone is mandatory before any mobile work is called
done.** Playwright WebKit is not iOS Safari — it misses touch gestures, keyboard
push behavior, scroll momentum and safe-area rendering.

---

## Part 6 — Decisions needed from the human

Reviewer positions shown where they converged.

1. **Option 0 first?** ✅ **Decided: yes.** Both reviewers say the server-event work
   is mandatory and uncosted. Price it before any client work starts.
2. **Option 1, 2 or 3?** ✅ **Decided: Option 2**, as a consequence of decision 5.
   The five kill criteria are binding. Option 3 is closed.
3. **Transport:** ⧗ open. *Both: one typed control socket per environment, PTY sockets left
   alone. Not REST+SSE-and-also-poll; not one-socket-to-rule-them. Skip tRPC,
   Socket.IO, Convex, Zero, ElectricSQL, Yjs — the library worth having is the
   schema (zod/valibot), not the transport.*
4. **Tailscale:** ⧗ open, though FR-37 already reads MUST. *Both: MUST if mobile is MUST.*
5. **Scope of v1:** ✅ **Decided: multi-machine ships in v1.** This is what selects
   Option 2, promotes FR-1's machine level to unconditional, and moves FR-16/34/35
   from "later auth work" onto the critical path.
6. **Old UI:** ✅ **Decided: both run indefinitely, by design.** The old UI stays usable
   during and after v2's deployment, and stays the surface that merges with upstream.
   *The reviewers' "do not run two UIs indefinitely" assumed a normal repo; see Part 0.*
7. **Mobile reach:** ⧗ open. *Both: browser-only. PWA now, Capacitor as a door not walked
   through, never SwiftUI. Do not extract a new client-runtime package —
   `packages/sdk` already is one.*

---

## Part 6b — Approved design language (rev. 5)

The visual direction is settled and lives in **`codev/research/v2-mockups/`**:
`design-language.md` (the rules), `tokens.css` (palette, type, patterns),
`01-site.html` and `02-gate.html` (real markup), plus PNGs.

The identity comes from Codev's own vocabulary — Tower, Porch, Farm, Architect, Builder,
Gate, Worktree — rather than from another product. The app is a **site**; the user is its
**foreman**. Two earlier attempts were rejected: bare IDE chrome, and a
Linear/Vercel/PostHog pastiche.

Colour discipline is the load-bearing rule: **rust means a human is needed** and is used
for gates and nothing else; ochre means something may be wrong but nobody is blocked;
moss means healthy; ink is everything else. There is no fifth colour and rust is never
decoration.

Two open items recorded there: Space Grotesk should be swapped (it is on the standard
AI-generated-design tell list, and carries almost no weight here), and there is no dark
mode — the terminal panes are already ink-on-chalk inversions, so a dark theme would need
designing rather than deriving.

---

## Part 7 — What the reviews changed

Consultation ran after rev. 1. Codex was unavailable (usage limit); Gemini was
unauthenticated (`agy` exits 1). Claude Opus 5 and Grok 4.6 both reviewed with file
access. At review time `consult` had no grok lane, so Grok ran via
`opencode run --model xai/grok-4.6`. **That gap has since been closed:** `opencode` is
now a registered consult lane (default `xai/grok-4.6`), available off the default
rotation for exactly this case — a reviewer on an account the other lanes do not share.

**Claims falsified, then verified against the tree:**

| Rev. 1 claim | Status |
|---|---|
| SSE and polling are redundant; deleting polls is a client fix | **False.** SSE is a notification bus built for VS Code. No server events exist for the state FR-4 needs. |
| Option 1 has no path to mobile beyond breakpoints | **False.** `MobileLayout.tsx` and `VirtualKeyboard.tsx` exist. |
| A shared client-runtime is an Option 2 advantage | **False.** `packages/sdk` already is one, and Option 1 gets it too. |
| Multi-client PTY support is an open question | **Half false.** Attach fans out (`PtySession.clients` is a `Set`). Resize is last-writer-wins — a confirmed bug. |
| FR-30's absolute polling ban | **Dogma.** The server violates it in four places. |
| FR-19 "no native app install" | **Self-defeating.** Web Push requires Add to Home Screen. |

**Requirements changed:** FR-1, 7, 8, 19, 24, 27, 29, 30, 32, 36, 37 amended;
FR-38, 39, 40 added; Part 5's backgrounded-tab metric replaced; acceptance scenario
added.

**Both reviewers converged, independently, on:** PWA over native (Claude ~85%
confidence, Grok "high" that SwiftUI is a mistake); FR-37 to MUST; FR-32 rewritten
to keep PTY sockets separate; FR-30 narrowed; resize as the real multi-device bug;
and `Terminal.tsx`'s transport coupling as the highest risk to Option 2.

**The prior-art argument that settled Q2**, reached independently by both: Blink
Shell, Termius and Prompt are native because *the terminal is the product*, sold to
millions, needing raw TCP and Keychain. Codev's product is the tree, the gates and
porch; the terminal is one pane, the PTY is already server-side, and the transport
is already HTTP/WS. Their constraint is not ours. Microsoft shipped `vscode.dev`
rather than a native iPad app, and omitted terminals — for a reason we do not share,
since we have a server. The bar here is "approve a gate and peek at a builder from
the couch," not "daily-drive Claude Code on glass."

**Cost of native, stated honestly:** a second UI in Swift for one person. Terminals
are the easy native part; the Codev chrome is the work, and it gets built twice and
drifts. SwiftTerm's bug surface replaces the 14 regression tests rather than
reusing them — re-earning exactly the scar map §1.4 says must not be re-earned. Add
$99/yr (or 7-day re-sideloading) and a **fifth** client for every protocol change.
The entire delta native buys is a keyboard accessory bar and background push;
`VirtualKeyboard` is most of the former, and Tailscale plus a home-screen PWA gives
the latter.

---

## Appendix — Verified, assumed, and what to spike

**Verified in this repo (rev. 1):** file sizes and paths; the 1000ms/2500ms polls;
the SSE singleton and its 6-connection rationale; the `remote:` stub at
`tower-instances.ts:279`; Terminal.tsx's size and test coverage; the two-front-end
split.

**Verified in this repo (rev. 2):** `broadcastNotification` as sole SSE emitter and
its five types; `tower-routes.ts:643`'s VS Code rationale; `packages/sdk`'s stated
purpose; `MobileLayout.tsx` and `VirtualKeyboard.tsx`; `PtySession.clients` as a
`Set` with fan-out and tests; `resize()` as a single global call; four Tower
clients; `FileTree.tsx:153`'s 5s poll; `VirtualKeyboard`'s duplicated
`FRAME_DATA = 0x01`.

**Verified from primary sources:** T3 Code's architecture and remote-access model;
dockview's feature set, licence and dependency count; iOS Web Push requiring
home-screen install (16.4+, Declarative Web Push in 18.4); iOS suspending
WebSockets on lock.

**Second-hand, treat as soft:** BridgeSpace's feature list. dockview's *current*
iPad touch quality. Safari's exact live-WebGL-context cap.

### Spikes, re-ranked — all before any spec

1. **Multi-client resize policy — in the v2 layer.** Confirmed bug
   (`pty-session.ts:567` is last-writer-wins), blocks the two-device premise. **Do not
   change `PtySession`'s contract:** that file is untouched by the fork and hot upstream.
   Spike a v2-owned attach wrapper that negotiates per-viewer dimensions. Do this first.
2. **HTTPS on a phone.** Tailscale Serve to an iPhone: pairing, WS, PWA install,
   push permission, one delivered notification. **If this fails, the mobile half of
   this document is fiction.**
3. **iPad keyboard weekend test** on the *current* app: an hour with a hardware
   keyboard, twenty minutes without. Decides PWA vs a later Capacitor shell. Costs
   nothing.
4. **`Terminal.tsx` reuse strategy** — vendor a copy, import unmodified, or upstream the
   refactor (Part 0). Rev. 3 recommended refactoring it in place; rev. 4 downgrades that,
   because it is an upstream file. *Recommend importing unmodified for v1.*
5. **dockview on a real iPad**, only if FR-7's tablet clause is promoted to MUST.

**No longer a spike:** "can Tower serve multiple clients per terminal" — yes, it
does. **Downgraded:** sharing the environment list with `afx` (v1 can hold two
lists; merge later) and what porch state the gate UI needs (gates render today;
inventory the existing overview payload instead).
