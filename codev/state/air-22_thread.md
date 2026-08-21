# air-22 — Add opencode as a consult lane (Grok)

Issue #22. AIR protocol, strict mode.

## Live probes before writing code (2026-08-21)

Everything below was run against the real `opencode` on this machine (v1.18.18),
not inferred:

- `opencode run -m xai/grok-4.6 "…"` → exit 0, **clean plain-text stdout**, the
  `VERDICT: APPROVE` line survives verbatim. Progress/banner noise goes to stderr.
  So `parseVerdict` needs no change — confirmed rather than assumed, per the issue.
- `opencode run -m x-ai/grok-4.6 "…"` → exit 1, **empty stdout**, stderr carries
  `UnknownError: Unexpected server error`. Provider gives no usable hint that the
  prefix is wrong, which is exactly why the lane pre-validates.
- `opencode models` → 19 ids, authoritative and live (`xai/grok-4.6`, `xai/grok-4.3`, …).
  That is the catalog to validate against.
- Agentic file reads work with no `--auto` and no extra flags, cwd = workspace root.

## Design decisions

**Pre-flight model validation against `opencode models`, not a hardcoded list.**
`consult-lanes.ts` opens with an explicit rule: model ids are never validated
against a local catalog, because a catalog goes stale the day a provider ships a
model. That rule is about *hardcoded* catalogs. `opencode models` is the provider
tool answering for itself at call time, so it is the same authority the rule
defers to — just reachable before the spawn instead of after. Validating there
lets `x-ai/grok-4.6` be rejected by name with the right prefix, which the
provider's own `UnknownError` never does.

**The lane hard-fails; it does not skip.** The gemini/agy lane degrades to a
non-blocking COMMENT skip because it is OAuth-fragile. opencode has no such
property, and #20 is the standing evidence that a lane which produces nothing
gets counted as an approval. So: unknown model, missing CLI, non-zero exit, or
empty output all throw.

**Default model `xai/grok-4.6`** — the whole point of the lane is a reviewer on a
different account from every existing one, and 4.6 is the strongest Grok listed.

## What changed

- `consult-lanes.ts` — `opencode` joins `VALID_LANE_NAMES` and `MODEL_CONFIGURABLE_LANES`;
  new pure `assertOpencodeModelAvailable(id, available, key)`.
- `consult/index.ts` — `MODEL_CONFIGS.opencode`, `DEFAULT_OPENCODE_MODEL`,
  `resolveOpencodeBin()`, `listOpencodeModels()`, `opencodeReviewHeader()`,
  `runOpencodeConsultation()`, plus dispatch and the file-access hint.
- `test-env.ts` — `assertOpencodeLaneAllowedUnderTest()`. Not incidental: without it a
  suite that forgets to pin `CODEV_OPENCODE_BIN` bills a real Grok call per spawn. The
  agy lane already had exactly this guard for exactly this reason (#1323).
- Docs: `resources/commands/consult.md`, the consult SKILL (4 byte-identical copies),
  CLAUDE.md + AGENTS.md, and the `protocol-schema.json` lane enum — which was missing
  `hermes` too, so it now lists every lane `VALID_LANE_NAMES` accepts.

`codev doctor` already probed for OpenCode as an AI CLI dependency. Nothing to add there,
and further evidence for the issue's read that the lane's absence was an oversight, not a
decision.

`porch/next.ts` needed no change — it iterates whatever lanes are configured rather than
matching against a hardcoded list, so `opencode` in `porch.consultation.models` works.

## End-to-end verification (the issue asks for this explicitly, not unit tests alone)

Real `opencode`, real Grok, built CLI:

- `consult -m opencode --prompt "…"` → exit 0, 36.3s, review written. Fed the resulting
  file to porch's own `parseVerdict` → `APPROVE`. The banner opencode writes to stderr
  stays out of the review; the model provenance line is at the top and carries no
  `VERDICT` token, so it cannot shadow the real verdict (which is found last→first).
- `consult -m opencode --model-id x-ai/grok-4.6` → exit 1, and the message names
  `xai/grok-4.6` as the id meant, lists the machine's real catalog, and says Codev does
  not fall back.

## Defaults left alone

`porch.consultation.models` still defaults to `["gemini", "codex", "claude"]`. Changing the
default rotation is an architectural call the issue does not make, so opencode is available
but opt-in.

## The lane found a real bug in itself, on its first run

CMAP on PR #24 came back: claude=APPROVE, opencode=COMMENT, codex=quota-blocked
(resets Aug 27), gemini=skipped (agy exited 1, which emits the non-blocking COMMENT
that `allApprove` counts as an approval — #20, live, in the review of the PR about #20).

The opencode lane's finding, verified before acting on it:

    parseVerdict('ok')          -> REQUEST_CHANGES
    parseVerdict(header + 'ok') -> COMMENT           // header is 76 chars

`opencodeReviewHeader` — the provenance banner added to satisfy the issue's "record
which model the lane used" — lifts a short verdict-less review over `parseVerdict`'s
50-character floor. REQUEST_CHANGES becomes COMMENT, and COMMENT counts as approval.
The PR that claims to reduce #20's blast radius was opening a fresh #20 hole.

**The deeper point, which the architect named and which belongs in the PR body:** the
50-char floor is a *proxy* — length standing in for "a review actually happened". It was
never measuring the right thing. It held by luck, and any lane prefixing provenance, a
banner, a model id or a timestamp defeats it. My header did not break a working guard; it
exposed one that was already wrong. Anyone "fixing" this by bumping 50 to 100 reintroduces
it with the next slightly longer header.

Fix: extract `findVerdict()` from `parseVerdict()` — it returns the verdict a review
*states*, or `null`. That is the distinction `parseVerdict` structurally cannot express
(a stated COMMENT and no verdict at all return the same value), and it is the same
distinction #20 needs. Whoever picks up #20 should reuse it rather than write a second one.
The lane then hard-fails a protocol-mode review with no verdict — a reviewer that produced
output but no verdict has not reviewed. General mode (`--prompt`) is exempt: a question is
not a review.

Worth stating plainly rather than hiding: a lane approving the PR that adds it is weak
evidence. A lane finding a real defect in its own implementation, in the exact failure
class the PR exists to reduce, is much stronger — and stronger than an APPROVE from it
would have been.

Also fixed from claude's review: a stale `CODEV_OPENCODE_BIN` said "install opencode"
instead of naming the override; `listOpencodeModels` now keeps only `provider/model`-shaped
lines, so a future decorated listing degrades to "catalog unreadable" (provider stays the
authority) instead of turning a valid id into a hard failure; tests added for the
large-prompt temp-file branch; `persistent-output.test.ts` and `lane-models.test.ts` lane
loops extended.

## Flaky tests

`src/terminal/__tests__/session-manager.test.ts > auto-restart logic > respects maxRestarts
limit` timed out once in the full run (5533 passed / 1 failed), while I had two vitest
suites running concurrently. Passes standalone: 91/91 in 28s. Timing-sensitive under load,
unrelated to consult. Not skipped — a test that passes cleanly on its own should not be
annotated away.
