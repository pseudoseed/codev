# Specification: v2 client shell — apps/v2 renders the live hierarchy

- **Issue:** #83
- **Program:** Codev v2 UI (#37)
- **Protocol:** SPIR
- **Status:** Draft, rev. 1
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
| Mount | one `/v2/` prefix branch in `tower-routes.ts` | shipped; **reuse it, do not add a second** |
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

**C1 — Additive only.** New files under `apps/v2/` and a workspace entry. Zero edits to `apps/web`, `packages/codev/templates/tower.html`, `apps/vscode`, `apps/streamdeck`, `tower-server.ts`, `pty-session.ts`. The `/v2/` mount already exists; adding a second insertion point defeats the seam.

**C2 — Do not modify the server or the contract.** `v2-sampler.ts`, `v2-events.ts`, `v2-routes.ts` and `packages/types/src/v2-events.ts` are fixed. If the contract cannot be rendered, that is a finding to report.

**C3 — `packages/sdk` unmodified.** It is the client runtime and it is untouched by the fork. Import it; do not extend it here.

**C4 — No polling.** No `setInterval`, no `setTimeout`-driven refetch, no re-fetch on focus. The only timer permitted is reconnect backoff.

**C5 — FR-49 from the first line.** A pane is a viewer. Nothing in the client may terminate a session. This unit has no panes; the rule is established before anything can violate it.

## Assumptions

1. `fetch` + `ReadableStream` carries the `codev-tower-key` header where `EventSource` cannot. **Verified**: `useSSE.ts:8-12` documents exactly this and cites GHSA-xvjp-7748-v88v.
2. React 19 + Vite + Vitest is the house stack. **Verified** against `apps/web/package.json`. Reuse it; this is not the place to introduce a framework.
3. The `/v2/` prefix authenticates like every other route, since `isRequestAllowed` runs before dispatch and `/v2/` is not in `isPublicRoute`. **Verified** during spec 52.
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
| `dark` | Mark the named scope path dark. Render the machine as dark; keep everything else. |

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

### D5 — Dark is a subtree state, never an empty tree

FR-15. A `dark` frame names one scope path. That machine renders dark and labelled; every other machine keeps streaming. An empty hierarchy and an unreachable machine must not look alike.

## Success Criteria

### Functional

1. `/v2/` loads and renders every machine, workspace, architect and builder the stream reports.
2. Spawning a builder makes its row appear **with no reload and no client timer**.
3. A builder entering a gate renders rust with a `GATE` stamp.
4. A builder silent past `IDLE_WAITING_THRESHOLD_MS` renders ochre and `STALLED`.
5. Every builder row shows a sparkline that advances on `tick`, and flattens to zero for a silent builder rather than freezing.
6. `afx cleanup` on a builder removes its row.
7. Killing the connection and restoring it recovers state via resume or a flagged snapshot, **without a page reload**.
8. A `dark` frame renders that machine as dark and leaves the others live.
9. Two browser tabs on the same scope show identical trees.

### Non-functional

10. **No polling.** `grep` for `setInterval` in `apps/v2/src` returns only reconnect backoff, and that is named as such.
11. Cold load under 2s to interactive on LAN (Part 5).
12. Idle network under 1 KB/s with nothing happening (Part 5), measured in devtools.

### Non-regression

13. `apps/web`, `tower.html`, `apps/vscode`, `apps/streamdeck` are byte-unchanged. `git diff --stat` proves it.
14. `tower-routes.ts` is byte-unchanged: the `/v2/` mount already exists and is reused.
15. Existing test suites pass untouched.

## Solution Approaches

**A. Chosen — React 19 + Vite in a new `apps/v2` workspace, one reducer over the frame stream.** Matches the house stack, reuses `packages/sdk`, and the reducer makes every frame type's handling explicit and testable without a browser.

**B. Vanilla TS, no framework.** Rejected. `tower.html` is the cautionary example: 1,894 lines of hand-rolled HTML with an inline script is one of the three structural causes the FRD names for the current UI being replaced.

**C. Extend `apps/web` with a v2 route.** Rejected under C1. It is a hot upstream file set and the fork has barely touched it; that is the merge cost Part 0 exists to avoid.

**D. Server-rendered.** Rejected. The stream is a live push contract; server rendering re-introduces a request cycle for state that arrives on its own.

## Open Questions

1. Does `apps/v2` get its own dev server port, or proxy through Tower? Recommend proxying so `/v2/events` needs no CORS handling in dev, which would otherwise be dev-only code with no production counterpart.
2. Light or dark by default before theme switching exists? Recommend light, because `tokens.css` is the reviewed palette and `tokens-dark.css` has been read by nobody on real markup yet.

## Test Scenarios

1. **Reducer: every frame type.** Unit-test each row of D1's table against fixtures. No browser.
2. **`tick` absence means zero.** Feed a `tick` omitting a builder; assert its trace appends 0, not a repeat of its last value.
3. **`node` upsert does not touch buckets.** Feed a `node` frame; assert the trace is unchanged.
4. **Resume honoured.** `resumed` + deltas; assert no map replacement.
5. **Resume refused.** `snapshot` with `resumed: false`; assert wholesale replacement.
6. **Unknown status.** Feed a status outside the four; assert it renders visibly wrong and does not fall back to `running`.
7. **Dark vs empty.** `dark` for one machine; assert that machine is dark and the others still render.
8. **Two-client convergence.** Drive 50 frames into two reducer instances; assert identical final state.
9. **No polling.** Static check: `setInterval` in `apps/v2/src` appears only in reconnect backoff.
10. **Live browser.** Playwright at 1440: load, spawn a builder, assert its row appears without reload.
11. **Non-regression.** `git diff --stat` on the four other clients and `tower-routes.ts` is empty.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---:|---|---|
| The wire contract fails a real renderer | Medium — it has never been consumed | High — blocks the client | Report it; C2 forbids patching the server from here |
| Absent-in-`tick` rendered as unchanged | High — it is the natural reading | High — a stalled builder looks busy, inverting FR-42 | D1 states it; scenario 2 asserts it |
| A charting library added for 20 bars | Medium — `recharts` is already in the monorepo | Medium — bundle and a dependency for a flexbox job | Assumption 4; `.spark` already exists in `tokens.css` |
| Rust used for something other than gates | High without a rule | High — the colour discipline is the design | D3 states it; review the diff for `--rust` uses |
| A second `/v2/` mount added | Medium | High — defeats the one-insertion-point seam | Criterion 14 makes it falsifiable |
| Reconnect implemented as page reload | Medium — it is the easy path | High — discards the reason for the stream | D2 states it; scenario 7 asserts no reload |
| Polling creeps in for something the stream lacks | Medium | High — reproduces the problem v2 exists to solve | C4 and criterion 10; if the stream lacks it, that is a finding |

## References

- FRD rev. 9: `codev/research/codev-v2-ui-frd.md` — Part 0, FR-1, FR-3, FR-4, FR-15, FR-41, FR-42, FR-49, Part 5
- Wire contract: `codev/specs/52-v2-server-events.md`
- Server: `packages/codev/src/agent-farm/servers/v2-{routes,events,sampler,projection,status,ids}.ts`
- Wire types: `packages/types/src/v2-events.ts`
- Auth precedent: `apps/web/src/hooks/useSSE.ts:8-12`
- Design: `codev/research/v2-mockups/01-site.html`, `tokens.css`, `tokens-dark.css`
- Design of record: `codev/research/v2-mockups/uxpilot/MANIFEST.md`
