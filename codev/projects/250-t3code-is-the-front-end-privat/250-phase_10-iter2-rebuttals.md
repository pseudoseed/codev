# Phase 10 — 3-way review, iteration 2

**Claude COMMENT / HIGH. opencode APPROVE / HIGH, no issues.** opencode verified all three
iteration-1 fixes in the tree rather than taking the rebuttals' word for them.

One finding, accepted, and it is a good one.

---

## 1. The same-origin assertion was a PREFIX match — Claude

> `spec-250-approval.spec.ts:202,292` compare origins with `url.startsWith(origin)`; the agent
> host's ephemeral port can prefix-match `http://localhost:5733` (57330-57339), so a real
> cross-origin request would be filtered as same-origin.

**Accepted, with the numbers, because the numbers are why it is worth fixing rather than noting.**

`webAppUrl()` defaults to a fixed `http://localhost:5733` and the agent host binds an ephemeral
port through `listen(0)`. So `http://localhost:57330` … `:57339` prefix-match — ten ports inside
macOS's ephemeral range of 49152-65535, about **0.06% of runs** in which a genuinely direct
browser-to-agent request would have been counted as same-origin and the phase's central security
assertion would have passed anyway.

**A rare false pass is worse than a common one.** It makes the test look reliable while it is not,
and 0.06% is precisely the rate at which nobody ever sees it fail — so it would have been trusted
for the life of the spec. This is the same family as iteration 1's skip-as-pass, one layer in: not
a test that could not run, but a test that could run and could not fail.

**Fixed** by comparing parsed origins, and **the predicate moved out of the Playwright spec into
`spec-250-same-origin.ts` so it can be tested at all.** That relocation is the more durable half of
the fix: the function that decides whether a security claim passed was the one piece of the suite
with no test of its own, which is how it stayed wrong.

Five unit tests, in the default suite. Restoring the prefix match fails **three** of them —
including the 57330-57339 case, stated as the concrete ports rather than as a principle.

## 2. `blob:` alongside `data:` — Claude, non-blocking

> `blob:` is not exempted alongside `data:` in the same filter, which would produce a false failure
> rather than a false pass. Harmless today.

**Accepted, and generalised rather than patched.** Naming `blob:` beside `data:` leaves `about:`
and whatever a browser invents next to break a later run. Non-http schemes are now exempt as a
**class** — `if (!/^https?:/i.test(url)) return false` — because none of them is a request to
another origin, and `new URL("data:…").origin` is the string `"null"`, so comparing them by origin
is what would produce the false failure.

One of the five tests covers `data:`, `blob:` and `about:` together.

## What opencode verified rather than assumed

It read the iteration-1 fixes in the code, not in the rebuttals: `skipIfUnavailable` calls
`ctx.skip` (typed `never` on Vitest 4, so the body cannot run), `UPSTREAM_TIMEOUT_MS` is documented
as an idle-socket timeout, and `approvalStateAttribute` maps four outcomes to four words. It also
confirmed the proxy is registered in `server.ts` beside the targets route — the wiring, not just
the module.

## Everything else, both lanes

Origins from `T3CODE_CODEV_AGENT_ORIGINS` with the browser selecting by id; absolute paths, unknown
targets, uncarried paths and redirects refused; `Connection` tokens subtracted from the header
allowlist; `authorization` and `cookie` never forwarded; the ceremony unchanged and the record
server-sourced with an empty 200 as `unconfirmed`; pane content from one workspace-state poll; and
the Playwright same-origin watch with a positive proxy hit so the negative cannot pass vacuously.
