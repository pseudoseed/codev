# Plan: v2 client shell — apps/v2 renders the live hierarchy

**Specification**: [codev/specs/83-v2-client-shell.md](../specs/83-v2-client-shell.md)

## Executive Summary

Approach A from the spec: React 19 + Vite in a new fork-owned `apps/v2` workspace, one reducer over the frame stream. The client imports **types** from `@cluesmith/codev-types` and **no SDK behaviour** (C3, D7). It writes its own bootstrap `fetch`, its own SSE reader, and its own reconnect.

Serving reuses the existing `/v2/` prefix branch in `tower-routes.ts` (byte-frozen). A new `v2-static.ts` plus a one-branch change to the `handleV2Route` prologue is the only server seam. `isPublicRoute` gains the two GET clauses in D9. Packaging follows the `dashboard-dist` precedent as `v2-dist` (D14).

The site view is containment from `01-site.html` plus `tokens.css` as shipped. No Tailwind, no Font Awesome, no `recharts`. D8 chrome (gate rail, Find node, Add machine, terminal bank, palette) is omitted entirely, not stubbed. FR-3 is rendered as the flat truth the wire carries (D13, #97). FR-15 is deferred (D5).

## Grounded seams (verified)

| Need | Use | Do not use |
|---|---|---|
| Stream | `GET /v2/events` via `fetch` + `ReadableStream` + `codev-tower-key` | `EventSource`; `subscribeEvents` / `parseSseText` (wrong endpoint, `{type,body}` envelope) |
| Scope paths | One raw `GET /api/workspaces`, branch on HTTP status, validate every `path` | `listWorkspaces()` (`tower-client.ts:400-403` collapses 401/500/dead into `[]`) |
| Scope query | `scope=<enc(path1)>,<enc(path2)>` with a **literal** comma (D12) | `encodeURIComponent(paths.join(','))` |
| Key | `window.__CODEV_TOWER_KEY__` injected by `v2-static.ts` | Exporting `injectWebKey` (module-private; `tower-routes.ts` is frozen) |
| Public shell | `isPublicRoute`: `GET /v2/` and `GET /v2/assets/*` | Widening `/v2/events` or any non-GET |
| Tokens | Copy `codev/research/v2-mockups/tokens.css` into `apps/v2/src/tokens.css` | Tailwind CDN from the mockup; `tokens-dark.css` is copied and unused |
| Sparkline | `.spark` + 20 `<i>` bars | `recharts` |
| Machine name | `window.location.hostname` (D10) | A machine node; a new endpoint |
| Builder parent | `parentId` as the wire sent it | Name-matching a builder to an architect (D13) |
| Stall | Render `status: "stalled"` from the stream | Client-side `IDLE_WAITING_THRESHOLD_MS` |
| `gone` in Playwright | Fixture `gone` frame | `afx cleanup` (irreversible; human-only) |

`parseScope` (`v2-routes.ts:80-99`) is below the prologue and frozen. Do not export it. Scenario 18 asserts the query-string shape in the client, then round-trips through `handleV2Route` (which already calls `parseScope`) with two known workspace paths.

## File layout

```
apps/v2/
  package.json                         @cluesmith/codev-v2
  index.html                           base /v2/; no key placeholder
  vite.config.ts                       base: '/v2/'; proxy /api and /v2/events → :4100
  vitest.config.ts                     jsdom
  tsconfig.json                        house stack, noEmit
  playwright.config.ts                 viewport 1440, fixture server
  src/
    main.tsx
    App.tsx                            page states: loading / unreachable / mismatch / empty / live
    tokens.css                         vendored copy of the shipped file
    tokens-dark.css                    vendored, not applied
    site.css                           containment layout; no Tailwind
    vite-env.d.ts
    lib/
      key.ts                           read window.__CODEV_TOWER_KEY__
      encode-scope.ts                  D12
      validate.ts                      D1 read-set; seq rules
      reducer.ts                       D1 table; two stores + counts
      sse-reader.ts                    TextDecoder {stream:true}; scenario 27
      bootstrap.ts                     D7
      stream.ts                        D1 classification + D2 reconnect
      tree.ts                          group by parentId; invent nothing
    components/
      SiteView.tsx                     one machine lot
      WorkspacePlot.tsx                live plot or dark-from-id
      ArchitectHeader.tsx
      BuilderRow.tsx
      Sparkline.tsx                    20 <i> bars
      StatusStamp.tsx                  D3; unknown status visibly wrong
      MachineFooter.tsx                counts, labelled machine-wide
      ConnectionBanner.tsx             unreachable / mismatch / reconnecting; never rust
  __tests__/                           unit + component tests (scenarios below)
  e2e/                                 Playwright, fixture HTTP server

packages/codev/src/agent-farm/servers/v2-static.ts
packages/codev/src/agent-farm/__tests__/v2-static.test.ts
packages/codev/src/agent-farm/__tests__/v2-public-route.test.ts
packages/codev/src/agent-farm/__tests__/v2-packaging.test.ts
packages/codev/src/agent-farm/__tests__/v2-scope-encoding.test.ts   # scenario 18 round-trip
```

## Shared implementation rules (every phase)

**Reducer is the whole state model.** `nodes: Map<id, Node>`, `darkPaths: Map<workspaceId, {reason, at}>`, `counts`, `cursor: {streamId, seq}`, `page: 'live' | 'empty' | 'unreachable' | 'mismatch'`. No parallel store. Every accepted frame advances `cursor.seq` to that frame's `seq`. A `snapshot` with a new `streamId` resets the baseline and **replaces `darkPaths` wholesale** before applying that snapshot's own `dark` frames.

**Validate before reduce.** The read-set in D1 is the closed list. Extra fields are ignored (scenario 35). `status` value is not validated (scenario 31). `seq` is a finite non-negative safe integer. Ordering is non-decreasing **within** a `streamId`; across `streamId`s there is no comparison.

**New builder, no buckets.** On `node` upsert: known id → leave trace; new `kind === 'builder'` → 20 zeros. `tick` is the only later writer. Absent id in `tick.buckets` appends 0.

**Timers.** Zero `setInterval` under `apps/v2/src`. Exactly one `setTimeout`, at a call site named `reconnectBackoff`. Start 1s, cap 15s, reset on a successful frame. No refetch on focus or visibility.

**Retry policy.**

| Cause | State | Retry |
|---|---|---|
| Stream 400 / 404 / 405 | mismatch | none |
| Stream 401 / 403 | unreachable, labelled auth | none |
| Stream 5xx or thrown fetch | unreachable | backoff, indefinitely |
| Bad frame | mismatch | one fresh snapshot (no `since`/`stream`); second bad frame stops |
| Valid fresh snapshot after mismatch | live | budget resets |
| Bootstrap non-200 or thrown | unreachable | backoff, indefinitely, until one 200 |
| Bootstrap 200 unreadable or bad entry | mismatch | one retry, then stop |
| Bootstrap 200 with `[]` | empty | do not open the stream |

**FR-49.** No client code may terminate a session. Grep `apps/v2/src` for `cleanup`, `destroy`, `kill`, `DELETE`. None.

**Colour.** `--rust` only on `gate-waiting` stamps and `.needs-attn` on those rows. Reconnecting, mismatch, dark, heldMail, footer `gateWaiting` are not rust.

**Frozen files stay frozen.** `git diff --stat` empty on every C1/C2 path, including `tower-routes.ts`. The only production edits outside `apps/v2/` are `v2-static.ts` (new), the `handleV2Route` prologue, the two `isPublicRoute` clauses, and D14 packaging.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Workspace and /v2/ static serving"},
    {"id": "phase_2", "title": "Frame validation and reducer"},
    {"id": "phase_3", "title": "Bootstrap, stream reader, reconnect"},
    {"id": "phase_4", "title": "Site view"},
    {"id": "phase_5", "title": "Playwright fixture proof"}
  ]
}
```

## Phase Breakdown

### Phase 1: Workspace and /v2/ static serving

**Dependencies**: None

#### Objective

`apps/v2` exists, builds, and is served at `GET /v2/` with the key injected. `npm pack` contains `v2-dist`. A browser with no header gets the page; `/v2/events` still 401s.

#### Files to Create / Modify

- `apps/v2/package.json` — `@cluesmith/codev-v2`, private, React 19 / Vite 6 / Vitest 4 / testing-library / jsdom. Dep: `@cluesmith/codev-types`. **No** `@cluesmith/codev-sdk`. No `recharts`.
- `apps/v2/index.html`, `src/main.tsx`, `src/App.tsx` — shell that renders a single heading so serving is observable. Replaced in phase 4.
- `apps/v2/vite.config.ts` — `base: '/v2/'`; `server.proxy` `/api` and `/v2/events` to `http://localhost:4100`.
- `apps/v2/vitest.config.ts`, `tsconfig.json`, `src/vite-env.d.ts`
- `apps/v2/src/tokens.css`, `apps/v2/src/tokens-dark.css` — byte copies of the research files
- `packages/codev/src/agent-farm/servers/v2-static.ts` — see rules below
- `packages/codev/src/agent-farm/servers/v2-routes.ts` — **prologue only**:
  ```
  if (url.pathname !== V2_EVENTS_PATH) {
    serveV2Static(req, res, url);
    return;
  }
  ```
  Everything from the existing `req.method !== 'GET'` check downward is untouched.
- `packages/codev/src/agent-farm/utils/server-utils.ts` — in `isPublicRoute`, after the `/` / `/index.html` clauses:
  - `GET` + (`pathname === '/v2/'` or `pathname === '/v2'`) → true
  - `GET` + `pathname.startsWith('/v2/assets/')` → true
  - nothing else under `/v2/`
- `packages/codev/package.json` — `files` += `v2-dist`; `copy-v2` script builds `@cluesmith/codev-v2` then `rm -rf v2-dist && cp -r ../../apps/v2/dist v2-dist`; `bundle-assets` runs `copy-v2`; `devDependencies` += `@cluesmith/codev-v2`; `test` becomes `vitest && pnpm --filter @cluesmith/codev-v2 test` so porch's root `npm test` covers the client.
- `pnpm-lock.yaml` (workspace already lists `apps/*`; lockfile is the expected touch)
- Tests listed below

`v2-static.ts` rules:

1. Resolve the asset root from `path.resolve(__dirname, '../../../v2-dist')`. Export `setV2DistRoot` for tests (same shape as `setV2RouteDeps`).
2. `GET /v2/` and `GET /v2` → read `index.html`, inject key, strip `Access-Control-Allow-Origin` and `Vary`, `text/html; charset=utf-8`.
3. Injection is a pure `injectV2Key(html, key)` that mirrors `injectWebKey` (`tower-routes.ts:2441`): embed via `JSON.stringify` **only** when the key matches `/^[0-9a-f]{64}$/`; insert before `</head>`; no placeholder required. The file comments the three D6 properties and names `injectWebKey` as the source of record.
4. `GET /v2/assets/*` → extension allowlist `{js,css,map,svg,woff2,png,ico}`; reject `..`, absolute segments, and any resolved path that is not under `<root>/assets/`; 404 otherwise.
5. Any other path, and any non-GET: 404, same body as today (`Not found`).

#### Deliverables

- [ ] `apps/v2` builds (`pnpm --filter @cluesmith/codev-v2 build`)
- [ ] `GET /v2/` serves the shell with `window.__CODEV_TOWER_KEY__` set when the key is well-formed
- [ ] `copy-v2` + `files` put `v2-dist` in `npm pack`
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Scenario 12: malformed key → no injection; HTML has no `Access-Control-Allow-Origin` / `Vary`; script precedes `</head>`
- [ ] Scenario 15: `GET /v2/assets/../../etc/passwd` refused; non-allowlisted extension refused; `GET /v2/nonsense` is 404
- [ ] Scenario 16: no-header `GET /v2/` → public; no-header `GET /v2/assets/<built.js>` → public; no-header `GET /v2/events?scope=…` → not public; no-header `POST /v2/` → not public
- [ ] Scenario 19 (pack): `npm pack --dry-run` in `packages/codev` lists `v2-dist/index.html` and `v2-dist/assets/`
- [ ] Existing `handleV2Route` 404 for `/v2/nope` still passes; spec 52's v2 suite still passes
- [ ] `git diff --stat` empty on every C1/C2 frozen file
- [ ] Build and unit tests pass

#### Test Plan

- `v2-static.test.ts` — injectV2Key table; traversal; extension allowlist; missing dist → 404; method not GET → 404. Drive via `setV2DistRoot` + `handleV2Route` so the prologue is the path under test.
- `v2-public-route.test.ts` — scenario 16 against `isPublicRoute` only (no HTTP). Existing `request-auth.test.ts` cases stay untouched and must still pass.
- `v2-packaging.test.ts` — `npm pack --dry-run`, same shape as `dashboard-terminals.test.ts:162-170`.

### Phase 2: Frame validation and reducer

**Dependencies**: Phase 1

#### Objective

Every frame type has a validator and a reducer transition. Degenerate frames are terminal. Two reducer instances fed the same frames converge. No network, no DOM required for the core table.

#### Files to Create / Modify

- `apps/v2/src/lib/validate.ts` — D1 read-set; returns `{ok, frame}` or `{ok: false, mismatch}` with only decoded facts (scenario 29)
- `apps/v2/src/lib/reducer.ts` — D1 table
- `apps/v2/__tests__/validate.test.ts`
- `apps/v2/__tests__/reducer.test.ts`

Reducer state:

```
{
  nodes: Map<string, Node>,          // Node always has buckets?: number[]
  darkPaths: Map<string, {reason, at}>,
  counts: V2Counts | null,
  cursor: { streamId: string | null, seq: number },
  page: 'live' | 'empty' | 'mismatch',
  mismatch: null | { how, seq?, type?, field?, preview?, afterSeq },
  mismatchAttempts: 0,               // 0 = budget full; 1 = recovery used
}
```

Unreachable is a **connection** state, not a reducer state. It lives in the stream client (phase 3). The reducer never sees a failed fetch.

`applyFrame(state, raw): { state, effect }` where `effect` is `none | recover-fresh | halt`. `recover-fresh` means "one reconnect without since/stream". The stream client owns the attempt counter's side effects; the reducer exposes whether this mismatch is still recoverable.

#### Deliverables

- [ ] D1 table implemented and tested
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Scenario 1: one case per D1 row (`snapshot`, `resumed`, `node`, `gone`, `counts`, `tick`, `dark`)
- [ ] Scenario 2: tick omitting a builder appends 0
- [ ] Scenario 3 / 39: existing builder's trace unchanged on `node`; new builder with absent buckets gets 20 zeros
- [ ] Scenario 4: `resumed` + deltas do not replace the map
- [ ] Scenario 5: `snapshot` + `resumed: false` replaces the map
- [ ] Scenario 6 (state): unknown status is stored as-is, not rewritten to `running`, not mismatch
- [ ] Scenario 8: 50 frames into two reducers → identical serialised state
- [ ] Scenario 19: snapshot then 5 `node` frames → cursor is the last delta's `seq`
- [ ] Scenario 20 (frame half): invalid JSON and unknown `type` are mismatch; cursor does not advance
- [ ] Scenario 21 / 41 / 22: dark-from-id; snapshot replaces darkPaths; deltas do not clear a dark plot
- [ ] Scenario 23: node `buckets: number[]` and tick `buckets: {}` in one session
- [ ] Scenario 24: footer counts come from the snapshot when no `counts` delta follows
- [ ] Scenario 28 / 37: first bad frame → `recover-fresh`; second on the fresh connection → `halt`; a valid snapshot in between resets the budget
- [ ] Scenario 29: mismatch claims only what it decoded
- [ ] Scenario 30: one case per read-set row
- [ ] Scenario 31: `status: "reticulating"` is not terminal
- [ ] Scenario 33: `NaN`, `Infinity`, `1.5`, `-1`, `2**60` each terminal
- [ ] Scenario 34: shared `seq` both applied; lower `seq` same stream terminal
- [ ] Scenario 35: extra unknown field applies
- [ ] Scenario 36: new `streamId` + `seq: 0` after cursor 500 is accepted
- [ ] Build and unit tests pass

#### Test Plan

Table-driven fixtures. No `fetch`, no timers. Serialise Maps to sorted arrays for convergence.

### Phase 3: Bootstrap, stream reader, reconnect

**Dependencies**: Phase 2

#### Objective

The page can obtain scope once, open the stream, survive disconnect by resume, and classify every failure the spec names. Still no designed UI — a thin hook/`connect()` is enough for tests to drive.

#### Files to Create / Modify

- `apps/v2/src/lib/key.ts` — injected key only. No `localStorage` fallback (the v1 dashboard persists; this unit does not need it, and a stored key is a second copy of a secret).
- `apps/v2/src/lib/encode-scope.ts`
- `apps/v2/src/lib/sse-reader.ts` — reuse one `TextDecoder({ stream: true })`; split on `\n` / `\r\n`; accept `data: ` lines; **do not** apply a trailing partial at EOF
- `apps/v2/src/lib/bootstrap.ts` — D7
- `apps/v2/src/lib/stream.ts` — open, classify, D2 reconnect, one named `reconnectBackoff` `setTimeout`
- `apps/v2/__tests__/encode-scope.test.ts`
- `apps/v2/__tests__/sse-reader.test.ts`
- `apps/v2/__tests__/bootstrap.test.ts`
- `apps/v2/__tests__/stream.test.ts`
- `apps/v2/__tests__/no-polling.test.ts`
- `packages/codev/src/agent-farm/__tests__/v2-scope-encoding.test.ts`

`stream.ts` takes injected `fetch`, `setTimeout`/`clearTimeout`, and a `now` if needed. Tests never use real timers except a fake clock.

Backoff lives in `stream.ts` as:

```
function reconnectBackoff(ms: number, cb: () => void): Timer
```

That identifier is what scenario 9 greps for. It is the only `setTimeout` in `apps/v2/src`.

#### Deliverables

- [ ] Bootstrap, reader, and stream client
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Scenario 9: `grep -r setInterval apps/v2/src` → 0; `grep -r setTimeout apps/v2/src` → exactly one file, the `reconnectBackoff` site
- [ ] Scenario 13: `/api/workspaces` once on success; reconnect does not re-request
- [ ] Scenario 14: 200 + `[]` → empty, stream never opened
- [ ] Scenario 17: 401, 500, thrown fetch → unreachable; 200 + `[]` → empty
- [ ] Scenario 18: `encodeScope(['/a,b','/c'])` produces a query with a literal comma between encodings; `encodeURIComponent(join)` is not the output; `handleV2Route` given two known paths in that encoding returns both in the snapshot, not `nodes: []` + one `dark`
- [ ] Scenario 20 (transport half): clean EOF → resume reconnect, not empty, not mismatch; non-2xx classified per D1
- [ ] Scenario 25: 500 then 200 → two bootstrap requests; later reconnect → zero more
- [ ] Scenario 26 / 32: invalid JSON, `{}`, `{"workspaces":null}`, `{"workspaces":"nope"}`, `[{}]`, `{path:42}`, `{path:""}` → mismatch, one retry, stop; never empty, never unreachable
- [ ] Scenario 27: split frame, split UTF-8 code point, 4 frames in one chunk, mid-frame remainder, `\r\n`, trailing partial at EOF not applied
- [ ] Scenario 28 (client): one recover-fresh (no `since`/`stream`); second bad frame opens no third connection
- [ ] Scenario 38: 500 retries on backoff; unreadable 200 retries once
- [ ] Scenario 40: 400 mismatch no retry; 401 auth-unreachable no retry; 404 mismatch no retry; 503 unreachable retries. No-retry cases open exactly one connection
- [ ] Build and unit tests pass

#### Test Plan

Scripted `ReadableStream` and a fake `fetch` that records URLs. Scenario 18's round-trip uses the existing `handleV2Route` test harness (`WS_A`, `WS_B` in `v2-routes.test.ts`) in `v2-scope-encoding.test.ts` so it exercises the frozen `parseScope`.

### Phase 4: Site view

**Dependencies**: Phase 3

#### Objective

`/v2/` draws the approved site view from reducer state. Empty, dark, and unreachable cannot be mistaken for each other. Builders sit under the workspace beside architect headers. Counts sit in the footer as machine totals.

#### Files to Create / Modify

- `apps/v2/src/site.css` — lot / plot / row layout using token variables. No Tailwind. No Font Awesome. Fonts: the stacks already in `tokens.css` (Fraunces → Georgia, Plex Sans → system-ui, Plex Mono → ui-monospace). Do not add a Google Fonts or CDN `<link>`.
- `apps/v2/src/components/*.tsx` as in the file layout
- `apps/v2/src/lib/tree.ts` — workspaces = nodes with `kind === 'workspace'` plus darkPaths entries not in nodes; children grouped by `parentId`; no inferred architect parent
- `apps/v2/src/App.tsx` — wires bootstrap + stream to SiteView; four page states
- `apps/v2/__tests__/SiteView.test.tsx`
- `apps/v2/__tests__/StatusStamp.test.tsx`
- `apps/v2/__tests__/Sparkline.test.tsx`
- `apps/v2/__tests__/tree.test.ts`

D8 cut, in markup:

- **In:** machine lot (hostname), workspace plot, architect header, builder row (`.stake`), four stamps, sparkline, `heldMail` mark, `.grid-bg`, `.dim-sub`, `.needs-attn`
- **Out, absent not disabled:** gate rail, Find node, Add machine, terminal bank, command palette, rust queue chip

Header is the machine name only. Footer is `Machine totals:` + `counts.workspaces` / `counts.builders.total` / `counts.gateWaiting` in graphite. The footer must not read as a rollup of the drawn tree.

Dark plot: decode `workspace:<path>`, label with basename, show `reason` and the `at` stored when the dark frame arrived. `.dim-sub`. No node required.

Unknown status: stamp shows the raw string, no `--moss` / `--rust` / `--ochre`, so it cannot be mistaken for `running`.

#### Deliverables

- [ ] Site view components wired to live state
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Scenario 6 (render): unknown status visibly wrong, not `RUN`
- [ ] Scenario 7: dark sibling stays live; `nodes: []` is empty-site copy; unreachable is a connection banner and **not** the empty-site copy
- [ ] Scenario 21 (render): `nodes: []` + one `dark` → one dark plot from the id
- [ ] Criteria 17 / 18: footer labelled machine totals; builder beside architect, under workspace
- [ ] `--rust` appears only on `gate-waiting` treatment
- [ ] D8-out selectors (`#gate-rail`, Find node, Add machine, `#terminal-bank`) are absent
- [ ] Scenario 9 still holds after UI code
- [ ] Build and unit tests pass

#### Test Plan

React Testing Library against fixture state. No real network. Assert text, class names (`.needs-attn`, `.dim-sub`, `.spark`), and absence of D8 chrome.

### Phase 5: Playwright fixture proof

**Dependencies**: Phase 4

#### Objective

Every browser-facing criterion is driven at 1440 against a local fixture server that speaks `/api/workspaces` and `/v2/events`. No live Tower, no real worktree, no `afx cleanup`.

#### Files to Create / Modify

- `apps/v2/playwright.config.ts` — viewport `{ width: 1440, height: 900 }`; `webServer` starts `apps/v2/e2e/fixture-server.ts` and `vite preview --base /v2/` (or Vite preview of the built app with the fixture as proxy). Do not hook `packages/codev/playwright.config.ts` (that one starts live Tower).
- `apps/v2/e2e/fixture-server.ts` — scripted frames, controllable disconnect, per-test scenarios via query or a small control POST on the fixture only
- `apps/v2/e2e/site.spec.ts` — one test per browser-facing criterion
- `apps/v2/package.json` — `test:e2e`
- `codev/reviews/83-v2-client-shell.md` is **not** written here; cold-load and idle-bandwidth numbers from this phase are recorded in the review later
- Scenario 11 check: `apps/v2/__tests__/frozen-files.test.ts` or a phase-5 script that `git diff --stat`s the C1/C2 list

Fixture injects a well-formed key into its own `/v2/` HTML the same way production does, so the app's `fetch` headers work without live Tower.

#### Deliverables

- [ ] Playwright suite covering scenario 10
- [ ] Frozen-file check
- [ ] Tests for this phase

#### Acceptance Criteria

Scenario 10, each a test:

- [ ] Load + render hierarchy (workspace / architect / builder from a snapshot)
- [ ] `node` for a new builder appears with no reload
- [ ] `gate-waiting` → `GATE` + rust; rust nowhere else
- [ ] `stalled` → `STALLED` + ochre
- [ ] Sparkline advances on `tick`; silent builder flattens to zero
- [ ] Fixture `gone` removes the row
- [ ] Kill fixture socket, restore: state recovers with no `reload`; both honoured resume and refused snapshot
- [ ] Dark workspace dark, sibling live
- [ ] Unreachable vs zero workspaces differ
- [ ] Two pages on one fixture scope converge
- [ ] Counts in the footer, not presented as the tree's rollup
- [ ] Builder under workspace, beside architect
- [ ] Cold load and idle KB/s **measured and printed**, not asserted (criteria 12, 13)

Also:

- [ ] Scenario 11: frozen C1/C2 files have empty `git diff --stat`
- [ ] Spec 52 v2 suite still passes
- [ ] Build and unit tests pass

#### Test Plan

Playwright against the fixture. Resume: fixture honours `since`+`stream` or replies `resumed: false`. Unreachable: fixture closes the port. Empty: fixture returns `{"workspaces":[]}`. Two tabs: two `page` objects, same origin.

Manual UX (not automated): open live `/v2/` on this machine, spawn a builder, wait past `IDLE_WAITING_THRESHOLD_MS`, `afx cleanup` by a human. Record in the review.

## Test scenario → phase map

| Scenarios | Phase |
|---|---|
| 12, 15, 16, 19 (pack) | 1 |
| 1–6 (state), 8, 19 (cursor), 20 (frames), 21–24, 28–31, 33–37, 39, 41, 35 | 2 |
| 9, 13, 14, 17, 18, 20 (EOF/HTTP), 25–28, 32, 38, 40 | 3 |
| 6 (render), 7, 21 (render), 17/18 criteria, D8 absence | 4 |
| 10, 11 | 5 |

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `encodeURIComponent(join(','))` | High | High — 200 + empty + dark | D12; scenario 18 hits real `parseScope` |
| Client tests invisible to porch | High | High — green implement, broken client | `packages/codev` `test` also runs `@cluesmith/codev-v2 test` |
| Playwright against live Tower | Medium | High — flaky, or `afx cleanup` | Fixture server; gone is a frame |
| Tailwind/CDN pulled from the mockup | Medium | Medium — offline fail, extra CSS | Phase 4 forbids both |
| `listWorkspaces()` used out of habit | High | High — unreachable === empty | Phase 3; scenario 17 |
| Rust on footer / reconnect | High | High — colour discipline | Phase 4 + scenario 10 rust assertion |
| `v2-dist` missing from pack | High | High — adopters 404 | `copy-v2` builds first; scenario 19 |
| Prologue change regresses `/v2/events` | Low | High | Existing 57 v2 tests stay in the suite |
| Dark treated as a machine | Medium | Medium | Phase 4 builds the plot from `workspace:<path>` |

## Documentation Updates

None in this unit. `arch.md` / `lessons-learned.md` wait for the review. `apps/v2` gets no README unless a later unit needs one; the page is the interface.

Findings already filed stay filed: **#97** (FR-3 unmet), **#98** (dark decided once per connection). The review lists them; this plan does not patch them.
