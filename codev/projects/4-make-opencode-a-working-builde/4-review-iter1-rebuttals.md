# PIR #4 — Rebuttal, review iteration 1

Verdicts: gemini **APPROVE** (HIGH) · claude **REQUEST_CHANGES** (HIGH) · codex **SKIPPED /
NOT RUN** (quota exhausted; see `4-review-iter1-codex.txt` — that file records an absence, not
a review).

No point below is disputed. The one blocking finding was real, I verified it against the file
rather than taking the summary on faith, and it is fixed.

---

## BLOCKING — claude: README documents a builder config the new pre-flight hard-fails

> `README.md:460–485` documents a **supported** recipe for running gemini as a **builder** via
> a custom harness (`shell.builder: "gemini --yolo"` + `builderHarness: "gemini"`). After this
> PR that configuration hard-`fatal`s. Shipping a doc/code contradiction in the PR whose
> purpose includes fixing a doc/code contradiction (`opencode run`) is the thing to fix.

**Accepted. Verified, then fixed.**

Verified against the file and the code path rather than the summary:
`getResolvedCommands(root).builder` → `"gemini --yolo"` → `hasGateProfile` →
`detectHarnessFromCommand` → `'gemini'` → absent from `PROFILES_BY_HARNESS` → `null` → `fatal`.
The PR's own test already asserted `hasGateProfile('gemini') === false`, so the contradiction
was self-evident once pointed at. The reviewer's characterization is exactly right: this PR
exists partly to kill a doc/code contradiction, and was about to ship another one 60 lines
below the section it edits.

Changed:

1. `README.md` — the custom-`gemini` escape hatch is now scoped to **`architectHarness`**, and
   the example config uses `architect` / `architectHarness` rather than `builder` /
   `builderHarness`. Added a call-out block stating plainly that gemini is no longer usable as
   a *builder*, why (no measured gate profile → `afx send` could never deliver → the spawn
   aborts up front rather than producing an unmessageable builder), that there is no bypass
   flag, that the remedy is to measure a profile, and that this applies to any custom builder
   harness rather than gemini specifically. Architects are explicitly noted as unaffected —
   they take no gated mail.
2. `spawn-gate-profile.test.ts` — new case `rejects gemini-as-builder — the documented
   custom-harness recipe is architect-only now`, which writes that exact documented config
   (`shell.builder: "gemini --yolo"` + `builderHarness: "gemini"` + the custom `harness.gemini`
   block) into a real temp workspace and asserts the real `spawn()` rejects it with
   `/has no render-gate profile/` and leaves no worktree or porch state. The docs and the
   pre-flight can no longer drift apart silently — which is the actual fix, since the doc edit
   alone would rot.
3. The review file's BREAKING CHANGE section now names this specific recipe instead of only
   describing the break generically.

---

## Non-blocking — claude 1: the self-reference wart belongs in "How to Test Locally"

> `busyIndicatorPattern` is matched screen-wide, so an opencode builder whose viewport displays
> `esc interrupt` — e.g. while reading `gate-profiles.ts` or the fixtures — holds its mail
> until that scrolls off. The human's manual test step 2 can legitimately return `held`.

**Accepted.** This is a good catch about the *review*, not the code: the wart was documented in
`gate-profiles.ts` but the human verifying at the gate would have hit it without warning and
reasonably read a `held` as a defect. Added to the review's "How to Test Locally" as one of two
expected-`held` cases.

No code change. The screen-wide match is deliberate — it only ever over-holds, and narrowing it
to the footer would trade a safe failure for a less safe one to fix a cosmetic annoyance.

## Non-blocking — claude 2: first-turn hold

> `idleIndicatorPattern` only appears after a completed turn, so a builder holds mail until its
> `--prompt` turn finishes.

**Accepted, same treatment.** Correct and already intended (it is why `opencode-boot.busy.txt`
is a committed fixture), but it is another expected `held` during manual verification. Added
alongside the above, with the remedy: wait for the seeded turn to return, then send.

## Non-blocking — claude 3: `treatDimAsPlaceholder` default

> I'd keep the compatibility default; forcing every profile to opt in is a separate change.

**Agreed, no change.** I had flagged the default as arguable in "Things to Look At" and the
reviewer landed on the same answer I did. Defaulting `true` keeps claude/codex/agy
byte-identical; flipping it to fail-safe would change three measured profiles' behavior in a PR
about a fourth. Left as a noted, deliberate choice.

## Non-blocking — claude 4: pre-existing `'${promptFile}'` shell-escaping gap

**Agreed, correctly scoped out.** `spawn-worktree.ts` interpolates the prompt path into the
generated script single-quoted without `shellEscapeSingleQuote`, so a worktree path containing
an apostrophe breaks the script. Pre-existing, untouched by this diff, and noted in the review's
"Things to Look At" for whoever picks it up.

---

## gemini — APPROVE, no changes requested

Verdict recorded; no actionable points.

## codex — did not run

Quota exhausted for the duration of this project (restores 2026-08-27), retried twice. Skipped
on explicit human instruction rather than block a fork-local change for six days. **No codex
findings exist for this change**, and the PR body leads with that caveat plus a lane table, so
the reduced coverage is visible to anyone reading the merge rather than buried in this
directory.

---

## Verification after the changes

- `npm run build` ✓
- `npm test` ✓ — 5328 passed, 48 skipped, 0 failed
- `spawn-gate-profile.test.ts` ✓ 6 tests (was 5)
- PR body refreshed on #7
