# Phase 1, iteration 3 — rebuttals

gemini reported `LANE_DID_NOT_REVIEW: true` rather than a silent pass — worth recording as the
counter-example, since it is the machinery doing the right thing under the same conditions that
produced ten failures elsewhere in this phase. codex and claude both REQUEST_CHANGES, and between
them found two safety defects and one that would have broken Phase 2.

## The one that would have broken Phase 2

**Finding (claude):** the emitted schema carries `additionalProperties: false` on 239 nodes while
t3code decodes with Effect's default `onExcessProperty: "ignore"`, so `shapeCheck` rejects payloads
the server accepts — the inverse of the invariant stated in `shape-check.ts`, `index.ts` and
`LOSSY.md`, and recorded nowhere.

**Verified against both sides.** 239 nodes confirmed by counting the emitted document;
`SchemaAST.ts:446` confirms `"ignore"` is Effect's default and that the server *strips* unknown
keys rather than rejecting them.

**This is the sharpest finding of the phase**, because it would have failed on exactly the change
class my own churn classifier labels **non-breaking**: an additive upstream field. Phase 2's
inbound decode would have rejected a payload the server legitimately sent, and the classifier
would have said that upstream change was safe.

The documentation problem underneath it is worse than the code problem. Three files said "lower
bound", and that was half the truth — **the comfortable half**. It described the divergence that
makes the tool look cautious and omitted the one that makes it look broken. Nobody asked me to
write only the flattering direction; I did it by describing the property I had reasoned about
rather than the one I had measured.

**Fixed:** excess properties are ignored by default, mirroring the decoder. `{ excess: 'error' }`
opts into strictness, appropriate for payloads Codev constructs and never for inbound ones. All
three documents now state both directions. Tests assert both.

## Two safety defects

**Finding (codex): `stop` SIGTERMs every process on the port when there is no PID file, which can
kill an unrelated service.**

**Correct, and it is the same shape as the secrets incident.** I wrote that sweep to fix a real
bug — the recorded PID is the `npx` wrapper and the server is its grandchild, so the port stayed
bound — and I bounded it by *the failure I had just seen* rather than by *the set of things it
could touch*. Both that and `git add tools/t3-server/` were written from a symptom outwards.

Ownership is now proven from the command line before any signal is sent. Anything unprovable is
reported with its PIDs and a suggestion to move the port, and left alone. A refusal that names
what it will not do is more useful than a kill that succeeds.

**Finding (codex): the pairing token is written to `server.log` and read back, contrary to the
spec's "never written to a log".**

**Correct — a direct constraint violation.** t3 prints the token on stdout and the harness sends
stdout to a file. The log is now redacted the instant `ready()` reads the token, and created
`0600`. Verified after a live run: 0 raw tokens, 1 redaction marker.

The residual window — from the server printing it to `ready()` redacting it, a few seconds — is
**documented rather than closed**, because closing it means not persisting stdout at all, and that
log is what made three separate harness bugs findable. Stated as a trade, not hidden as an
oversight.

## The loss detector's blind spot

**Finding (codex): the heuristic misses `ModelSelectionSource`, whose model fields become `{}`.**

**Correct, and the mechanism is precise.** The detector walks `export const` declarations;
`ModelSelectionSource` is declared `const` with no export, so it was invisible. Its fields emit as
bare `{}` — no constraints at all, accepting any value — which is a *stronger* loss than
`{"type":"string"}` and was absent from `LOSSY.md` entirely.

**Fixed by changing what gets scanned, not by adding a case.** A new pass walks the *emitted
output* rather than the source symbols, so loss is caught wherever it originates including from
symbols the source scan cannot name. It found **18 unconstrained positions**.

The general form is worth keeping: *a detector that reads the input to a transform is only ever as
complete as its model of that input; reading the output measures the thing you actually care
about.*

## Direction-blindness in the churn classifier

**Finding (codex): `classifyChange()` applies the same rules to inputs and outputs.**

**Correct.** For an input, a narrowed type or a newly-required property breaks us. For an output,
a *widened* type or a no-longer-guaranteed property does. I applied input rules to both.

Now direction-aware. **The counts did not move** — still 0 breaking, 3 non-breaking, 18
undecidable — and that does not vindicate the old rules. They were wrong where they happened to be
right, and "same answer" is not evidence of the same reasoning.

## Evidence-asserting tests

**Finding (codex, and the architect in iteration 1): tests assert committed evidence JSON, so
stale or fabricated evidence stays green.**

**A fair objection twice over, and I only half-addressed it the first time.** Running a live
server inside a Node 20 unit suite is the wrong place for it, and forcing it there would trade one
dishonest signal for another.

What the suite can do is refuse evidence that has outlived the code it describes: the test now
fails if `t3-server.mjs` or `smoke.mjs` is newer than the recorded run. **I verified it fires
rather than assuming** — it failed against my own harness edit, which is why the cold-start proof
was re-run. Both runs pass against the fixed harness.

## Recorded as checked, not adopted

- **"The live suite should report skipped-for-no-SERVER"** (codex). It is named
  `[live: needs t3code checkout at <path>]` and verifies hashes, which need a checkout and not a
  server. The name states its actual dependency. A server-dependent suite belongs to Phase 2, when
  Phase 2 has something that needs one.
- **`UNREPRESENTED.md` should cover every closure schema** (codex). It states its scope explicitly
  — the consumed roots plus everything the loss scan reaches. Widening it to every export in the
  closure would list schemas nothing imports, which is noise that dilutes the entries that matter.
- **`dist/t3/index.d.ts` references `./generated/types.js`** (claude, marked latent). Real but
  inert: the `types` condition resolves from `src`. Left for whoever builds the package for
  publication, since fixing it now means changing the build without being able to test the
  published artifact.

## Status

49 spec-146 tests pass. The `npx` gap remains recorded as partially-met and carried into Phase 2's
entry conditions. The CI drift gap is tracked as #152.
