# `apps/client` — the Codev client

The workspace tree: machine, workspace, architects, that architect's builders,
with live status on every row, the structured gate content inline, and gate
approval through the capability path. Spec 146 phase 11.

React 19, Vite 6, Vitest 4, Playwright — the same stack as `apps/v2`, which this
replaces in phase 12.

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
credential, and appends the machine to `.dev-machines.json`.

**Revoke it with `afx pair revoke <name>`.** This used to say
`DELETE /api/agent/v1/machines/<name>`, which is the instruction that does not
work: that route is `human-session`, `human-session` includes
`machine-credential`, and so revoking required already holding the credential you
were trying to withdraw. `afx pair revoke` writes the store directly, needs no
session, and works with Tower stopped.

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

## Serving the built bundle

```bash
pnpm build
pnpm serve            # http://127.0.0.1:4180/client/
```

`scripts/serve.mjs` serves `dist/`, answers `machines.json`, proxies `/m/<id>/`,
and sends the `frame-ancestors` header a `<meta>` CSP silently ignores.

**Tower does not serve this client yet.** Phase 12 replaces `apps/v2` and moves
the static mount; until then `scripts/serve.mjs` is the only server for the built
bundle, and the root `pnpm build` does not include it.

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

## Approving a gate whose phase has checks

**The client approves a gate on an ordinary project** — one whose phase declares
checks, which is every real one. Spec 236 closed what phase 11 recorded here as a
gap.

The obstacle was never a missing feature. Approving runs porch's phase checks,
which for an AIR `implement` phase are the repository's build and test suite:
minutes of work. On an open HTTP request that is unbounded, so the synchronous
route refuses with `PHASE_CHECKS_REQUIRED` and names them — **and it still does**,
for any caller that has not opted into the other path.

**A timeout was never the alternative.** A client that gives up does not stop
porch, so it would abandon a call that goes on to approve the gate anyway,
reporting one outcome while another happened. So the approval outlives its
request instead: submit, poll, report.

- `POST .../gates/approvals` answers **202** with an operation id. The gate is not
  approved at that moment, and 202 rather than 200 is how the client knows.
- `GET .../gates/approvals/<id>` reports one of six states. The panel shows the
  server's own phase and check names while it runs, because "Approving…" for four
  minutes is indistinguishable from stuck.
- The terminal report carries **what porch persisted** — never a value the client
  or the route composed. An already-approved gate reports the approval that
  exists, including when it is somebody else's.

**Three outcomes are not refusals**, and the client renders each as unknown
rather than as "not approved": an interruption (this host stopped; the gate may
be approved, and the server has read `status.yaml` to say which), a poll or
submit that could not complete (this client stopping does not stop porch), and a
success the client cannot parse. Reporting any of them as a refusal would send a
human to approve a gate that may already be approved.

A host that wires no operation store answers **501**, and the client falls back
to the synchronous route — so a host running an older build still approves
everything it ever could.

Spec 146 criterion 9b is **met**. `two-machines.spec.ts` drives both halves
against the same kind of project: the synchronous route refuses it, and the
client approves it.

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

## Session state

`tower-server.ts` wires a `t3codeSnapshot` provider (spec 236). The obstacle that
kept it unwired was real — the provider is synchronous and a t3 connection is not
— and it is resolved by splitting the halves: a background maintainer owns the
connect, the per-thread `orchestration.subscribeThread` subscriptions and the
`global.db` rescan, and the synchronous reader returns what it last wrote plus
how old that is. The read path performs no I/O.

**What a row can now say, and what it still cannot.**

`t3code` carries eight statuses rather than three. Tower's provider emits seven
of them:

| Status | Means |
|---|---|
| `not-configured` | this workspace names no t3code server |
| `misconfigured` | the `threads` block is half-written; carries which part |
| `connecting` | a connect or a subscription is in flight and will resolve itself |
| `cooling-down` | the last connect failed; carries when and why, and it will not retry until a timer passes |
| `available` | observed — including "connected, and there is nothing here to watch" |
| `stale` | observed, and no longer being watched; carries the age |

The eighth, `unreachable`, is **not** produced by Tower: a failed connect becomes
`cooling-down`, which says more. It stays in the vocabulary for a host that
observes unreachability another way — `tools/codev-agent-host` wires no provider
at all and reports `not-provided`, which is the ninth thing this set can say and
the one that used to be the only thing.

`connecting` and `cooling-down` are deliberately not folded into one another: the
first resolves on its own and the second will not until a timer passes, which is
the difference between "wait" and "go look at your server".

`stale` carries an age, and a row whose last-known content read as finished
reports the age instead of `SETTLED` — "it had finished when I last looked" is
not "it has finished".

Per row, session status and thread settledness travel separately, because t3code
keeps them apart: a `stopped` session on a settled thread finished, and on an
unsettled one it did not. The client maps every value in the contract's enum,
adds `STOPPED` and `ERROR` so a crashed or torn-down session is never rendered as
`SETTLED`, and still reports `UNKNOWN` naming any value it does not recognise.

**The bound that remains, stated because criterion 3 is easy to over-read.** A
row with no `thread_id` has no session to observe, and every architect and builder
row in `global.db` is terminal-backed today. Those rows report *this row has no
t3code thread* — which is a third answer, distinct from "not provided" and from
"t3code returned nothing for this thread". Being able to tell the three apart is
what was actually missing; a `WORKING` stamp on a row with nothing running would
have been the older failure wearing a newer word.
