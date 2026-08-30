# air-220 — Spec 146 Phase 11: codev-client tree and live status

## Slice 1 (checkpoint): scaffold, tree, live status

Built `apps/client` on the `apps/v2` stack (React 19, Vite 6, Vitest 4, Playwright), reusing v2's
`tokens.css` verbatim so the client inherits the established design language rather than inventing
one. v2 is slated for deletion in phase 12, which is why the tokens are copied rather than imported.

**Three server-side changes were unavoidable, and each is a "could not tell" fix.**

1. `ThreadRegistrySnapshot.t3code` — the snapshot carried no indication of whether session state
   was observable. Without it, "t3code says every thread is settled" and "t3code was never asked"
   are the same payload. `ThreadIdentity.sessionState` carries the live state when there is one.

2. **Terminal-backed identities are now published.** The registry only emitted rows carrying a
   `thread_id`, and on 2026-08-29 *every* architect and builder row in `global.db` is
   terminal-backed — phase 8's writer is not in production use. So the registry reported this
   workspace, with a live architect and two live builders, as EMPTY. `ThreadIdentity.backing` is
   `'thread' | 'terminal'` and terminal-backed rows are published and labelled. This is what made
   the first real screenshot non-blank.

3. **An SSE heartbeat.** Snapshots are emitted only on change, so a healthy quiet workspace sends
   nothing for hours and a client can set no staleness deadline against that. Found by killing the
   server behind a proxy: the socket stayed open, the browser's `read()` never settled, and the
   tree sat on LIVE indefinitely. The server now writes a `: heartbeat <iso>` comment every 10s and
   the client races each read against a 32s deadline (three missed beats).

`builders.spawned_by_architect` is projected onto the identity so the tree groups builders under
their architect. A builder whose recorded architect is not present renders under an explicit
"builders with no architect recorded on this machine" group — never silently under the first one.

## The second server

Criteria 7, 8 and 15 need two machines. A second Tower against the live `~/.agent-farm` would share
global.db, cron, delayed-send and the PTY manager with the one driving real builders, so instead
`tools/codev-agent-host/` mounts the same route table, registry and status reader over a **database
snapshot** and a scratch credential root. It prints its minted credential as one JSON line on
stdout. Started, stopped and revoked freely; touches nothing real. This is also the two-server e2e
harness for slice 3.

The vite dev server proxies each machine under a path prefix (`/m/alpha`, `/m/beta`), so the browser
reaches every server same-origin and `connect-src 'self'` stays closed.

## Verified by looking, not only by tests

Ran against a live host over a snapshot of the real `global.db`, workspace
`/Users/chris/dev/codev-1455`. First screenshot rendered as unstyled raw HTML: `style-src 'self'`
blocked Vite's injected `<style>`. `script-src` stays `'self'` — script execution is the
credential-theft path — and `style-src` now allows inline, with `default-src 'none'` plus
`img-src 'self' data:` closing the CSS-exfiltration route. Also caught `builder/builder-air-220`:
`builders.id` carries its own `builder-` prefix.

`frame-ancestors` was removed from the meta CSP. A `<meta>` CSP silently ignores it, and a
directive that does nothing reads as protection. It is a response header now.

Killed the host with the page open and watched it: DISCONNECTED band, relative *and* absolute
last-live timestamp, "retrying", the reason, and the retained subtree dimmed under "Showing the
last state received. It is not current."

## Still to do (slices 2 and 3)

- Multi-machine: two machines in one tree, independently live (criterion 7); revoking one machine's
  token fails that subtree closed and leaves the other alone (criterion 15).
- Gate rendering and approval through phase 6's capability path (criterion 9b). Derivation already
  carries the structured question and choices; nothing renders them yet.
- Playwright e2e against two live `codev-agent-host` instances.
