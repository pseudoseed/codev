# air-106 — a thrown /v2/events fetch discards the drawn tree

Protocol: AIR (strict). Issues: **#106** (main), **#105** (folded in by the architect).

## What was wrong

`viewKind` returned `unreachable` on `state.connection === 'unreachable'` before it
looked at whether anything was drawn. A clean EOF sets `reconnecting` and keeps the
tree; a thrown fetch or a 5xx sets `unreachable` and swapped the whole page for a
banner, discarding nodes that were still in `state.reducer`. Spec 83 D2 says state
survives the socket.

## The rule implemented

Once a snapshot has landed, a transport failure keeps the tree and puts the
connection state on a strip above it. The whole-page banner is only for when there
is nothing to keep: before the first snapshot, or after a bootstrap failure.
`hasTree(state)` is the test — nodes or dark paths.

D5 is untouched. Empty, dark and unreachable stay visibly distinct; only *where*
unreachable is expressed moved.

## Decisions taken inside the unit

- **Auth failure over a tree gets the strip too**, with its own wording ("Auth
  failed — the tower key was rejected. Not retrying."). One rule, no special case:
  discarding a valid tree because the *next* connection will fail is the same bug.
- **`lastLiveAt` was added to `AppState`**, stamped whenever a frame applies live.
  A kept tree that does not say when it was last true reads as a current one. No
  stamp is rendered when nothing was ever live, rather than an invented one.
- **Ochre, not rust.** Rust belongs to gates (spec 83). A lost connection is ochre
  — something may be wrong, nobody is blocked. The machine row's status stamp turns
  ochre with it, so the two signals are one colour language.
- **`ConnectionBanner` lost its `reconnecting` kind.** Both strip states now live in
  `ConnectionStrip`; the banner is the whole-page statement only.

## #105 and spec 83 C1

Bare `GET /v2` 401s: `isPublicRoute` matches `/v2/` exactly, and the dispatch at
`tower-routes.ts:282` was `startsWith('/v2/')`, so `/v2` fell through to the generic
404 *inside the frozen file*. There is no other seam — `ROUTES` at :176 is keyed
`METHOD /path` and has no `/v2` entry, and `isRequestAllowed` runs at :257 before
any dispatch.

Raised with the architect rather than deciding it here. **Their ruling: relax C1 by
exactly one condition** — widen the dispatch predicate, so the frozen-file diff
carries dispatch (*where* to send it) and no v2 policy (*what to do with it*). The
301 itself lives in `v2-static.ts`. `isPublicRoute` gains `GET /v2` only; D9 already
opened that file for exactly these clauses. Recorded in the PR body, per their
instruction that a widened constraint must be widened on the record.

## Verification

Tests alone cannot see this one, so it was photographed against the **live Tower on
4100** (87 real nodes) through a scratch proxy that could cut the stream mid-flight:

| State | Result |
|---|---|
| live | tree, no strip, machine row `ONLINE` in moss |
| clean EOF, retry held open | tree kept, graphite `RECONNECTING` strip |
| stream cut, every retry throws | tree kept (87 → 87 nodes), ochre `CANNOT REACH TOWER. RETRYING.` strip, `last seen 13:39:16`, machine row `UNREACHABLE` in ochre, no reload (page sentinel survived) |
| same cut, code at HEAD | 87 → **0** nodes, whole-page banner — the bug |

Suites: apps/v2 unit 166 tests, e2e 21 Playwright tests, packages/codev vitest
6013 passed / 0 failed (306 files, 3 skipped).

## A measurement I got wrong

A full-suite run at 19:49 UTC reported 78 failures across 16 files, and I called
them pre-existing. I had A/B'd them with my server changes reverted — identical
count, identical files — but that only proves *not caused by this diff*, which is
a different claim. The architect checked main independently: green at the same
SHA my branch sits on. Re-run with no concurrent suite: green here too. The cause
was contention — two full suites sharing one `~/.agent-farm`, one Tower on 4100
and one port range, over exactly the areas that failed (spawn-*, session-manager,
update/adopt, consult lanes).

Nothing about it reached the PR body.

## Flaky Tests

None seen.
