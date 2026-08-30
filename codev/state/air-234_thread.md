# air-234 — Spec 146 phase 12: codev-client tiling, mobile, and the static mount

## Scope, and how it changed

The issue as spawned carried phase 12's plan (tiling, architect strip, paging, e2e) plus four
inlined items from #228. I flagged it as not fitting AIR before writing anything: three of the
four #228 items are named in that issue as **missing mechanisms rather than designs** — a
per-workspace t3 connection config Tower does not hold plus a staleness policy; a durable
asynchronous approval store and poll protocol; and `afx pair revoke` having to "work for someone
holding nothing", which is a security decision the issue poses and does not make.

The architect narrowed rather than escalating, splitting by ambiguity: **phase 12's plan plus
#228 item 1 (the static mount) only.** Items 2, 3 and 4 move to their own issue. The reasoning
was that the static mount is the highest-value unambiguous thing left, and putting it behind a
spec-and-plan cycle for three unrelated mechanisms would delay it for no gain.

I started the unambiguous half while waiting for that ruling rather than idling.

## The thing the plan did not have a source for

Criterion 4 asks each pane for "the last three agent messages" and 4b for the architect's last
one. **Nothing on the agent wire carried messages.** `thread-registry.ts` had no message field,
the snapshot had no source, and `packages/types` states "count only, never message bodies" for
the adjacent overview surface.

The only honest source is the **mailbox** (`db/mailbox.ts`) — the durable record of `afx send`
traffic, keyed by `(workspace_path, to_agent)`, retained past delivery by `pruneTerminal`. I
flagged it before building and the architect approved it with three conditions, all met:

1. **`truncated` reaches the UI**, not just the payload. A body cut at 240 chars renders with a
   `CUT` mark; `pane.test.tsx` asserts the marked and unmarked cases separately.
2. **Empty and unknown do not render alike.** `messageLog` on the snapshot mirrors `t3code`'s
   shape, and three absences get three different sentences — read, unreadable, and older-server.
   One test asserts the three texts are distinct rather than merely present.
3. **The payload cost is measured**, below.

Bodies stay on `/api/agent/v1/*`. The v2 and overview surfaces are untouched and stay count-only.

## Payload cost (#225 asked for this)

Measured against the real `~/.agent-farm/global.db`:

| Workspace | Live agents | Messages attached | Added |
|---|---|---|---|
| `codev-1455` | 4 | 6 | **2.2 KiB** |
| `entriq` | 2 | 5 | **1.7 KiB** |

The naive figure is much larger — attaching three messages to every agent that has ever received
one gives 56–81 KiB on these workspaces — but only identities present in the snapshot get
messages, and a workspace has a handful of live agents rather than 84 historical ones. The bound
is `live agents × 3 × ~360 B`, so ~22 KiB at twenty builders, against #225's 493 KiB snapshot.

## The column rule, and the CSS that gives the wrong answer

`repeat(auto-fill, minmax(340px, 1fr))` is the obvious spelling and **fails criterion 4**: four
340px columns fit in 1440 less padding, so six builders tile 4 + 2, not the 3x2 the spec names.
`auto-fill` maximises columns; the criterion wants something else.

First rule I wrote was near-square (`ceil(sqrt(count))`), which gives 3x2 at 1440 correctly. I
then looked at 1920 and it put seven panes into 3x3 — three columns of a five-column-wide screen,
with a last row holding one tile beside two tiles' worth of nothing. Changed to **fewest rows
that fit**: 6 at 1440 → 3 columns (unchanged), 7 at 1920 → 4 columns in two rows.

Both rules pass criterion 4. Only looking at the rendered page showed the difference.

## Two more things only visible by looking

- Six rows read `UNKNOWN` with **no stated cause anywhere on screen**. The tree states it once
  per machine (`sessionVisibility`); the grid had flattened machines away and lost the sentence.
  It is now stated once above the grid, deduplicated by cause.
- The architect strip carried a wall-clock timestamp that meant nothing. Removed.

## The static mount and its trust boundary

`servers/client-static.ts` mirrors `v2-static.ts` rather than generalising it, because they
differ in three ways that would all have become flags: `/v2/` injects Tower's shared key and this
must not, `/client/` sends `frame-ancestors` as a real header, and `/client/` answers a machine
list and proxies to those machines.

**The decision worth reading.** `/client/machines.json` and `/m/<id>/*` do not take Tower's
shared key. The client deliberately never receives it — that key cannot be revoked for one
machine without rotating it for all, so a page holding it would have Tower-wide access that
revoking a machine credential would not take away. The page carries per-machine revocable
credentials instead, which is the same trade `isCodevAgentRoute` already makes one prefix over.

The residual is stated in `isPublicRoute`: anyone who can reach Tower's port reads that machine
list. That is not a privilege this mount introduces — the same reachability already serves the
dashboard shell with the shared key injected into it, which reaches strictly more. The port's
exposure is the control, which is why the runbook puts `tailscale serve` in front of it rather
than binding 0.0.0.0.

Four machine-list problems answer four signals (absent / mode / unparseable / entry dropped),
because an operator who configured nothing and one whose file is mode 644 need opposite actions.

## Criterion 6 was NOT performed

"An iPad on the tailnet drives a builder to completion" is manual and I have no iPad. The runbook
is in `apps/client/README.md`, including the `tailscale serve --https=443 off` teardown. **It is
written and unexecuted, and the PR says so.** What is verified is that an 820px viewport (iPad
portrait) gets the grid rather than the paged layout and does not scroll sideways.

## Suites

All five, green: `packages/codev` unit (6,942 passed), its `vitest.e2e.config` (183), its
`vitest.cli.config` (90), `apps/client` unit (181), `apps/client` Playwright (22).

Two failures were mine and are fixed: `MESSAGE_LOG_UNREADABLE` needed a real matrix row in
`agent-failure.ts` with its own mutation-verified test, and the pager derived its bounds from the
tile list rather than the paged list, which made the last pane unreachable on a phone.

One failure was environmental: `bugfix-214-publish-scrub` fails until
`packages/artifact-canvas` is built, exactly as its own message says.

`e2e/two-machines.spec.ts` now opens `?view=tree`, because the grid is the default view and every
criterion in that file is about machine boundaries and connection bands, which only the tree
shows.

## 3-way review (PR #237)

`consult --type integration --issue 237`. My first three invocations died on a CLI mode conflict
(`consult` refuses `--prompt-file` with `--type`) and produced nothing — including codex, so I had
no evidence about its quota either way and said so rather than inheriting the assumption.

| Lane | Verdict | Confidence |
|---|---|---|
| claude (opus 5) | COMMENT | HIGH (raised from MEDIUM after it verified finding 1) |
| opencode (grok-4.6) | REQUEST_CHANGES | HIGH |
| codex (gpt-5.6-sol) | REQUEST_CHANGES | HIGH |
| gemini (agy) | **NO REVIEW** — lane skipped, `agy` exit 1, quota | — |

Two real verdicts plus a named absence. A skipped lane is not an approval.

### What they found, and what I did

**1. The client threw away Tower's configuration sentence.** (opencode, HIGH; the best catch of the
three.) The mount answers `{ signal, message, machines: [] }`; `loadMachines` accepted only a bare
array, so all four configuration signals arrived as the generic "machine configuration is not a
list of machines". And this is the **first-run path** — no `client-machines.json` is the normal
state of a fresh install, so the generic sentence was the message most operators would ever see
from the mount. The four-signal design died one layer below where I tested it.

Fixed in `config.ts`, which now reads the envelope and shows the server's words; the bare array
still works for the dev server and `scripts/serve.mjs`. Four unit tests plus a Playwright test that
asserts the sentence reaches the page and the generic one does not.

**2. The README's tailnet runbook does not work, and duplicated one that does.** (claude verified
it against `codev/experiments/39-https-on-a-phone/notes.md:17,46`; codex flagged it
independently.) `isAllowedHost` accepts loopback or hostnames in `CODEV_TOWER_ALLOWED_ORIGINS`; a
MagicDNS `.ts.net` name matches neither, so my three-command recipe ends at a rejected Host.
`codev/resources/146-remote-access-runbook.md` — the canonical runbook for this same spec — already
carries the missing `export` and `afx tower restart`, and the reason the omission is hard to
diagnose. The README section now links it and states why it does not repeat it.

**3. An `https://` machine origin was reported as a dead machine.** (claude and codex.)
`proxyToMachine` was `http.request` unconditionally; `new URL('https://host').port` is `''`, so it
dialled port 80 in cleartext and failed as `UPSTREAM_GONE` — a configuration mistake spelled as a
down host, the exact conflation this PR's comments spend their time avoiding. The proxy now picks
its module from the scheme. Codex added the other half: plaintext `http://` to a **non-loopback**
host would put a machine credential on the wire, against the spec's "all remote transport is
HTTPS/WSS" (spec:368). That is now refused with `MACHINE_ORIGIN_REFUSED`, 400, before anything is
dialled.

**4. `isPublicRoute`'s docstring had become false.** (claude.) It still read "Everything else
requires the key" directly above an all-methods `/m/*` branch. Corrected, and the correction says
which sentence went stale and why, since that is the paragraph the next reader trusts.

**5. Bare `/m`, `/m/` and `/m/<id>` returned the SPA shell.** (claude.) They missed the proxy regex
and fell into the extensionless fallback, so a machine request got HTML with a 200. Now 404.

**6. `client-dist` had no `npm pack` assertion** while `v2-dist` has had one since D14. (opencode.)
A `files` entry that resolves to nothing is silently absent from the tarball, which is how a mount
that works from a checkout ships broken. Added beside the v2 one.

**7. Grid/Tree did not write `?view=`.** (opencode.) A link could open the tree, but clicking to it
and copying the address gave the grid — the view you were looking at was not the view you shared.
`replaceState`, so Back leaves the client rather than walking a toggle history.

**8. The message-body boundary was held by one call site.** (claude, offered as follow-up; cheap
enough to do now.) `readThreadRegistry` has exactly one production caller, which is a convention,
and a convention is what the next person adding a convenient field will not know about. There is
now a test that builds the v2 projection over a workspace with a full mailbox and asserts the
serialised payload contains neither the bodies nor a `messages` key — and asserts the agent surface
DOES carry them, so it cannot pass by nothing having been written.

### What I did not do

**Criterion 6 stays unmet.** Codex asked for the iPad run to be completed or the plan amended
before merge. I cannot complete it and amending an approved plan is not mine to do. The architect's
ruling stands: recorded unmet, with the runbook and its teardown both marked unexecuted.

**`/m/<id>/*` still proxies any path on the configured origin** rather than only `/api/agent/v1/`.
(opencode, integration note.) Narrowing it is defensible and I have left it, because the machine
list is hand-configured today and the origins in it are the operator's own agent hosts; the
reachability argument in `isPublicRoute` covers it. Worth revisiting when `afx pair` lands and the
list stops being hand-written.

**No WebSocket upgrade handling on the proxy.** (claude, integration note.) The agent surface is
HTTP and SSE today. Noted rather than built.

## The gap the reviews exposed in my own testing

Every one of findings 1, 3 and 5 was reachable from the code I wrote and invisible to the tests I
wrote, because I tested `serveClientStatic` directly and `loadMachines` against shapes I had
already decided were the shapes. Before the reviews landed I had also added
`spec-146-phase-12-client-mount.e2e.test.ts`, which binds a socket and drives the mount through
Tower's real dispatcher with `isRequestAllowed` in front — that is what would have caught 5, and it
did catch that a traversal escaping `/client/` is refused by the allowlist rather than the mount.
It did not catch 1, because the client half was never in the loop. The Playwright test added for
finding 1 closes that.

## Round 2 — the architect read the diff

**Fixed before merge: the proxy forwarded all client headers verbatim, with no upstream bound.**

Three defects in one call site, and the first is the interesting one:

`codev-tower-key` was forwarded to a remote machine if a client sent it. Nothing is known to leak
today — `/client/` injects no key, which is the mount's whole posture — so this is defence in depth
rather than a live hole. It is worth fixing anyway because **"the browser should never have that
header" is the same assumption phase 11 shipped on and had to retract.** If any future page,
extension, or hand-written client attaches it, this proxy would have handed Tower's all-or-nothing
secret to a remote host over the wire. The fix is one filter.

Hop-by-hop headers (`Connection`, `Transfer-Encoding`, `TE`, `Upgrade`, and the rest) were also
forwarded. They describe *this* connection, not the message; forwarding them lets a client dictate
framing on a socket it does not own, which is the shape of request-smuggling bugs. `Connection`'s
own listed tokens are stripped too, since honouring only the fixed list forwards whatever it points
at.

And there was **no upstream timeout**. A machine that accepts a socket and never answers held a
Tower request open forever — an availability hole on Tower's own event loop, reachable by pointing
a machine entry at a black hole. The bound is on **response headers only** (15s): an SSE stream is
meant to stay open for hours, and a total-duration timeout would sever the connection this whole
client is built around. It answers `UPSTREAM_TIMEOUT`, not `UPSTREAM_GONE` — "refused the
connection" and "accepted it then went quiet" are different facts wanting different next actions.

Tested both ways: `forwardableHeaders` directly, and — the assertion that survives someone
reverting the call site — over real HTTP, asserting on what the **upstream received**. The key is
presented to Tower and does not arrive at the machine; the machine credential still does.

### Filed, not fixed (#239)

The architect asked for these to be written down rather than folded in.

1. **`recentByAgent` query cost.** I had measured payload and not query. Now measured: **2.36 ms**
   per snapshot tick at 1,250 workspace rows, **2.88 ms** at 1,424, against the real global.db.
   `EXPLAIN QUERY PLAN` uses `idx_mailbox_agent_drain` for the `workspace_path` prefix but the
   window function's partition ordering cannot ride it, so every workspace row is read into two
   temp B-trees to yield three rows per agent. Small, on the event loop, per tick, and growing with
   retention rather than bounded.
2. **Machine-id validation is split** — `wellFormed` on the server, `isMachine` on the client — so
   the server can publish ids the client silently drops. The silence is the defect; two validators
   across a wire is normal, one discarding the other's output without either saying so is not.
3. **The mount e2e copies `tower-server.ts`'s handler ordering** rather than importing it. Two
   encodings of one rule with nothing keeping them equal: if Tower moves the allowlist inside the
   handler, the test keeps passing against a Tower that no longer exists — which is the exact
   failure the test was written to close, and what bit #221 twice.

### Lane verdicts, unrounded

All four run as `consult --type integration --issue 237`, against `a79b965e4`.

| Lane | Model | Verdict | Confidence |
|---|---|---|---|
| claude | claude-opus-5 | COMMENT | **HIGH** (revised up from MEDIUM after it verified its own finding against experiment 39) |
| opencode | xai/grok-4.6 | REQUEST_CHANGES | HIGH |
| codex | gpt-5.6-sol, medium effort | REQUEST_CHANGES | HIGH |
| gemini | agy default | **NO REVIEW** — `[gemini (agy) skipped: agy exited with code 1]` | — |

I had first reported gemini's skip from a general-mode invocation; I re-ran the integration lane so
the record is like-for-like, and it printed the identical skip.

**Codex's REQUEST_CHANGES was not only criterion 6.** It raised four: criterion 6 (ruled), the
Host-guard runbook (fixed), the http-only proxy plus cleartext credentials against spec:368
(fixed), and tests never exercising the production remote path (fixed by the mount e2e). Three of
four were code.
