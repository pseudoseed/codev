# `apps/client` — the Codev client

The workspace tree: machine, workspace, architects, that architect's builders,
with live status on every row, the structured gate content inline, and gate
approval through the capability path. Spec 146 phase 11.

React 19, Vite 6, Vitest 4, Playwright — the same stack as `apps/v2`, which this
replaces in phase 12.

**Phase 12 added the tiled grid and the Tower mount.** The client opens on a grid
of panes — one per builder, an architect strip below it — and Tower serves it at
`/client/`. The tree is still here at `/client/?view=tree`, and the Grid/Tree
switch in the header moves between them.

## Run it in one command

```bash
cd apps/client
pnpm install
node scripts/dev-servers.mjs   # leave running: two throwaway machines, one holding a gate
pnpm dev                       # in another shell; open the URL it prints
```

`dev-servers.mjs` starts two real `codev-agent` hosts over temporary workspaces
and writes `.dev-machines.json` for them. Nothing real is touched: each host runs
over its own scratch database and credential store. Stop one host to watch its
subtree go **DISCONNECTED**; type `revoke alpha` into the `dev-servers` shell to
watch one go **ACCESS REVOKED** while the other stays live.

## Run it against your actual Tower

```bash
pnpm dev:pair                                   # pairs with http://127.0.0.1:4100
pnpm dev:pair -- --origin http://127.0.0.1:4100 \
                 --workspace /abs/path/to/workspace \
                 --machine my-laptop --id local
pnpm dev
```

`pair-dev.mjs` mints a pairing token, redeems it for a **real** machine
credential, and appends the machine to `.dev-machines.json`. Revoke it with
`DELETE /api/agent/v1/machines/<name>`.

## `.dev-machines.json`

Gitignored, mode 0600, and the only thing the client needs to know about the
world. An array:

```json
[
  {
    "id": "alpha",
    "label": "alpha",
    "origin": "http://127.0.0.1:4101",
    "workspacePath": "/Users/me/dev/codev",
    "credential": "<credentialId>.<secret>"
  }
]
```

| Field | Meaning |
|---|---|
| `id` | Stable key. The dev server proxies this machine at `/m/<id>/`. |
| `label` | What a human calls the machine; shown in the tree. |
| `origin` | Where that machine's codev-agent listens. Rewritten to `/m/<id>` before it reaches the page. |
| `workspacePath` | Absolute workspace path **on that machine**. |
| `credential` | The machine credential from pairing. Never logged. |

**Tower's shared `local-key` is never in this file and never reaches the page.**
It is Tower's all-or-nothing secret — it cannot be revoked for one machine
without rotating it for all — so a page holding it would have Tower-wide access
to every workspace on the host, which revoking the machine credential would not
take away. It is not needed either: `isRequestAllowed` exempts
`/api/agent/v1/*` from the shared key precisely so a paired device can reach the
surface holding only what pairing gave it, which is scoped and revocable.
`scripts/pair-dev.mjs` uses the key locally to redeem a token and does not write
it down.

A malformed entry is dropped and counted, and the page says how many — a machine
row with no credential would otherwise render as permanently disconnected and
blame the server for a configuration mistake.

**The page never makes a cross-origin request.** Both the dev server and
`scripts/serve.mjs` proxy each machine under a path on the page's own origin, so
`connect-src 'self'` stays closed. That is the posture the client ships with; a
setup that had to widen the CSP to reach a second port would not be testing what
runs.

## The two views

| View | URL | What it is for |
|---|---|---|
| Grid (default) | `/client/` | Watching work. One tile per builder, the architect in a strip below, the last three messages in each tile. |
| Tree | `/client/?view=tree` | Diagnosing a machine. The only view that shows machine boundaries, connection bands (LIVE / STALE / DISCONNECTED / ACCESS REVOKED / CANNOT VERIFY) and the unattributed-builder grouping. |

The grid's geometry is arithmetic, and it lives in `src/responsive/layout.ts`
with its own unit tests, because the criteria it serves are numbers:

| Viewport | Layout |
|---|---|
| below 700px | One pane per screen with a pager. It **pages rather than shrinks**, and nothing is allowed to widen the document. |
| 700–1919px | A near-square grid of builder tiles, every one at least **340x240 CSS px**, body text at **13px or larger**. The architect gets a persistent strip below the grid and expands to a full pane on demand, replacing the grid. |
| 1920px and wider | The architect may take a seventh equal tile; the strip goes away. |

`repeat(auto-fill, minmax(340px, 1fr))` is the obvious CSS for this and gives the
wrong answer: four 340px columns fit in 1440 less padding, so six builders would
tile 4 + 2 rather than the 3x2 the spec requires. The column count is therefore
computed — near-square, capped by what fits — and the CSS applies it.

## The last three messages

Each pane shows the last three messages addressed to that agent, and the
architect strip shows its last one. They come from the **mailbox** — the durable
record of `afx send` traffic — over `/api/agent/v1/*` only. The v2 and overview
surfaces stay count-only (`heldCount`, never bodies): they are reached with
Tower's shared key rather than a per-machine revocable credential, and that
difference is the whole reason the rule exists.

Three absences are three different sentences, never one blank:

| What the pane says | What is true |
|---|---|
| No messages have been sent to this agent | The log was read and is empty. |
| This machine's message log would not open | The mailbox threw. The agent may have several. |
| This server does not report messages | An older server that predates the field. |

A body longer than 240 characters is cut, and the pane says **CUT** on it. A
message trimmed silently is a partial message reported as a complete short one.

## Serving the built bundle

```bash
pnpm build
pnpm serve            # http://127.0.0.1:4180/client/
```

`scripts/serve.mjs` serves `dist/`, answers `machines.json`, proxies `/m/<id>/`,
and sends the `frame-ancestors` header a `<meta>` CSP silently ignores.

### Tower serves it at `/client/`

Phase 12 moved the mount into Tower (`packages/codev/src/agent-farm/servers/client-static.ts`),
so `scripts/serve.mjs` is now the loopback convenience rather than the only
server. The root `pnpm build` includes this app: `packages/codev`'s
`bundle-assets` runs `copy-client`, which builds `apps/client` and copies its
`dist/` to `packages/codev/client-dist/`, the same way `copy-v2` handles
`apps/v2`.

| Path | Served |
|---|---|
| `/client/` | The shell, with `Content-Security-Policy: frame-ancestors 'none'` as a **response header** — a `<meta>` CSP silently ignores that directive. |
| `/client/assets/*` | The built bundle. |
| `/client/machines.json` | The operator's machine list, each origin rewritten to `/m/<id>` so the page never makes a cross-origin request. |
| `/m/<id>/*` | Reverse proxy to that machine's `codev-agent`, streamed rather than buffered because these are SSE. |

**Tower never injects its shared key into this page**, unlike `/v2/`. That key
cannot be revoked for one machine without rotating it for all, so a page holding
it would have Tower-wide access that revoking a machine credential would not take
away. The page carries per-machine credentials instead.

#### The machine list Tower reads

`~/.agent-farm/client-machines.json` (or `$CODEV_AGENT_FARM_DIR/client-machines.json`),
**mode 0600**, the same array shape as `.dev-machines.json` above. Tower does not
create it and does not mint the credentials in it; an `afx pair` command for that
does not exist yet and is tracked separately.

Four problems, four answers — an absent file and a mistyped one need opposite
next actions, so they never share one empty list:

| Signal | Meaning |
|---|---|
| `CLIENT_MACHINES_ABSENT` | No file. Tower serves the client but has nothing to connect it to. |
| `CLIENT_MACHINES_MODE` | Group- or world-readable. Refused, because it holds credentials. |
| `CLIENT_MACHINES_UNREADABLE` | Present but not parseable as a JSON array. |
| (entry dropped) | A malformed entry is dropped and the rest are served. |

### Reaching it from an iPad over a tailnet

```bash
afx tower start                                   # or leave your running Tower alone
tailscale serve --https=443 http://127.0.0.1:4100
tailscale serve status                            # note the https://<host>.<tailnet>.ts.net URL
```

Then open `https://<host>.<tailnet>.ts.net/client/` on the iPad. An iPad in
portrait is 820px, which is a grid width rather than a paged one.

Tear it down afterwards — leaving it up publishes a Tower to your whole tailnet:

```bash
tailscale serve --https=443 off
tailscale serve status                            # must list nothing
```

## Tests

```bash
pnpm test                     # unit and component
pnpm build && pnpm test:e2e   # Playwright, against two live codev-agent hosts
```

The e2e suite starts two real hosts, kills one, and revokes another's credential.
It owns their lifecycle, which is why there is no Playwright `webServer` block.

### Which suite covers what — read this before quoting a green run

Server-side changes made from this app reach code that the default `vitest run`
in `packages/codev` **cannot see**. Its config excludes `**/*.e2e.test.ts` and
`**/e2e/**`, so a full green run there says nothing about those files. That is
how a change to `PairingStore.issue()` broke `phase7-pairing.e2e.test.ts` while
6,813 tests passed.

<!-- suite-coverage:begin -->

| Suite | Covers | Does NOT cover |
|---|---|---|
| `packages/codev` · `vitest.config.ts` | unit and integration files | anything matching `*.e2e.test.ts` or under `e2e/` |
| `packages/codev` · `vitest.e2e.config.ts` | `src/**/*.e2e.test.ts` and `src/commands/porch/__tests__/e2e/**` — server-spawning Tower tests | the unit suite |
| `packages/codev` · `vitest.cli.config.ts` | `src/__tests__/cli/*.e2e.test.ts` — the installed-CLI surface | everything else |
| `apps/client` · `pnpm test` | this app's unit and component tests | anything server-side |
| `apps/client` · `pnpm test:e2e` | Playwright against two live `codev-agent` hosts | the unit suites |

<!-- suite-coverage:end -->

**Locally, a change to `packages/codev/src` needs at least the first two.** The
unit run alone is a measurement taken where the thing being measured may not be
present.

**This table is checked, not remembered.** `__tests__/suite-coverage.test.ts`
derives the suite list from `packages/codev/vitest*.config.ts` and this app's
`package.json`, and fails if the table drifts from either — or if a suite it
names is not actually run by a job in `.github/workflows/test.yml`.

That guard exists because the table drifted **within one turn of being written**:
the first version was typed from memory and omitted `vitest.cli.config.ts`. A
table that can go stale reintroduces the exact failure it exists to prevent, and
does it with more authority than no table at all, because the next reader trusts
it.

## What the tests deliberately cannot catch

A green suite cannot see design infidelity. This repo shipped a client that
passed 127 client tests, 3,394 server tests and 15/15 Playwright and was
unusable, because every label prefix, the header bar and the sparklines had gone.
While building this one, opening it caught three things the suite said nothing
about: the first render came out as unstyled raw HTML because `script-src 'self'`
blocked Vite's injected `<style>` tag; every builder read
`builder/builder-air-220`; and the approval confirmation flashed and vanished,
because approving removes the gate and unmounts the panel holding the message.

Open it and look at it before calling a change to this app done.

## Known gap: approving a gate whose phase has checks

The client can approve a gate **only when the phase's checks are disabled or
absent.** With checks enabled — which is every real project — the route answers
`PHASE_CHECKS_REQUIRED` and names them, and the operator approves from the CLI.

Not an oversight and not fixable with a timeout. Approving runs porch's phase
checks, which for an AIR `implement` phase are the repository's build and test
suite: minutes of work on an open HTTP request. A client that gives up does not
stop porch, so a timeout would abandon a call that goes on to approve the gate
anyway — reporting one outcome while another happened, which is the defect this
whole client is built against. Refusing before starting is bounded by
construction and says what is needed.

The durable fix is an asynchronous approval — submit, poll, report — and it
belongs with phase 12's static mount rather than here.

Spec 146 criterion 9b is therefore **unmet**, and deliberately not narrowed. The
approval works end to end — session id, machine, authority and timestamp land in
`status.yaml` — but only where the phase's checks do not run, and no real project
is like that. The spec and the phase plan are human-approved and this app's
documentation does not get to redefine one of their acceptance criteria; a
criterion quietly rewritten to match what was built is the thing this phase is
about.

**Owner: phase 12**, with the asynchronous approval and the static mount. Both
branches are tested here — `two-machines.spec.ts` covers the approval and the
refusal — so the gap is measured rather than assumed.

## What a paired session proves

It establishes a live per-machine credential, plus possession of a fresh
single-use token minted on that host for that ceremony. All of that is real,
scoped and revocable, and revoking a machine closes its subtree immediately.

**It does not establish that a human was present.** Minting a pairing token needs
only write access to the pairing store, and every agent on this host runs as the
same user — so a builder can mint one, redeem it, and approve its own gate
through the advertised path. The threat model used to claim otherwise; it was
wrong, and a documented gap beats a guarantee that was never there.

What the system does instead is record. Each mint names an `authority` — the
minter's own account of what authorized it — and that string travels to the
session, to the capability, and into `status.yaml` beside the approval. A reader
sees the claim an approval was made under rather than a verification nobody
performed. Tokens are also bound to one ceremony, so a token minted to pair a
device cannot open a session.

## Known gap: session state

`t3codeSnapshot` is not wired in `tower-server.ts`, so every snapshot from a real
Tower carries `t3code: 'not-provided'` and no row can report **working**,
**turning** or **settled**. Blocked rows work, because gates come from porch. The
client states this once per machine rather than inventing a status, and
`spec-146-phase-11-production-wiring.test.ts` asserts it, so the gap stays
recorded. Spec 146 criterion 3 is **unmet** for that reason.

The obstacle is real: `t3codeSnapshot` is synchronous, a t3 connection is not, so
a provider needs a cached background subscription plus per-workspace t3 config
Tower does not hold. That is phase 10 or 12 work.
