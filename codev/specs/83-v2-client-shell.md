# Specification: v2 client shell — apps/v2 renders the live hierarchy

- **Issue:** #83
- **Program:** Codev v2 UI (#37)
- **Protocol:** SPIR
- **Status:** Draft, rev. 8
- **Depends on:** spec 52 (v2 server events), merged

## Problem Statement

Spec 52 shipped `GET /v2/events`: a scoped, push-based stream carrying the hierarchy. **Nothing has ever consumed it.** Its tests drove fake in-process clients; no browser has opened it.

So the contract is unverified in the only way that counts. The snapshot shape, the `streamId`-bound resume, the four statuses, the `tick` buckets, the `counts` rollup and `gone` semantics have all been asserted by their author and never read by a client that had to render them.

Meanwhile `apps/v2` does not exist. FRD Part 0 decided it must: a new fork-owned pnpm workspace is the only change shape that survives upstream merges.

## Current State

| Piece | Where | State |
|---|---|---|
| Event stream | `GET /v2/events` (`v2-routes.ts`) | shipped; **consumed once, by hand, at rev. 4** |
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

## Verified against the live stream

Rev. 1 said the contract "has never been consumed by anything." At rev. 4 it has been, once: a `curl` against the running Tower on port 4100, with the key header, decoding real frames. Five things came back that no reading of the code had produced, and each one changed the spec.

| # | Observed | Consequence |
|--:|---|---|
| 1 | `V2NodeKind` emits `workspace \| architect \| builder`. **No machine node, ever.** | D10. Criterion 1 was unimplementable as written. |
| 2 | Scope of 1 workspace → 16 nodes, but `counts` said `{workspaces: 22, builders: {total: 58}}` | D11. `counts` is machine-wide, not the scope's rollup — off by 45 builders in the observed case. |
| 3 | `encodeURIComponent(paths.join(','))` → **HTTP 200**, `nodes: []`, and a `dark` frame | D12. `parseScope` splits the raw value before decoding. The failure is silent and renders as a plausible empty machine. |
| 4 | All 13 builders returned `parentId: "workspace:<path>"`. **Zero architect parents.** | D13. FR-3 is not satisfiable from this stream. |
| 5 | A dark workspace appeared in a `dark` frame **and not in `nodes`** | D5, D1. `darkPaths` must be a separate store; there is no node to mark. |
| 6 | A live tick arrived as `{"seq":1,"type":"tick","at":"…","buckets":{}}` | D1. `buckets` is `number[]` on a node and `Record<id,number>` on a tick — one name, two shapes. The empty object is the common case. |
| 7 | `darkPaths` is computed once at connect and `inScopeSet` excludes it (`v2-routes.ts:302-314`) | D5. Dark can never clear on a live connection, in either direction. Filed as **#98**. |

Findings 1, 2, 4 and 7 are properties of the shipped contract. C2 stands — they are reported, not patched from here. Two are filed: **#97** (FR-3 unmet) and **#98** (dark decided once per connection).

## Desired State

`/v2/` serves one page that opens the stream and draws this machine's hierarchy from the approved site design, updating by push, with no timer anywhere in the client.

## Goals

1. `apps/v2` exists as a fork-owned workspace and builds.
2. The stream is consumed correctly, every frame type handled.
3. The site view renders per the approved design, using the shipped tokens.
4. FR-1, FR-4, FR-41 and FR-42 are satisfied and demonstrable in a browser. **FR-3 is not** (D13). **FR-15 is deferred, not satisfied** (D5).
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

`subscribeEvents` (`tower-client.ts:1085`) and `parseSseText` (`sse.ts:18`) target `GET /api/events` and a `{type, body}` envelope. **V2 frames are the bare `data:` payload with no envelope.** Reusing those helpers would silently mis-parse every frame.

**This unit calls no SDK method at all.** Rev. 2 named `listWorkspaces()` as the right bootstrap call; D7 rev. 3 established that it cannot be, and rev. 4 removes the endorsement here so the two do not disagree. `apps/v2` writes its own stream reader and its own bootstrap fetch. It may import **types** from `packages/types`; it imports no client behaviour.

**C4 — No polling.** No `setInterval` anywhere — **zero occurrences**, not "only in backoff". No `setTimeout`-driven refetch, no re-fetch on focus, no re-fetch on visibility change.

**Exactly one `setTimeout` is permitted**, the reconnect backoff of D2, and it is named as such at its call site. Rev. 3's criterion said `setInterval` "only in reconnect backoff", which contradicted itself: backoff is a one-shot delay and `setTimeout` is its shape.

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
| `snapshot` | Replace `nodes` and `darkPaths` wholesale. Store `streamId`, `seq`, `buckets`, **and `counts`**. |
| `resumed` | Nothing to the map. Confirms the resume was honoured; clears any "reconnecting" state. |
| `node` | Upsert by `id`. **Do not touch `buckets`** — they are absent on upserts by contract. |
| `gone` | Delete by `id`. |
| `counts` | Replace `Counts`. |
| `tick` | Advance every in-scope builder's trace: append the frame's value for that id, or **zero if the id is absent**, then drop the oldest. |
| `dark` | Mark the named **`workspace:<path>`** dark, with its `reason`. Keep every other node streaming. See D5. |

The client holds **two** stores, not one. `nodes: Map<nodeId, Node>` and `darkPaths: Map<workspaceId, reason>`, because a dark workspace is **not in `nodes`** (D5). `counts` is a third value and it is not a rollup of either (D11).

**Every accepted frame advances the cursor to its `seq`** — deltas included, not only snapshots. Rev. 3 stated it for `snapshot` alone, which would make a reconnect after 500 deltas resume from the snapshot and replay all of them.

Four degenerate cases, each with a defined answer, because the natural handling of all four is to render something plausible and wrong:

| Case | Answer |
|---|---|
| A frame that is not valid JSON | **Terminal for this connection.** See below. Never treat a parse failure as a `gone`. |
| A frame with an unknown `type` | **Terminal for this connection.** See below. There is no silent ignore. |
| Stream EOF (server closed cleanly) | Reconnect with `since` and `stream` per D2. Not an error state, not an empty tree. |
| Non-2xx on the stream request | The unreachable state (D5) plus backoff. A 400 here means the client built a bad `scope` — see D12 — and must say so rather than render empty. |

**A bad frame is terminal, and recovery is bounded at one attempt.** Rev. 6 said to drop the frame and not advance the cursor. That is unsafe two ways: frame `N+1` then applies on top of a tree that silently missed `N`, giving a corrupt-but-plausible render; and a reconnect resumes from before `N`, so the server replays the same bad frame forever.

The rule:

1. Stop applying frames. Enter a **contract mismatch** state and say so on the page — this is not the unreachable state and must not look like it.
2. Make **one** recovery attempt: reconnect **without** `since` and `stream`, forcing a fresh `snapshot` rather than a resume.
3. If a bad frame arrives on that fresh connection too, stay in the mismatch state and **stop**. No further attempts. A contract the client cannot read is not a transient fault and retrying it is a spin, not a recovery.

**What the mismatch state can say depends on how far the frame got.** Rev. 7 demanded the `seq` and `type` of a frame that failed to parse — neither is knowable from invalid JSON.

| How it failed | What the state says |
|---|---|
| Did not parse as JSON | `invalid JSON after cursor <N>`, plus the first 120 bytes of the offending line, escaped |
| Parsed, unknown `type` | the `type` verbatim, and the `seq` if it is a number |
| Parsed, known `type`, invalid fields | the `type`, the `seq`, and which field failed |

A client that cannot say what broke it is not reporting, it is failing quietly. But it must only claim what it actually decoded.

**TypeScript does not validate the wire.** `packages/types` describes the frames; nothing checks that a decoded object matches. Every frame is validated at runtime before it reaches the reducer, and a known `type` carrying a bad payload is **terminal**, same as an unknown type:

- `seq` is not a number
- `node`/`gone`: no `id`, or `id` is not a string
- `node`: no `kind`, or `kind` outside `workspace | architect | builder`
- `snapshot`: `nodes` is not an array, or `counts` is missing or malformed
- `tick`: `buckets` is not an object, or any value in it is not a number
- `dark`: no `id`, or the `id` does not parse as `workspace:<path>`

**One deliberate exception, and it is not a validation failure.** A structurally valid node carrying a `status` outside the four ships as D3 says: rendered **visibly wrong**, not terminal, not defaulted to `running`. The distinction is the point — an unexpected *value* in a well-formed frame is a contract drift the page should show and keep running through; a malformed *frame* is a contract the client cannot read at all.

**`tick` is the only writer of `buckets` after the snapshot.** That is contract, not preference: `node` frames carry no buckets precisely so two clients cannot diverge.

**`buckets` is two different shapes under one name.** On a node it is `number[]` — a 20-length trace (`v2-events.ts:13`). On a `tick` it is `Record<builderId, number>` — one value per builder (`v2-events.ts:54`). A reducer that treats them alike breaks on the first tick. Confirmed on the wire: a live tick arrived as `{"seq":1,"type":"tick","at":"…","buckets":{}}`.

That empty object is the **common** case, not an edge one — it is what every tick carries while nothing is producing output.

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

**FR-15 is deferred here, not satisfied.** It reads "one **environment** being down or unreachable degrades that subtree only," and an environment is a connected Tower (FR-14, FR-16), not a workspace. This unit has exactly one environment, so when it is unreachable the whole page *is* the subtree — there is no sibling left running to prove the requirement. Rev. 6 listed FR-15 as a goal; rev. 7 removes the claim. What follows anticipates FR-15's shape and lands as its foundation when pairing arrives.

Rev. 1 called a `dark` frame a machine. It is not: `darkFrame` is emitted with `workspaceId(d.path)`, so `dark.id` is **`workspace:<path>`** (`v2-routes.ts:394-395`), one workspace inside a live scope, with a `reason` of `unknown` or `unreadable`. Spec 52 criterion 10 is explicit: that path goes dark, the rest of the scope keeps streaming.

Three distinct renderings, and conflating any two of them is a defect:

| State | How it arrives | Rendering |
|---|---|---|
| **Empty** | `snapshot` with `nodes: []`, or zero workspaces from D7 | The site view with no plots, and it says so |
| **Dark workspace** | A `dark` frame naming `workspace:<path>` | That plot renders dark and labelled with its `reason`; every other plot keeps streaming |
| | **and there is no `Node` for it** | the plot is built from the id alone — decode the path out of `workspace:<path>` and use its basename as the label |
| **Unreachable Tower** | The `fetch` fails, or 401/403 — **no frame arrives at all** | A connection state on the whole page, not an empty tree. Reconnect per D2 |

The unreachable case is the one with no wire signal, so it is the one that will default to looking empty. It must not. A page that cannot reach Tower and a machine with nothing running are opposite facts.

**A dark workspace has no `Node`, and this is measured, not inferred.** Against the live stream, a scope naming one unreadable path returned `"nodes":[]` *and* a `dark` frame for that path in the same snapshot. So `darkPaths` is a separate store, and rendering a dark plot means constructing it from the encoded id — there is nothing in `nodes` to mark.

**Dark is decided once per connection and never re-evaluated. Rev. 5 claimed a recovering workspace clears itself; it cannot.** `handleV2Route` computes `darkPaths` and `inScope` in one pass at connect time (`v2-routes.ts:302-314`), and `inScopeSet` — what the watcher and projection use — excludes the dark paths. `deps.isReadable(p)` is never called again on that connection. Both directions are broken: a workspace that becomes readable stays dark forever, and one that becomes unreadable never goes dark, so it reads as live-but-quiet.

Filed as **#98**. The client's obligation is narrow and it is all the client can honestly do:

- Replace `darkPaths` wholesale on every `snapshot`, which is the only frame that can clear one.
- **Do not poll to refresh readability.** C4 forbids it and reconnecting to force a snapshot is polling with extra steps.
- Do not claim more freshness in the UI than the contract carries. The dark plot's label says what the server said and when.

The dark signal is therefore true at connect and decays after. That is a contract limitation, recorded, not a client bug to code around.

### D6 — Serving the page, and how the key gets into it

`apps/v2` builds to static assets. A new `v2-static.ts` serves them, reached through the dispatch prologue C2 permits:

| Path | Handler |
|---|---|
| `GET /v2/events` | the frozen stream path, unchanged |
| `GET /v2/` | the built `index.html`, key-injected |
| `GET /v2/assets/*` | built assets, by extension allowlist, no traversal |
| non-`GET` on `/v2/events` | **405, as today** (`v2-routes.ts:256-259`) — the existing method check is frozen and keeps its response |
| any other unknown path under `/v2/` | 404, as today |

**The key injection is duplicated on purpose, and the duplication is tested.** `injectWebKey` and `sendKeyInjectedHtml` (`tower-routes.ts:2441`, `:2466`) are module-private, and `tower-routes.ts` imports `v2-routes.ts` at line 51 — so exporting them would either edit a file C1 freezes or create an import cycle. `v2-static.ts` therefore imports `getExpectedKey` from `server-utils.ts` (already exported, zero edits) and reimplements the injection.

Three properties are load-bearing and each gets a test, because a copied security rule drifts:

1. The key is embedded via `JSON.stringify` and **only** when it matches `/^[0-9a-f]{64}$/`. A malformed key yields no injection and the client fails closed with 401. This is stored-XSS prevention, not defensiveness.
2. `Access-Control-Allow-Origin` and `Vary` are **removed** from the HTML response. The body carries the key; the shell is only ever loaded same-origin. Leaving the header on makes the key readable by a cross-origin `fetch` (GHSA-xvjp-7748-v88v).
3. The injection lands before `</head>`, ahead of the deferred module, so `window.__CODEV_TOWER_KEY__` is set before the app's first request.

**Only `v2-static.ts` carries the cross-reference**, naming `injectWebKey` and the three properties it mirrors. `tower-routes.ts` is byte-frozen by C1 and cannot be given a comment pointing back — rev. 4 asked for a mutual reference that the constraints forbid.

### D7 — Scope is required, fetched exactly once, and **not** through `listWorkspaces()`

`GET /v2/events` without `scope` is a 400 (`v2-routes.ts:260-264`). Rev. 1 never said where the client gets scope paths.

One **successful** `GET /api/workspaces` at startup, with the key header, **as a raw `fetch` in `apps/v2` that branches on HTTP status**. A failed bootstrap retries on D2's backoff; a succeeded one is never repeated, reconnects included. "Exactly once" means once successfully, not one attempt — rev. 4's criterion said the latter and contradicted this paragraph. Its workspace paths become the `scope`. It is not polled and is not repeated on reconnect — reconnect reuses the scope it already has, because re-deriving scope on every reconnect is polling wearing a different hat (C4).

**Rev. 2 said to use the SDK's `listWorkspaces()`. That was wrong and it broke D5.** The method returns `[]` when `result.ok` is false (`tower-client.ts:400-403`), so 401, 403, 500 and a dead socket all arrive as an empty list. D5 requires unreachable and empty to be distinguishable; through that method they are the same value. This is the general rule, not a local quirk: **"I could not tell" must never be spelled the same way as "no."** C3 forbids changing the SDK, so the client does its own fetch — the same reason it writes its own stream reader.

Three outcomes, three renderings:

| Bootstrap result | Scope | Render |
|---|---|---|
| 200, one or more workspaces | those paths | open the stream |
| 200, zero workspaces | none | the empty site (D5). **Do not open the stream** — an empty `scope` takes a 400 and would read as a connection failure |
| non-200, or the fetch throws | unknown | the unreachable state (D5), and retry with D2's backoff |
| **200 with a body that is not what it claims** — invalid JSON, no `workspaces` field, `workspaces` not an array, **or any entry without a non-empty string `path`** | unknown | the unreachable state **and** a contract mismatch, then retry. **Never the empty state.** A 200 whose body cannot be read is still "I could not tell", and the status code is not permission to guess |

**Validate every entry, not just the array.** The endpoint returns objects — measured shape: `{path, name, active, proxyUrl, terminals}` — and only `path` is used here. `{"workspaces": [{}]}` or a non-string `path` would otherwise become a scope path of `undefined`, which the server answers with a `dark` frame and `reason: "unknown"`. That renders as a plausible unreachable workspace, so a client bug arrives disguised as a server fact. An entry that fails is a contract mismatch for the whole bootstrap, not a workspace to skip: a partial scope silently drops machines the person expects to see.

### D9 — `/v2/` and its assets must be public routes

`isRequestAllowed` runs before dispatch and `isPublicRoute` (`server-utils.ts:142`) does not list `/v2/`. A browser navigating to `/v2/` sends no `codev-tower-key` header, and neither do the `<script>` and `<link>` tags the shell emits. Under rev. 2 the page 401s before `v2-static.ts` is ever reached, and D6's key injection can never run.

**The precedent is already in that function and it is the same shape.** The annotator's HTML shell and its `vendor/` libraries are public "because iframe navigation and `<script>`/`<link>` tags that cannot carry the key header" load them, while every data sub-route stays keyed (`server-utils.ts:156-165`). `/v2/` is that case exactly.

The change is two clauses:

- `GET /v2/` → public. Carries no secret until injection, and injection only ever happens on a same-origin navigation.
- `GET /v2/assets/*` → public. Built JS and CSS, extension-allowlisted, no traversal.

**`/v2/events` stays keyed.** It carries live state and the shell fetches it with the key. Every other path under `/v2/` stays keyed too.

The Host guard, origin checks and the rest of `isRequestAllowed` are untouched — this widens `isPublicRoute` only, and only for two `GET` shapes.

### D10 — There is no machine on the wire; the machine is the page

`V2NodeKind` is `workspace | architect | builder`. **No machine node is ever emitted.** FR-1 names four levels and the stream carries three.

This unit renders **one** machine — the local one — as the page's own frame: **`window.location.hostname`** in the header, and every workspace plot inside it.

The name has to come from somewhere and neither the stream nor `/api/workspaces` carries it. `window.location.hostname` is the right source precisely because it is what the person typed to get here: on the LAN it is the machine they reached, and there is no second machine to confuse it with until FR-16 lands. No new endpoint, no fixed string that would go stale the first time the page is opened from another device. It is not a node, it is not selectable, and nothing in the reducer represents it. Multi-machine is FR-16 and a later unit; when it lands, the machine level becomes real and this presentation is what it grows out of.

Criterion 1 was written as "renders every machine … the stream reports." The stream reports none. Corrected below.

### D11 — `counts` is machine-wide, and it is not the scope's rollup

**Measured against the live stream**: a scope naming one workspace returned 16 nodes (1 workspace, 2 architects, 13 builders) alongside `counts` of `{workspaces: 22, builders: {total: 58, …}}`.

So `counts` describes the whole machine while `nodes` describes the requested scope. They differ by 45 builders in the observed case. **A client that renders `counts` as the header for the tree it just drew is wrong, and wrong in a way that looks authoritative.**

It renders in the footer, labelled as the machine's totals, visually separate from the tree. `gateWaiting` is the one field that is directly useful — it is the count behind FR-43's queue chip — and it too is machine-wide.

This is an observation about the shipped contract, not a request to change it. C2 stands.

### D12 — Encode each scope path; join with a literal comma

`parseScope` (`v2-routes.ts:80-99`) splits the **raw** query value on `,` and only then percent-decodes each part. So the encoding is:

```
scope=<encodeURIComponent(path1)>,<encodeURIComponent(path2)>
```

**`encodeURIComponent(paths.join(','))` is wrong and it fails silently.** Measured: it encodes the separators to `%2C`, the split finds one part, and the server resolves a single nonsense path. The answer is `nodes: []` plus a `dark` frame with `reason: "unknown"` — HTTP 200, no error, and a rendering that looks like a plausible empty machine. This is the exact failure D5 exists to prevent, arriving from the client's own encoding.

Scenario 18 asserts the encoding directly rather than trusting a round-trip that "looks right."

### D13 — FR-3 cannot be satisfied here, and the client renders the flat truth

FR-3 requires a builder to appear under the architect that spawned it. **The stream cannot express it.**

Measured against the live stream: all 13 builders in a real workspace returned `parentId: "workspace:<path>"`. Zero had an architect parent. The cause is upstream of the stream — `discoverBuilders` hardcodes `spawnedByArchitect: null` (`overview.ts:602, 662, 697`), so the projection has nothing to attach a builder to.

Two things follow, and both are required:

1. **The client renders what the wire says**: builders sit under the workspace, beside the architect header, not under it. **It does not invent a parent** by name-matching a builder to an architect. A guessed hierarchy that is right most of the time is worse than a flat one that is honest.
2. **This is reported as a finding, per C2 and goal 5.** Filed as **#97** against `discoverBuilders`, not patched from this unit. FR-3 stays a MUST in the FRD; it is simply unmet until the server can carry it.

### D14 — `/v2/` must survive `npm pack`, not just `pnpm dev`

`packages/codev/package.json` publishes `dashboard-dist` (`files`, line 19), built by `copy-dashboard` from `apps/web/dist` (line 27). **There is no equivalent for `apps/v2`.** Without one, `/v2/` works in this repo and 404s from the installed CLI, which is the only place adopters have.

Required: a `copy-v2` script into its own published directory, that directory added to `files`, `v2-static.ts` resolving from it, and **an `npm pack` check that the built assets are in the tarball**. In-repo passing is not evidence.

### D8 — What of the design ships here

`01-site.html` is the reference and it contains more than this unit builds. The cut is named so it is not argued later.

**In:** the machine lot, the workspace plot, the architect header, the builder row, the four status stamps, the activity sparkline, the `heldMail` mark, `.grid-bg`, `.dim-sub`, `.needs-attn`.

**Out, and left out of the markup entirely rather than stubbed:** the gate rail, Find node, Add machine, the terminal bank, the command palette. A disabled stub of a later unit is a promise the tree cannot keep.

## Success Criteria

### Functional

1. `/v2/` loads and renders every workspace, architect and builder the stream reports, inside the local machine's frame (D10). **The stream reports no machine node; do not wait for one.**
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

11. **No polling.** `grep -r setInterval apps/v2/src` returns **zero** matches. `grep -r setTimeout` returns exactly one, at the named reconnect-backoff call site. **`/api/workspaces` succeeds at most once per page load**: after a 200 it is never requested again, including across every reconnect; after a failure it retries on D2's backoff until it succeeds. Provable in the devtools network panel.
12. Cold load under 2s to interactive on LAN (Part 5).
13. Idle network under 1 KB/s with nothing happening (Part 5), measured in devtools.
14. `GET /v2/` serves the app with `window.__CODEV_TOWER_KEY__` set, and the response carries **no** `Access-Control-Allow-Origin`.
15. **A browser navigating to `/v2/` with no header gets the page, not a 401.** `GET /v2/events` with no header still gets a 401.
16. A failing bootstrap and a zero-workspace bootstrap produce different renderings — asserted against a 401, a 500, a thrown fetch, and a 200 with `[]`.
17. `counts` renders in the footer as the machine's totals and is never presented as the drawn tree's rollup (D11).
18. A builder appears under its workspace, beside the architect header — the flat truth the wire carries (D13). No architect parent is inferred.
19. **`npm pack` on `packages/codev` contains the built `apps/v2` assets** (D14). Passing in-repo is not evidence.

### Non-regression

20. `apps/web`, `tower.html`, `apps/vscode`, `apps/streamdeck`, `tower-server.ts`, `pty-session.ts` and **`tower-routes.ts`** are byte-unchanged. `git diff --stat` proves it.
21. The only **production-code** changes outside `apps/v2/` are: the new `v2-static.ts`, the dispatch prologue in `v2-routes.ts`, the two `GET /v2/` clauses in `isPublicRoute`, and the packaging wiring of D14. Also permitted, because the spec demands them: **new test files** for static serving, the public-route split and packaging; and **`pnpm-workspace.yaml` plus `pnpm-lock.yaml`**, which a new workspace necessarily touches. The frozen files in C2 are byte-unchanged.
22. Existing test suites pass untouched, including spec 52's 57 v2 tests and the existing `isPublicRoute` cases.

## Solution Approaches

**A. Chosen — React 19 + Vite in a new `apps/v2` workspace, one reducer over the frame stream.** Matches the house stack, and the reducer makes every frame type's handling explicit and testable without a browser. **It imports no SDK behaviour** — C3 and D7 explain why; rev. 5 said "reuses `packages/sdk`" and that was left over from rev. 1.

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
9. **No polling.** Static check: **zero** `setInterval` in `apps/v2/src`, and exactly one `setTimeout`, at the named reconnect-backoff call site.
10. **Live browser, the full set.** Playwright at 1440. One scenario per browser-facing criterion, because the reducer tests prove the state transition and not the rendering:
    - load and render the real hierarchy (criterion 1)
    - spawn a builder, its row appears with no reload (criterion 2)
    - a gate-waiting builder renders rust with a `GATE` stamp, and rust appears **nowhere else on the page** (criterion 3, D3)
    - a builder past `IDLE_WAITING_THRESHOLD_MS` renders ochre and `STALLED` (criterion 4)
    - a sparkline advances on `tick` and flattens to zero for a silent builder (criterion 5)
    - `afx cleanup` removes the row (criterion 6)
    - kill the socket and restore it: state recovers with **no page reload**, both on an honoured resume and on a refused one (criterion 7)
    - a `dark` workspace renders dark while its siblings keep streaming (criterion 8)
    - unreachable Tower and zero workspaces render **differently** (criterion 9)
    - two tabs on one scope converge (criterion 10)
    - `counts` sits in the footer and is not presented as the tree's rollup (criterion 17)
    - a builder sits under its workspace beside the architect header (criterion 18)
    - cold load under 2s and idle under 1 KB/s, measured in the browser rather than asserted (criteria 12, 13)
11. **Non-regression.** `git diff --stat` on the frozen C1 files, including `tower-routes.ts`, is empty.
12. **Key injection, three properties.** Malformed key yields no injection; the HTML response has no `Access-Control-Allow-Origin` or `Vary`; the script precedes `</head>`.
13. **Scope bootstrap.** `/api/workspaces` is requested once; a reconnect reuses the cached scope and does not re-request it.
14. **Zero workspaces.** The bootstrap fetch returns 200 with an empty workspace list; assert the stream is never opened and the empty site renders. **Not via `listWorkspaces()`** — see C3 and D7.
15. **Static serving.** `GET /v2/assets/../../etc/passwd` is refused; a non-allowlisted extension is refused; `GET /v2/nonsense` is 404.
16. **Public vs keyed.** No-header `GET /v2/` → 200; no-header `GET /v2/assets/index.js` → 200; no-header `GET /v2/events?scope=…` → 401; no-header `POST /v2/` → not public.
17. **Bootstrap failure is not emptiness.** Four cases — 401, 500, thrown fetch, and 200 with `[]` — produce the unreachable state for the first three and the empty state for the fourth.
18. **Scope encoding.** Two paths in, assert the query string is `scope=<enc1>,<enc2>` with a **literal** comma. Assert that `encodeURIComponent(join(','))` is not what is produced. Round-trip both through `parseScope`'s own splitting rule.
19. **Cursor advances on deltas.** Feed a snapshot then 5 `node` frames; assert a reconnect uses the last delta's `seq`, not the snapshot's.
20. **Degenerate frames.** Invalid JSON, an unknown `type`, a clean EOF, and a non-2xx — each produces D1's stated answer, and none advances the cursor except where stated.
21. **Dark has no node.** A snapshot with `nodes: []` plus a `dark` frame renders one dark plot built from the id. A later snapshot without that dark frame clears it.
22. **A dark workspace clears only on a snapshot.** Assert a `dark` plot survives every delta frame and is cleared by a replacement `snapshot` that omits it. Assert **no** polling is introduced to chase recovery (#98).
23. **`buckets` two shapes.** A node with `buckets: number[]` and a tick with `buckets: {}` in the same session; assert neither path throws and the trace advances by one zero.
24. **Counts from the snapshot alone.** Feed a snapshot and no `counts` delta; assert the footer shows the snapshot's totals.
25. **Bootstrap retries, then stops.** A 500 then a 200: assert two requests total, and that a later reconnect makes none.
26. **A 200 that lies.** Four bodies — invalid JSON, `{}`, `{"workspaces": null}`, `{"workspaces": "nope"}` — each produces the unreachable state and a retry, and **none** produces the empty state.
27. **Transport framing.** The reader is hand-written, so the reducer tests prove nothing about it. Feed a scripted `ReadableStream` and assert identical results for: one frame split across 3 chunks; **a chunk that splits a multi-byte UTF-8 character** (`TextDecoder` must be constructed with `{stream: true}` semantics and reused, not per-chunk); 4 frames arriving in one chunk; a chunk ending mid-frame with the remainder arriving later; `\r\n` as well as `\n` line endings; a trailing partial frame at EOF, which must **not** be applied. A reader that passes every reducer test and fails this is the expected failure mode, not an unlikely one.
28. **Bad frame is terminal and bounded.** A malformed frame mid-stream: assert frames stop applying, exactly **one** reconnect happens and it carries **no** `since`/`stream`, and a second bad frame produces **no third connection**.
29. **The mismatch state claims only what it decoded.** Three cases: invalid JSON reports `invalid JSON after cursor <N>` and a byte preview and **does not** invent a `seq` or `type`; an unknown `type` reports the type; a known type with a bad field reports type, `seq` and the failing field.
30. **Field validation, per frame type.** One case each: `seq` not a number; `node` with no `id`; `node` with `kind: "machine"`; `snapshot` with `nodes` not an array; `snapshot` with no `counts`; `tick` with `buckets` as an array; `tick` with a non-numeric value; `dark` with an `id` that is not `workspace:<path>`. Every one terminal.
31. **Unknown status is not a validation failure.** A structurally valid node with `status: "reticulating"` renders visibly wrong, does **not** default to `running`, and does **not** enter the mismatch state. This is the one place a surprising value keeps the page running (D3).
32. **Bootstrap entry validation.** `{"workspaces": [{}]}`, `{"workspaces": [{"path": 42}]}` and `{"workspaces": [{"path": ""}]}` each produce a contract mismatch for the whole bootstrap — not a partial scope, and not a dark workspace.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---:|---|---|
| The wire contract fails a real renderer | ~~Medium~~ **Confirmed** — 5 findings on first consumption | High | Each is now a locked decision (D10–D13). C2 forbids patching the server from here |
| Scope encoded as `encodeURIComponent(join(','))` | High — it is the idiomatic line to write | High — HTTP 200 with an empty tree and a dark frame, no error anywhere | D12 with the measurement; scenario 18 |
| A builder given an inferred architect parent to satisfy FR-3 | Medium — the names often match | High — a guessed hierarchy that is usually right is worse than a flat honest one | D13 |
| `counts` rendered as the drawn tree's rollup | High — the fields invite it | Medium — authoritative-looking numbers off by 45 | D11; criterion 17 |
| Cursor advanced only on snapshots | Medium | Medium — a reconnect replays every delta since the snapshot | D1; scenario 19 |
| A bad frame dropped and the next one applied | High — it is the forgiving thing to do | High — a corrupt tree that looks right, and a resume that replays the bad frame forever | D1's terminal rule; scenario 28 |
| The SSE reader assumes one frame per chunk | High — it works on localhost and fails on a real network | High — dropped or spliced frames with no error | Scenario 27, including a split multi-byte character |
| Wire types mistaken for wire validation | High — the types are right there and TypeScript looks like a guarantee | High — a decoded object with a known `type` and a bad payload reaches the reducer | D1's field list; scenario 30 |
| Unknown `status` treated as a validation failure | Medium — the new terminal rule invites it | Medium — the page dies on a contract drift it was designed to survive | D1's exception; scenario 31 |
| A bad `workspaces` entry skipped instead of refused | Medium — skipping looks resilient | High — a silently partial scope, or a client bug rendered as a server-reported dark machine | D7; scenario 32 |
| The mismatch state invents a `seq` for unparseable JSON | Medium — rev. 7 required it | Low — a fabricated identifier in the one place accuracy matters | D1's table; scenario 29 |
| `buckets` treated as one shape | High — the field name is identical | High — breaks on the first tick, which is also the first thing that arrives after the snapshot | D1 with both line numbers |
| `counts` never initialised because no `counts` delta follows the snapshot | Medium | Medium — the footer stays empty and the contract looks unexercised | D1's snapshot row stores it |
| `/v2/` ships in-repo only and 404s from the installed CLI | High — nothing in the build wires it | High — adopters have only the installed CLI | D14; criterion 19 requires `npm pack` |
| Absent-in-`tick` rendered as unchanged | High — it is the natural reading | High — a stalled builder looks busy, inverting FR-42 | D1 states it; scenario 2 asserts it |
| A charting library added for 20 bars | Medium — `recharts` is already in the monorepo | Medium — bundle and a dependency for a flexbox job | Assumption 4; `.spark` already exists in `tokens.css` |
| Rust used for something other than gates | High without a rule | High — the colour discipline is the design | D3 states it; review the diff for `--rust` uses |
| A second `/v2/` mount added | Medium | High — defeats the one-insertion-point seam | Criterion 14 makes it falsifiable |
| Reconnect implemented as page reload | Medium — it is the easy path | High — discards the reason for the stream | D2 states it; criterion 7 and scenarios 4 and 5 |
| Polling creeps in for something the stream lacks | Medium | High — reproduces the problem v2 exists to solve | C4 and criterion 11; if the stream lacks it, that is a finding |
| Scope re-derived on every reconnect | Medium — it looks like correctness | Medium — polling by another name | D7; scenario 13 |
| The copied key injection drifts from `injectWebKey` | Medium — two copies of a security rule | High — stored XSS, or a key readable cross-origin | D6's three tested properties; `v2-static.ts` carries the cross-reference (`tower-routes.ts` is frozen) |
| Unreachable Tower renders as an empty tree | High — it is the default behaviour of a failed fetch | High — inverts what FR-15 will require | D5's three-state table; scenario 7 |
| FR-15 marked satisfied because dark workspaces work | Medium — the behaviours look alike | Medium — a MUST recorded as met when no sibling environment exists to degrade | D5 states the deferral; goal 4 |
| `subscribeEvents` reused for the v2 stream | Medium — it is right there in the SDK | High — silently mis-parses every frame, wrong endpoint and wrong envelope | C3 names it |
| `listWorkspaces()` used for the bootstrap | High — it is the obvious SDK call and rev. 2 asked for it | High — collapses 401, 500 and a dead socket into `[]`, so unreachable renders as empty | D7 states it with the line number; scenario 17 |
| `isPublicRoute` widened further than two `GET` shapes | Medium | High — `/v2/events` or a future `/v2/` write path becomes unauthenticated | D9 and criterion 15; scenario 16 asserts `/v2/events` still 401s |
| A malformed 200 from `/api/workspaces` read as an empty machine | Medium — the status code says success | High — the same failure D7 exists to prevent, one layer in | D7's fourth row; scenario 26 |
| Dark staleness worked around with a refresh timer | Medium — #98 makes it tempting | High — reintroduces polling to paper over a server gap | D5 forbids it; scenario 22 asserts no polling |
| Later-unit chrome stubbed into the site view | Medium | Medium — a disabled control reads as broken | D8 |

## References

- FRD rev. 9: `codev/research/codev-v2-ui-frd.md` — Part 0, FR-1, FR-3, FR-4, FR-15, FR-41, FR-42, FR-49, Part 5
- Wire contract: `codev/specs/52-v2-server-events.md`
- Server: `packages/codev/src/agent-farm/servers/v2-{routes,events,sampler,projection,status,ids}.ts`
- Wire types: `packages/types/src/v2-events.ts`
- Auth precedent: `apps/web/src/hooks/useSSE.ts:8-12`
- Design: `codev/research/v2-mockups/01-site.html`, `tokens.css`, `tokens-dark.css`
- Design of record: `codev/research/v2-mockups/uxpilot/MANIFEST.md`
