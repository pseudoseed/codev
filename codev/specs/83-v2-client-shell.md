# Specification: v2 client shell — apps/v2 renders the live hierarchy

- **Issue:** #83
- **Program:** Codev v2 UI (#37)
- **Protocol:** SPIR
- **Status:** Draft, rev. 3
- **Depends on:** spec 52 (v2 server events), merged

## Problem Statement

Spec 52 shipped `GET /v2/events`: a scoped, push-based stream carrying the hierarchy. **Nothing has ever consumed it.** Its tests drove fake in-process clients; no browser has opened it.

So the contract is unverified in the only way that counts. The snapshot shape, the `streamId`-bound resume, the four statuses, the `tick` buckets, the `counts` rollup and `gone` semantics have all been asserted by their author and never read by a client that had to render them.

Meanwhile `apps/v2` does not exist. FRD Part 0 decided it must: a new fork-owned pnpm workspace is the only change shape that survives upstream merges.

## Current State

| Piece | Where | State |
|---|---|---|
| Event stream | `GET /v2/events` (`v2-routes.ts`) | shipped, unconsumed |
| Wire types | `packages/types/src/v2-events.ts` | shipped |
| Mount | one `/v2/` prefix branch, `tower-routes.ts:282` | shipped; **reuse it, do not add a second** |
| Dispatch | `handleV2Route`, `v2-routes.ts:250` | 404s every path but `GET /v2/events`; needs a prologue (D6) |
| Key injection | `injectWebKey`, `tower-routes.ts:2441` | module-private; `v2-static.ts` reimplements it (D6) |
| Client runtime | `packages/sdk` (`@cluesmith/codev-sdk`) | untouched, environment-agnostic, zero runtime deps |
| Auth precedent | `apps/web/src/hooks/useSSE.ts:8-12` | `fetch` + `ReadableStream`, because `EventSource` cannot set headers |
| Design, site view | `codev/research/v2-mockups/01-site.html` | real markup, pattern classes |
| Palettes | `tokens.css`, `tokens-dark.css` | shipped |
| Design of record | 27 designs, `codev/research/v2-mockups/uxpilot/` | previews on `main`; HTML not pulled |
| `apps/v2` | — | does not exist |

## Desired State

`/v2/` serves one page that opens the stream and draws this machine's hierarchy from the approved site design, updating by push, with no timer anywhere in the client.

## Goals

1. `apps/v2` exists as a fork-owned workspace and builds.
2. The stream is consumed correctly, every frame type handled.
3. The site view renders per the approved design, using the shipped tokens.
4. FR-1, FR-3, FR-4, FR-41, FR-42 and FR-15 are satisfied and demonstrable in a browser.
5. **The wire contract is exercised by a real client**, and any place it fails a renderer is reported rather than worked around.

## Non-Goals

Tiling (FR-7), terminals (FR-27), gates UI (FR-43 to FR-48), pairing (FR-16), the command palette (FR-5), mobile layouts (FR-19 to FR-26), theme switching. Each is a later unit. **Reading the tree is this one.**

## Constraints

**C1 — Additive only, and these files are byte-unchanged.** `apps/web`, `packages/codev/templates/tower.html`, `apps/vscode`, `apps/streamdeck`, `tower-server.ts`, `pty-session.ts`, **and `tower-routes.ts`**. The `/v2/` prefix branch at `tower-routes.ts:282` already hands everything under `/v2/` to `handleV2Route`; adding a second insertion point defeats the seam.

**One exception, and it is bounded:** `isPublicRoute` in `server-utils.ts` gains `GET /v2/` and `GET /v2/assets/*`. See D9 — without it the page 401s before it can be served.

**C2 — The wire contract is frozen; the dispatch is not.**

Frozen, no edits: `v2-events.ts`, `v2-sampler.ts`, `v2-projection.ts`, `v2-status.ts`, `v2-ids.ts`, `packages/types/src/v2-events.ts`. If the contract cannot be rendered, that is a finding to report, not an edit to make.

Permitted, and required: a new `v2-static.ts`, plus **one bounded change to the dispatch prologue of `handleV2Route` in `v2-routes.ts`**. Everything below that prologue — scope parsing, resume, frame emission — is frozen.

This is a correction to rev. 1, which froze both files that own `/v2/`. `handleV2Route` 404s every path that is not `GET /v2/events` (`v2-routes.ts:250-254`), and `tower-routes.ts` is the only other place that could route. Under rev. 1's constraints there was no file left that could serve the page.

**C3 — `packages/sdk` unmodified, and its SSE helpers are the wrong tool.** Import from it; do not extend it here.

`subscribeEvents` (`tower-client.ts:1085`) and `parseSseText` (`sse.ts:18`) target `GET /api/events` and a `{type, body}` envelope. **V2 frames are the bare `data:` payload with no envelope.** Reusing those helpers would silently mis-parse every frame. Write the v2 stream reader in `apps/v2`. `listWorkspaces()` (`tower-client.ts:400`) *is* the right SDK call, and D7 is the only place the client uses it.

**C4 — No polling.** No `setInterval`, no `setTimeout`-driven refetch, no re-fetch on focus. The only timer permitted is reconnect backoff.

**C5 — FR-49 from the first line.** A pane is a viewer. Nothing in the client may terminate a session. This unit has no panes; the rule is established before anything can violate it.

## Assumptions

1. `fetch` + `ReadableStream` carries the `codev-tower-key` header where `EventSource` cannot. **Verified**: `useSSE.ts:8-12` documents exactly this and cites GHSA-xvjp-7748-v88v.
2. React 19 + Vite + Vitest is the house stack. **Verified** against `apps/web/package.json`. Reuse it; this is not the place to introduce a framework.
3. ~~The `/v2/` prefix authenticates like every other route, since `isRequestAllowed` runs before dispatch and `/v2/` is not in `isPublicRoute`.~~ **Correct for `/v2/events`, and it is exactly why the page could not be served.** Rev. 3 keeps the fact and drops the conclusion. See D9.
4. `recharts` is already a dependency of `apps/web`. **The sparkline does not need it.** FR-41's trace is 20 integers; `.spark` in `tokens.css` renders it with flexbox and `<i>` elements. Do not add a charting library for 20 bars.

## Locked Structural Decisions

### D1 — One reducer over frames, and it is the whole state model

The stream is the source of truth. The client holds `Map<nodeId, Node>` plus `Counts` plus the cursor, and every frame is a transition:

| Frame | Client action |
|---|---|
| `snapshot` | Replace the map wholesale. Store `streamId` and `seq`. Store `buckets`. |
| `resumed` | Nothing to the map. Confirms the resume was honoured; clears any "reconnecting" state. |
| `node` | Upsert by `id`. **Do not touch `buckets`** — they are absent on upserts by contract. |
| `gone` | Delete by `id`. |
| `counts` | Replace `Counts`. |
| `tick` | Advance every in-scope builder's trace: append the frame's value for that id, or **zero if the id is absent**, then drop the oldest. |
| `dark` | Mark the named **`workspace:<path>`** dark, with its `reason`. Keep every other node streaming. See D5. |

**`tick` is the only writer of `buckets` after the snapshot.** That is contract, not preference: `node` frames carry no buckets precisely so two clients cannot diverge.

**Absence in `tick` means zero.** Rendering absent builders as "unchanged" would make a silent builder's sparkline freeze at its last value and read as if it were still working, which inverts FR-42's entire purpose.

### D2 — Reconnect resumes; it does not refetch

On disconnect, reconnect with `since` and `stream` from the last frame. Handle both answers:

- `resumed` then deltas: apply them.
- `snapshot` with `resumed: false`: replace the map.

**Never treat a reconnect as "reload the page".** The whole point of the stream is that state survives the socket.

Backoff is the only timer in the client. Start at 1s, cap at 15s, reset on a successful frame.

### D3 — Status maps to the design, not to invented visuals

Four statuses ship (spec 52): `gate-waiting`, `stalled`, `running`, `offline`. The design already has a treatment for each and the colour discipline is binding.

| Status | Treatment | Token |
|---|---|---|
| `gate-waiting` | `GATE` stamp, `.needs-attn` pulse | `--rust` |
| `stalled` | `STALLED` stamp | `--ochre` |
| `running` | `RUN` stamp | `--moss` |
| `offline` | `.dim-sub`: keeps its shape, loses its life | none |

**Rust is used for gates and nothing else.** Not for errors, not for emphasis, not for the reconnecting indicator. `heldMail` is a flag, not a status, and renders as a mark on the row without displacing the status.

There is no fifth colour and no fifth status. If a node arrives with a status not in that set, render it visibly wrong rather than defaulting to `running` — a silent fallback would hide a contract break.

### D4 — Containment, not an outline

FR-1 is explicit and FR-21's old wording contradicted it (fixed at FRD rev. 9). Hierarchy is nested space: machine lot → workspace plot → architect header → builder row. **No disclosure triangles, no indent guides, no tree widget.** `01-site.html` is the reference and it already does this.

### D5 — Three states that must not look alike: empty, dark, unreachable

FR-15. Rev. 1 called a `dark` frame a machine. It is not: `darkFrame` is emitted with `workspaceId(d.path)`, so `dark.id` is **`workspace:<path>`** (`v2-routes.ts:394-395`), one workspace inside a live scope, with a `reason` of `unknown` or `unreadable`. Spec 52 criterion 10 is explicit: that path goes dark, the rest of the scope keeps streaming.

Three distinct renderings, and conflating any two of them is a defect:

| State | How it arrives | Rendering |
|---|---|---|
| **Empty** | `snapshot` with `nodes: []`, or zero workspaces from D7 | The site view with no plots, and it says so |
| **Dark workspace** | A `dark` frame naming `workspace:<path>` | That plot renders dark and labelled with its `reason`; every other plot keeps streaming |
| **Unreachable Tower** | The `fetch` fails, or 401/403 — **no frame arrives at all** | A connection state on the whole page, not an empty tree. Reconnect per D2 |

The unreachable case is the one with no wire signal, so it is the one that will default to looking empty. It must not. A page that cannot reach Tower and a machine with nothing running are opposite facts.

### D6 — Serving the page, and how the key gets into it

`apps/v2` builds to static assets. A new `v2-static.ts` serves them, reached through the dispatch prologue C2 permits:

| Path | Handler |
|---|---|
| `GET /v2/events` | the frozen stream path, unchanged |
| `GET /v2/` | the built `index.html`, key-injected |
| `GET /v2/assets/*` | built assets, by extension allowlist, no traversal |
| anything else under `/v2/` | 404, as today |

**The key injection is duplicated on purpose, and the duplication is tested.** `injectWebKey` and `sendKeyInjectedHtml` (`tower-routes.ts:2441`, `:2466`) are module-private, and `tower-routes.ts` imports `v2-routes.ts` at line 51 — so exporting them would either edit a file C1 freezes or create an import cycle. `v2-static.ts` therefore imports `getExpectedKey` from `server-utils.ts` (already exported, zero edits) and reimplements the injection.

Three properties are load-bearing and each gets a test, because a copied security rule drifts:

1. The key is embedded via `JSON.stringify` and **only** when it matches `/^[0-9a-f]{64}$/`. A malformed key yields no injection and the client fails closed with 401. This is stored-XSS prevention, not defensiveness.
2. `Access-Control-Allow-Origin` and `Vary` are **removed** from the HTML response. The body carries the key; the shell is only ever loaded same-origin. Leaving the header on makes the key readable by a cross-origin `fetch` (GHSA-xvjp-7748-v88v).
3. The injection lands before `</head>`, ahead of the deferred module, so `window.__CODEV_TOWER_KEY__` is set before the app's first request.

Both implementations carry a comment naming the other.

### D7 — Scope is required, fetched exactly once, and **not** through `listWorkspaces()`

`GET /v2/events` without `scope` is a 400 (`v2-routes.ts:260-264`). Rev. 1 never said where the client gets scope paths.

One bootstrap `GET /api/workspaces` at startup, with the key header, **as a raw `fetch` in `apps/v2` that branches on HTTP status**. Its workspace paths become the `scope`. It is not polled and is not repeated on reconnect — reconnect reuses the scope it already has, because re-deriving scope on every reconnect is polling wearing a different hat (C4).

**Rev. 2 said to use the SDK's `listWorkspaces()`. That was wrong and it broke D5.** The method returns `[]` when `result.ok` is false (`tower-client.ts:400-403`), so 401, 403, 500 and a dead socket all arrive as an empty list. D5 requires unreachable and empty to be distinguishable; through that method they are the same value. This is the general rule, not a local quirk: **"I could not tell" must never be spelled the same way as "no."** C3 forbids changing the SDK, so the client does its own fetch — the same reason it writes its own stream reader.

Three outcomes, three renderings:

| Bootstrap result | Scope | Render |
|---|---|---|
| 200, one or more workspaces | those paths | open the stream |
| 200, zero workspaces | none | the empty site (D5). **Do not open the stream** — an empty `scope` takes a 400 and would read as a connection failure |
| non-200, or the fetch throws | unknown | the unreachable state (D5), and retry with D2's backoff |

### D9 — `/v2/` and its assets must be public routes

`isRequestAllowed` runs before dispatch and `isPublicRoute` (`server-utils.ts:142`) does not list `/v2/`. A browser navigating to `/v2/` sends no `codev-tower-key` header, and neither do the `<script>` and `<link>` tags the shell emits. Under rev. 2 the page 401s before `v2-static.ts` is ever reached, and D6's key injection can never run.

**The precedent is already in that function and it is the same shape.** The annotator's HTML shell and its `vendor/` libraries are public "because iframe navigation and `<script>`/`<link>` tags that cannot carry the key header" load them, while every data sub-route stays keyed (`server-utils.ts:156-165`). `/v2/` is that case exactly.

The change is two clauses:

- `GET /v2/` → public. Carries no secret until injection, and injection only ever happens on a same-origin navigation.
- `GET /v2/assets/*` → public. Built JS and CSS, extension-allowlisted, no traversal.

**`/v2/events` stays keyed.** It carries live state and the shell fetches it with the key. Every other path under `/v2/` stays keyed too.

The Host guard, origin checks and the rest of `isRequestAllowed` are untouched — this widens `isPublicRoute` only, and only for two `GET` shapes.

### D8 — What of the design ships here

`01-site.html` is the reference and it contains more than this unit builds. The cut is named so it is not argued later.

**In:** the machine lot, the workspace plot, the architect header, the builder row, the four status stamps, the activity sparkline, the `heldMail` mark, `.grid-bg`, `.dim-sub`, `.needs-attn`.

**Out, and left out of the markup entirely rather than stubbed:** the gate rail, Find node, Add machine, the terminal bank, the command palette. A disabled stub of a later unit is a promise the tree cannot keep.

## Success Criteria

### Functional

1. `/v2/` loads and renders every machine, workspace, architect and builder the stream reports.
2. Spawning a builder makes its row appear **with no reload and no client timer**.
3. A builder entering a gate renders rust with a `GATE` stamp.
4. A builder silent past `IDLE_WAITING_THRESHOLD_MS` renders ochre and `STALLED`.
5. Every builder row shows a sparkline that advances on `tick`, and flattens to zero for a silent builder rather than freezing.
6. `afx cleanup` on a builder removes its row.
7. Killing the connection and restoring it recovers state via resume or a flagged snapshot, **without a page reload**.
8. A `dark` frame renders **that workspace plot** dark with its reason, and every other plot keeps streaming.
9. Tower unreachable renders a connection state, **not** an empty tree. Zero workspaces renders an empty tree, and the two are visibly different.
10. Two browser tabs on the same scope show identical trees.

### Non-functional

11. **No polling.** `grep` for `setInterval` in `apps/v2/src` returns only reconnect backoff, and that is named as such. `/api/workspaces` is requested exactly once per page load — provable in the devtools network panel.
12. Cold load under 2s to interactive on LAN (Part 5).
13. Idle network under 1 KB/s with nothing happening (Part 5), measured in devtools.
14. `GET /v2/` serves the app with `window.__CODEV_TOWER_KEY__` set, and the response carries **no** `Access-Control-Allow-Origin`.
15. **A browser navigating to `/v2/` with no header gets the page, not a 401.** `GET /v2/events` with no header still gets a 401.
16. A failing bootstrap and a zero-workspace bootstrap produce different renderings — asserted against a 401, a 500, a thrown fetch, and a 200 with `[]`.

### Non-regression

17. `apps/web`, `tower.html`, `apps/vscode`, `apps/streamdeck`, `tower-server.ts`, `pty-session.ts` and **`tower-routes.ts`** are byte-unchanged. `git diff --stat` proves it.
18. The only change to `v2-routes.ts` is the dispatch prologue. The only change to `server-utils.ts` is the two `GET /v2/` clauses in `isPublicRoute`. The frozen files in C2 are byte-unchanged.
19. Existing test suites pass untouched, including spec 52's 57 v2 tests and the existing `isPublicRoute` cases.

## Solution Approaches

**A. Chosen — React 19 + Vite in a new `apps/v2` workspace, one reducer over the frame stream.** Matches the house stack, reuses `packages/sdk`, and the reducer makes every frame type's handling explicit and testable without a browser.

**B. Vanilla TS, no framework.** Rejected. `tower.html` is the cautionary example: 1,894 lines of hand-rolled HTML with an inline script is one of the three structural causes the FRD names for the current UI being replaced.

**C. Extend `apps/web` with a v2 route.** Rejected under C1. It is a hot upstream file set and the fork has barely touched it; that is the merge cost Part 0 exists to avoid.

**D. Server-rendered.** Rejected. The stream is a live push contract; server rendering re-introduces a request cycle for state that arrives on its own.

## Open Questions

**N/A — all previously open questions are resolved in D6, D7 and below.**

### Resolved

Both were open at rev. 1 and are now decided. Neither is a builder decision.

1. **Dev server proxies through Tower.** Vite's dev server proxies `/v2/events` and `/api/*` to port 4100. A separate origin would need CORS handling that exists in dev and has no production counterpart, which is dev-only code on the auth path.
2. **Light is the default.** `tokens.css` is the reviewed palette. `tokens-dark.css` has been read by nobody against real markup, and this unit is not where that gets discovered. Theme switching is a later unit; ship one palette.

## Test Scenarios

1. **Reducer: every frame type.** Unit-test each row of D1's table against fixtures. No browser.
2. **`tick` absence means zero.** Feed a `tick` omitting a builder; assert its trace appends 0, not a repeat of its last value.
3. **`node` upsert does not touch buckets.** Feed a `node` frame; assert the trace is unchanged.
4. **Resume honoured.** `resumed` + deltas; assert no map replacement.
5. **Resume refused.** `snapshot` with `resumed: false`; assert wholesale replacement.
6. **Unknown status.** Feed a status outside the four; assert it renders visibly wrong and does not fall back to `running`.
7. **Dark vs empty vs unreachable.** Three cases, three renderings: a `dark` frame for one `workspace:<path>` leaves the others live; `nodes: []` renders the empty site; a failing `fetch` renders a connection state and never an empty tree.
8. **Two-client convergence.** Drive 50 frames into two reducer instances; assert identical final state.
9. **No polling.** Static check: `setInterval` in `apps/v2/src` appears only in reconnect backoff.
10. **Live browser.** Playwright at 1440: load, spawn a builder, assert its row appears without reload.
11. **Non-regression.** `git diff --stat` on the frozen C1 files, including `tower-routes.ts`, is empty.
12. **Key injection, three properties.** Malformed key yields no injection; the HTML response has no `Access-Control-Allow-Origin` or `Vary`; the script precedes `</head>`.
13. **Scope bootstrap.** `/api/workspaces` is requested once; a reconnect reuses the cached scope and does not re-request it.
14. **Zero workspaces.** `listWorkspaces()` returns `[]`; assert the stream is never opened and the empty site renders.
15. **Static serving.** `GET /v2/assets/../../etc/passwd` is refused; a non-allowlisted extension is refused; `GET /v2/nonsense` is 404.
16. **Public vs keyed.** No-header `GET /v2/` → 200; no-header `GET /v2/assets/index.js` → 200; no-header `GET /v2/events?scope=…` → 401; no-header `POST /v2/` → not public.
17. **Bootstrap failure is not emptiness.** Four cases — 401, 500, thrown fetch, and 200 with `[]` — produce the unreachable state for the first three and the empty state for the fourth.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---:|---|---|
| The wire contract fails a real renderer | Medium — it has never been consumed | High — blocks the client | Report it; C2 forbids patching the server from here |
| Absent-in-`tick` rendered as unchanged | High — it is the natural reading | High — a stalled builder looks busy, inverting FR-42 | D1 states it; scenario 2 asserts it |
| A charting library added for 20 bars | Medium — `recharts` is already in the monorepo | Medium — bundle and a dependency for a flexbox job | Assumption 4; `.spark` already exists in `tokens.css` |
| Rust used for something other than gates | High without a rule | High — the colour discipline is the design | D3 states it; review the diff for `--rust` uses |
| A second `/v2/` mount added | Medium | High — defeats the one-insertion-point seam | Criterion 14 makes it falsifiable |
| Reconnect implemented as page reload | Medium — it is the easy path | High — discards the reason for the stream | D2 states it; scenario 7 asserts no reload |
| Polling creeps in for something the stream lacks | Medium | High — reproduces the problem v2 exists to solve | C4 and criterion 11; if the stream lacks it, that is a finding |
| Scope re-derived on every reconnect | Medium — it looks like correctness | Medium — polling by another name | D7; scenario 13 |
| The copied key injection drifts from `injectWebKey` | Medium — two copies of a security rule | High — stored XSS, or a key readable cross-origin | D6's three tested properties; cross-reference comments both ways |
| Unreachable Tower renders as an empty tree | High — it is the default behaviour of a failed fetch | High — inverts FR-15 | D5's three-state table; scenario 7 |
| `subscribeEvents` reused for the v2 stream | Medium — it is right there in the SDK | High — silently mis-parses every frame, wrong endpoint and wrong envelope | C3 names it |
| `listWorkspaces()` used for the bootstrap | High — it is the obvious SDK call and rev. 2 asked for it | High — collapses 401, 500 and a dead socket into `[]`, so unreachable renders as empty | D7 states it with the line number; scenario 17 |
| `isPublicRoute` widened further than two `GET` shapes | Medium | High — `/v2/events` or a future `/v2/` write path becomes unauthenticated | D9 and criterion 18; scenario 16 asserts `/v2/events` still 401s |
| Later-unit chrome stubbed into the site view | Medium | Medium — a disabled control reads as broken | D8 |

## References

- FRD rev. 9: `codev/research/codev-v2-ui-frd.md` — Part 0, FR-1, FR-3, FR-4, FR-15, FR-41, FR-42, FR-49, Part 5
- Wire contract: `codev/specs/52-v2-server-events.md`
- Server: `packages/codev/src/agent-farm/servers/v2-{routes,events,sampler,projection,status,ids}.ts`
- Wire types: `packages/types/src/v2-events.ts`
- Auth precedent: `apps/web/src/hooks/useSSE.ts:8-12`
- Design: `codev/research/v2-mockups/01-site.html`, `tokens.css`, `tokens-dark.css`
- Design of record: `codev/research/v2-mockups/uxpilot/MANIFEST.md`
