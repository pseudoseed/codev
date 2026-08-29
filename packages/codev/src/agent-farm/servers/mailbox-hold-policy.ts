/** Recovery policy for render-gate holds that cannot change on an idle screen (#92). */

import { CLEAR_DRAFT_BYTES, INTERRUPT_BYTES, type ClearDraftKey } from '../utils/harness.js';

export type HeldRecoveryAction = 'cancel-draft' | 'escape-screen';

/**
 * Return the one safe bounded recovery for a sustained gate detail.
 *
 * `busy-indicator` is deliberately absent: it proves a live turn, so touching it
 * would corrupt active work. Unknown/no-session holds also need an external state
 * change rather than a guessed terminal keystroke.
 *
 * `geometry-mismatch` is absent for TWO reasons (Issue #197). They are INDEPENDENT, and
 * either one alone is sufficient — so disproving one does not restore ESC. Do not treat
 * either as the "real" reason with the other as support.
 *
 *   1. FUTILITY — a keystroke cannot fix it, ever. The mirror is the wrong SIZE for the
 *      grid the agent paints at, and no byte sent to the agent resizes Tower's mirror. ESC
 *      here was a no-op dressed as a repair. This holds even for a provably idle agent.
 *   2. DANGER — it cannot be shown to be safe. Every liveness proof the gate has, the
 *      profile's `busyIndicatorPattern` above all, is read off the SAME frame whose geometry
 *      we have just declared untrustworthy. Measured on a real mid-turn opencode capture: at
 *      its 110x32 capture geometry it classifies `busy-indicator`; on an 80x24 mirror the
 *      reflow carries the `esc interrupt` footer off-screen, the busy signal vanishes, and
 *      the same live turn classifies `geometry-mismatch`. Ordering the busy check first does
 *      NOT rescue this — the proof is destroyed, not outranked. This holds even if a
 *      keystroke could help.
 *
 * It therefore holds with no keystroke and escalates instead — see `isClassifierStuck`,
 * which lists it so the hold is loud rather than silent. Removing the action WITHOUT that
 * listing would trade an unsafe act for an invisible starvation, which is the worse bug.
 * The honest remedy is realigning the mirror, which is Tower's job and not the agent's.
 */
export function heldRecoveryAction(detail: string | null | undefined): HeldRecoveryAction | null {
  if (detail === 'user-text') return 'cancel-draft';
  if (detail === 'no-region-end' || detail === 'no-composer-marker') {
    return 'escape-screen';
  }
  return null;
}

/**
 * The control byte for a recovery action, or `null` when this harness has none.
 *
 * `escape-screen` is ESC on every harness — it repaints or ends an unreadable screen and
 * is safe everywhere. `cancel-draft` needs the harness's own clear key, because the
 * obvious byte is not portable: Ctrl+C clears the composer on claude and codex, but
 * opencode binds Ctrl+C to `app_exit` as well as `input_clear` and quits (Issue #196).
 *
 * Returning `null` is a first-class outcome, not a failure to decide: this recovery fires
 * AUTOMATICALLY after the #92 starvation window with no operator in the loop, so a harness
 * with no known safe clear must produce NO byte, and the caller must report the hold as
 * unrecoverable. A recovery that cannot succeed must not be spelled the same as one that
 * has not succeeded yet.
 */
export function heldRecoveryKeystroke(
  action: HeldRecoveryAction,
  clearDraft: ClearDraftKey,
): string | null {
  if (action !== 'cancel-draft') return INTERRUPT_BYTES.esc;
  return clearDraft === 'none' ? null : CLEAR_DRAFT_BYTES[clearDraft];
}
