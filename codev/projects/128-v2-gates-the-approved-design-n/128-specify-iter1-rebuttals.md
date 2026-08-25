# Spec 128 — iteration 1 rebuttal

## Review disposition

The two REQUEST_CHANGES reviews identified real ambiguity in the draft. The spec has been revised
in place. The opencode lane approved with one scope clarification, which is also incorporated.
Gemini did not review because its lane was quota-skipped; no substantive Gemini feedback exists to
address.

## Codex REQUEST_CHANGES

1. **Visual contract contradicts repository fonts and rust usage — clarified, with the architect's
   explicit direction retained.** The spec now acknowledges that the older mockup/tokens name IBM
   Plex Sans and that the mockup uses several direct rust utilities. The architect explicitly
   directed this project to use Fraunces / Space Grotesk / IBM Plex Mono and exactly one direct
   `var(--rust)` reference in `.stamp-gate`; that newer project direction is controlling. The spec
   makes the implementation consequence testable: other gate accents may use `currentColor`, and
   the existing second direct rust reference must be removed rather than copied.

2. **Card surface unspecified — fixed.** The spec now states that no gate card currently exists.
   A gate-waiting builder row is the accessible pointer/Enter/Space entry point; selection is local
   page state; Back returns to the site; a removed or no-longer-gated node auto-closes the detail.
   Visual scope is the ticket heading plus question, last-output, and choice panels. The queue rail,
   global controls, unavailable metadata, decorative choice icons, and decision bar are explicitly
   excluded and not stubbed.

3. **Builder authoring contract missing — fixed.** The observable CLI is now
   `porch gate <id> --request-file <path>` with a UTF-8 JSON GateRequest. Replacement, identical
   retry idempotency, flag-free preservation, invalid-input behavior, approved/non-current
   rejection, approval history, and rollback clearing are specified.

4. **Unbounded persisted content — fixed.** The spec sets UTF-8 limits for question, label,
   consequence, terminal excerpt, and whole request. Any exceeded bound rejects the entire request
   before persistence.

5. **Untrusted display data — fixed.** The spec requires trimming, CRLF normalization, ANSI
   stripping, control and bidi rejection, literal React/pre rendering, no HTML/Markdown/active
   links/label-derived icons, and hostile-string tests. Warning coloring is based only on a literal
   leading warning glyph and never interprets markup.

6. **“Currently pending” ambiguous — fixed.** `blockedGateRequest` must come from the exact same
   gate entry selected by the existing `blockedGate` algorithm: canonical order, pending status,
   and `requested_at` present. Historical, unrequested, or later entries cannot leak content.

## Claude REQUEST_CHANGES / should-fix items

1. **No existing gate surface — fixed** by the same explicit detail-mode contract above. The old
   erroneous “current name-only fallback” wording is gone; this project adds an explicit
   compatibility state.

2. **Rust criteria mutually unsatisfiable — clarified.** The spec scopes fidelity to the content
   slice and records that the architect's newer one-reference constraint supersedes repeated rust
   utilities in the older HTML. `currentColor` permits same-surface semantic accents without a
   second token reference.

3. **Terminal bounds and safety absent — fixed** with ingress normalization/rejection, byte caps,
   literal rendering, and warning-line behavior.

4. **Serialization casing undecided — fixed.** GateRequest is camelCase across JSON, nested YAML,
   shared TypeScript, and wire. Only the containing legacy gate timestamps remain snake_case.

5. **Rollback/approval behavior contradicted current code — fixed as a required target behavior.**
   Approval preserves request history while hiding it from the active wire projection; rollback
   clears it as part of a fresh cycle. The current object-replacement sites are implementation work,
   not evidence that the desired lifecycle should remain undefined.

6. **Client wire validation unspecified — fixed.** A malformed request invalidates the enclosing
   node frame and enters Spec 83's visible contract-mismatch state; only absence maps to `null`.

7. **Mockup contract wider than data contract — fixed.** The exact accepted slice is named. The
   existing node's `lastDataAt` supplies the terminal timestamp when present. Choice-specific icons
   are deliberately not inferred. Queue, decision controls, and unavailable metadata are out.

8. **Entry point/input encoding unnamed — fixed** with the request-file CLI and gate-row detail
   entry described above.

9. **Parity wording assumed both trees always contain a local protocol — fixed.** Parity is required
   wherever both framework copies exist; runtime-resolved protocols are not copied into `codev/`
   merely to manufacture a comparison.

## Opencode APPROVE note

The requested distinction is incorporated: success and visual criteria name only the ticket
heading plus question/output/choice content. The queue rail and decision bar are explicitly out;
the latter would violate the non-negotiable terminal-only human approval rule.
