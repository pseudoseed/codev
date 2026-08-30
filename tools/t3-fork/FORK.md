# The private t3code fork

Spec 250. `t3code` is the front end; Codev integrates with it. Every change we make to
t3code is a **private customization** — it does not go upstream to `pingdotgg/t3code`, and
we do not ask for their buy-in.

## The two checkouts

| | Upstream | Fork |
|---|---|---|
| Repository | `https://github.com/pingdotgg/t3code` (public) | `https://github.com/pseudoseed/t3code` (**private**) |
| Branch | `main`, read-only | `codev` |
| Checkout | `/Users/chris/dev/t3code` | `/Users/chris/dev/t3code-codev` |
| Env override | `T3CODE_ROOT` | `T3CODE_FORK_ROOT` |
| Pinned to | `pin.upstreamBase` | `pin.commit` |
| Written to by us | **never** | yes, one commit per plan phase |

The fork's remotes: `origin` is the private repository, `upstream` is `pingdotgg/t3code`.

## Why it is a created repository and not a GitHub fork

`gh repo fork` was not used and must not be. **A GitHub fork inherits the visibility of the
repository it forks**, so forking a public repository cannot produce a private one. The
repository was created with:

```bash
gh repo create pseudoseed/t3code --private
```

and the history was pushed into it. `gh repo view pseudoseed/t3code --json visibility` reports
`PRIVATE` and `isFork: false`; that is asserted rather than inferred from the create command
having exited zero.

The MIT `LICENSE` and its attribution travel with the copy, unmodified.

## Why the upstream clone must never move

Every piece of spec 146 and spec 236 evidence — the cold-start runs, the recorded source
hashes, the live contract suite — reproduces against `/Users/chris/dev/t3code` at
`upstreamBase`. Moving it off that commit does not break a test; it makes recorded results
unreproducible while every test still passes.

That is why `t3-server.mjs`'s `acquire`, `start` and `status` are pinned to `upstreamBase`
rather than to `pin.commit`. `acquire()` runs `git checkout --detach` against the upstream
clone, and both `smoke.mjs` and `packages/t3-client/live/integration.mjs` call it, so an
ordinary test run would have written a fork sha into the read-only clone the moment
`pin.commit` diverged.

## Which tool reads which checkout

| Reader | Identity | Why |
|---|---|---|
| `tools/t3-server/t3-server.mjs` | both | it is the verifier; `verify` asserts each, other verbs are upstream-only |
| `tools/t3-codegen/generate.mjs` | fork | generation is fork-sourced from phase 5; also hashes upstream for comparison |
| `tools/t3-codegen/classify-churn.mjs` | both | one identity per mode, and the mode is mandatory |
| `tools/t3-codegen/transform-blindness-probe.mjs` | fork | it probes what we emit |
| `tools/t3-server/smoke.mjs` | upstream | keeps the spec 146 cold-start evidence reproducible |
| `packages/t3-client/live/integration.mjs` | upstream | spec 146 / #241 live tests, meaning unchanged |
| `packages/codev/src/__tests__/spec-146-t3-contract.test.ts` | both | upstream suite asserts upstream, fork suite asserts fork |

The mapping is resolved in one place, `tools/t3-fork/identities.mjs`. Nothing re-derives it.

## Verifying

```bash
node tools/t3-server/t3-server.mjs verify
```

Exit `0` with both checkouts clean on their pins. Exit `1` names which identity failed. Exit
`3` is "could not determine" — a missing checkout, an unreadable HEAD, an unresolvable
merge-base — and it is never spelled the same way as `1`.

`verify` also asserts `git merge-base <commit> <upstreamBase> == <upstreamBase>`. A rebase or
a squash that drops the base leaves a fork that is clean at a commit nothing can be measured
against, and without that check it verifies green.

## Phase log

| Phase | Fork commit | What landed |
|---|---|---|
| 1 | `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6` | Branch `codev` created at `upstreamBase`. No customization yet — the two identities exist and are equal on purpose, so every new assertion has a known answer. |
