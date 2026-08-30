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
    "credential": "<credentialId>.<secret>",
    "towerKey": "<64 hex chars, only when the host is Tower>"
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
| `towerKey` | Tower's shared local key. Needed only when the agent is Tower, whose own choke point sits in front of the agent routes. |

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
