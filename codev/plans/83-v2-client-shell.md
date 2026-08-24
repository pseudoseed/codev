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

**Two layers, one composed `AppState`. The reducer is the frame layer only.**

```
AppState = {
  connection: 'loading' | 'unreachable' | 'reconnecting' | 'live',
  connectionWhy: null | 'auth' | 'transport',
  bootstrap: 'pending' | 'scoped' | 'empty' | 'mismatch',
  bootstrapMismatch: null | { how, preview? },
  reducer: {                          // frames only. No unreachable here.
    nodes, darkPaths, counts,
    cursor: { streamId, seq },
    mismatch: null | { how, seq?, type?, field?, preview?, afterSeq },
    mismatchAttempts,
  },
}
```

Display, in this order:

1. `connection === 'unreachable'` → connection banner (auth-labelled when `connectionWhy === 'auth'`). Not the empty site.
2. `bootstrap === 'mismatch'` or `reducer.mismatch` → mismatch page. Not unreachable.
3. `bootstrap === 'empty'` **or** (`connection === 'live'` and `nodes.size === 0` and `darkPaths.size === 0`) → empty site.
4. Else SiteView. `nodes: []` plus a `dark` entry is a dark plot, not empty (scenario 21).

`App.tsx` is the only composer. The reducer never sees a failed fetch. Bootstrap mismatch and frame mismatch share a render, not a store.

Every accepted frame advances `cursor.seq` to that frame's `seq`. A `snapshot` with a new `streamId` resets the baseline and **replaces `darkPaths` wholesale** before applying that snapshot's own `dark` frames.

**Validate before reduce.** The read-set in D1 is the closed list. Extra fields are ignored (scenario 35). `status` value is not validated (scenario 31). `seq` is a finite non-negative safe integer. Ordering is non-decreasing **within** a `streamId`; across `streamId`s there is no comparison.

**New builder, no buckets.** On `node` upsert: known id → leave trace; new `kind === 'builder'` → 20 zeros. `tick` is the only later writer. Absent id in `tick.buckets` appends 0.

**Timers.** Zero `setInterval` under `apps/v2/src`. Exactly one `setTimeout`, inside `reconnectBackoff` in `stream.ts`. Bootstrap retries and stream reconnects both call that function. Start 1s, cap 15s, reset on a successful frame or a successful bootstrap 200. No refetch on focus or visibility.

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
- `apps/v2/vite.config.ts` — `base: '/v2/'`; `server.proxy` `/api` and `/v2/events` to `http://localhost:4100`. Dev-only (`apply: 'serve'`) `transformIndexHtml` plugin injects `window.__CODEV_TOWER_KEY__` from `CODEV_TOWER_KEY` or `~/.agent-farm/local-key` (64-hex check, `JSON.stringify`, before `</head>`). Production injection stays in `v2-static.ts`. No `localStorage` fallback.
- `apps/v2/vitest.config.ts` — jsdom, `passWithNoTests: true` (phase 1 has no client tests yet; without this, `pnpm --filter @cluesmith/codev-v2 test` fails and porch's root `npm test` goes red)
- `apps/v2/tsconfig.json`, `src/vite-env.d.ts`
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
- `packages/codev/src/agent-farm/utils/server-utils.ts` — `isPublicRoute` clauses as listed under `v2-static.ts` rules below. No `/v2` alias.
- `packages/codev/package.json` — `files` += `v2-dist`; `copy-v2` script builds `@cluesmith/codev-v2` then `rm -rf v2-dist && cp -r ../../apps/v2/dist v2-dist`; `bundle-assets` runs `copy-v2`; `devDependencies` += `@cluesmith/codev-v2`; `test` becomes `vitest run && pnpm --filter @cluesmith/codev-v2 test` so porch's root `npm test` covers the client and does not hang in watch mode.
- `pnpm-lock.yaml` (workspace already lists `apps/*`; lockfile is the expected touch)
- Tests listed below

`v2-static.ts` rules:

1. ESM shim, same as `tower-server.ts:69-70`: `const __dirname = path.dirname(fileURLToPath(import.meta.url))`. Then resolve the asset root from `path.resolve(__dirname, '../../../v2-dist')`. Export `setV2DistRoot` for tests (same shape as `setV2RouteDeps`).
2. `GET /v2/` **only** → read `index.html`, inject key, strip `Access-Control-Allow-Origin` and `Vary`, `text/html; charset=utf-8`. **Do not handle bare `/v2`.** `tower-routes.ts:282` is `pathname.startsWith('/v2/')` and C1 freezes it, so `/v2` never reaches this function. D9 names `/v2/` and `/v2/assets/*` only.
3. Injection is a pure `injectV2Key(html, key)` that mirrors `injectWebKey` (`tower-routes.ts:2441`): embed via `JSON.stringify` **only** when the key matches `/^[0-9a-f]{64}$/`; insert before `</head>`; no placeholder required. The file comments the three D6 properties and names `injectWebKey` as the source of record. `removeHeader` is called **only** on this index branch.
4. `GET /v2/assets/*` → extension allowlist `{js,css,map,svg,woff2,png,ico}`; reject `..`, absolute segments, and any resolved path that is not under `<root>/assets/`; 404 otherwise. Do not call `removeHeader`.
5. Any other path, and any non-GET: 404, same body as today (`Not found`). No `removeHeader`. Existing `v2-routes.test.ts:127` (`GET /v2/nope` on a mock without `removeHeader`) keeps passing.

`isPublicRoute` clauses, after `/` / `/index.html`:

- `GET` + `pathname === '/v2/'` → true
- `GET` + `pathname.startsWith('/v2/assets/')` → true
- nothing else under `/v2/`. No `/v2` alias.

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

- `v2-static.test.ts` — injectV2Key table; traversal; extension allowlist; missing dist → 404; method not GET → 404. Drive via `setV2DistRoot` + `handleV2Route` so the prologue is the path under test. Index-path mocks must implement `removeHeader`; 404-path mocks need not (the handler must not call it there).
- `v2-public-route.test.ts` — scenario 16 against both `isPublicRoute` **and** `isRequestAllowed` (same helper style as `request-auth.test.ts`). Keyless `GET /v2/` and `GET /v2/assets/x.js` allowed; keyless `GET /v2/events?scope=…` and `POST /v2/` rejected. Existing `request-auth.test.ts` cases stay untouched and must still pass.
- `v2-packaging.test.ts` — lives in `__tests__/` (not `e2e/`, so the default vitest run sees it). The test itself runs `pnpm copy-v2` then `npm pack --dry-run` and asserts `v2-dist/index.html` and `v2-dist/assets/`. Self-contained; does not depend on a prior build.

### Phase 2: Frame validation and reducer

**Dependencies**: Phase 1

#### Objective

Every frame type has a validator and a reducer transition. Degenerate frames are terminal. Two reducer instances fed the same frames converge. No network, no DOM required for the core table.

#### Files to Create / Modify

- `apps/v2/src/lib/validate.ts` — D1 read-set; returns `{ok, frame}` or `{ok: false, mismatch}` with only decoded facts (scenario 29)
- `apps/v2/src/lib/reducer.ts` — D1 table
- `apps/v2/__tests__/validate.test.ts`
- `apps/v2/__tests__/reducer.test.ts`

Reducer state (frame layer only — see Shared implementation rules):

```
{
  nodes: Map<string, Node>,          // Node always has buckets?: number[]
  darkPaths: Map<string, {reason, at}>,
  counts: V2Counts | null,
  cursor: { streamId: string | null, seq: number },
  mismatch: null | { how, seq?, type?, field?, preview?, afterSeq },
  mismatchAttempts: 0,               // 0 = budget full; 1 = recovery used
}
```

Empty is derived: `nodes.size === 0 && darkPaths.size === 0`. `nodes: []` plus a `dark` entry is **not** empty (scenario 21). Unreachable is `AppState.connection`, not a reducer field.

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

That identifier is what scenario 9 greps for. It is the only `setTimeout` in `apps/v2/src`. `bootstrap.ts` retries by calling `reconnectBackoff`; it does not import `setTimeout` itself.

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

Scripted `ReadableStream` and a fake `fetch` that records URLs. Scenario 18's round-trip lives in `v2-scope-encoding.test.ts` and **duplicates** `WS_A` / `WS_B` / `makeReq` / `makeRes` / `urlFor` — those helpers are module-local in `v2-routes.test.ts` and are not exported. The test still calls `handleV2Route` so it exercises the frozen `parseScope`.

### Phase 4: Site view

**Dependencies**: Phase 3

#### Objective

`/v2/` draws the approved site view from reducer state. Empty, dark, and unreachable cannot be mistaken for each other. Builders sit under the workspace beside architect headers. Counts sit in the footer as machine totals.

#### Files to Create / Modify

- `apps/v2/src/site.css` — hand-translate the mockup's containment layout (lot, plot grid, architect header, `.stake` rows, footer). `01-site.html` does this with Tailwind utilities; `tokens.css` only ships the pattern classes. This file is the rest. No Tailwind. No Font Awesome. Fonts: the fallback stacks already in `tokens.css` (Fraunces → Georgia, Plex Sans → system-ui, Plex Mono → ui-monospace). No Google Fonts `<link>`, no vendored `woff2`. That is an accepted deviation from the mockup's CDN faces, not a later-unit stub.
- `apps/v2/src/components/*.tsx` as in the file layout
- `apps/v2/src/lib/tree.ts` — workspaces = nodes with `kind === 'workspace'` plus darkPaths entries not in nodes; children grouped by `parentId`; no inferred architect parent
- `apps/v2/src/App.tsx` — the `AppState` composer (Shared implementation rules). Display precedence lives here, not in the reducer.
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

- `apps/v2/playwright.config.ts` — viewport `{ width: 1440, height: 900 }`; `baseURL: 'http://127.0.0.1:4173'`; `webServer.command` is `node e2e/fixture-server.ts` on port 4173. Do not start Vite preview. Do not hook `packages/codev/playwright.config.ts`.
- `apps/v2/e2e/fixture-server.ts` — **sole HTTP owner** for the suite. One origin, port 4173:
  - `GET /v2/` → built `apps/v2/dist/index.html` with the same `injectV2Key` rules (well-formed 64-hex fixture key)
  - `GET /v2/assets/*` → files from `apps/v2/dist/assets`, same allowlist / no-traversal as production
  - `GET /api/workspaces` → scripted body
  - `GET /v2/events` → SSE frames; honours or refuses `since`+`stream`; controllable disconnect
  - control POST `/__fixture/...` for per-test scenario switches (not part of the app)
- `apps/v2/e2e/site.spec.ts` — one test per browser-facing criterion
- `apps/v2/package.json` — `test:e2e`; **devDependency `@playwright/test`** (do not import it from `packages/codev`)
- `codev/reviews/83-v2-client-shell.md` is **not** written here; cold-load and idle-bandwidth numbers from this phase are recorded in the review later
- Scenario 11 check: `apps/v2/__tests__/frozen-files.test.ts` or a phase-5 script that `git diff --stat`s the C1/C2 list

The fixture is the only server Playwright talks to. `vite preview` is not in this phase: its `server.proxy` does not apply to preview, and a second origin would 401 the stream.

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
- [ ] Cold load and idle KB/s **measured and printed**, not asserted (criteria 12, 13). `tower-routes.ts:242` sets `Cache-Control: no-store` on every response and C1 freezes that file, so hashed `/v2/assets/*` will not be cached in production either. Measure against that fact; do not try to override it.

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
| Playwright against live Tower | Medium | High — flaky, or `afx cleanup` | Fixture is the sole origin; gone is a frame |
| Bare `/v2` treated as the shell | Medium | Medium — dead code behind a frozen `startsWith('/v2/')` | D9 as written; no `/v2` alias |
| `vitest` (watch) as the codev test script | High | High — porch hangs | `vitest run` |
| Phase 1 client test script with zero files | High | High — porch `npm test` red | `passWithNoTests: true` |
| `pnpm dev` has no key | High | Medium — every request 401s | serve-only `transformIndexHtml` plugin |
| `__dirname` in an ESM package | High | High — `v2-static.ts` throws at load | `fileURLToPath(import.meta.url)` shim |
| Tailwind/CDN pulled from the mockup | Medium | Medium — offline fail, extra CSS | Phase 4 forbids both |
| `listWorkspaces()` used out of habit | High | High — unreachable === empty | Phase 3; scenario 17 |
| Rust on footer / reconnect | High | High — colour discipline | Phase 4 + scenario 10 rust assertion |
| `v2-dist` missing from pack | High | High — adopters 404 | `copy-v2` builds first; scenario 19 |
| Prologue change regresses `/v2/events` | Low | High | Existing 57 v2 tests stay in the suite |
| Dark treated as a machine | Medium | Medium | Phase 4 builds the plot from `workspace:<path>` |

## Documentation Updates

None in this unit. `arch.md` / `lessons-learned.md` wait for the review. `apps/v2` gets no README unless a later unit needs one; the page is the interface.

Findings already filed stay filed: **#97** (FR-3 unmet), **#98** (dark decided once per connection). The review lists them; this plan does not patch them.
