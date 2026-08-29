/** Recovery policy for render-gate holds that cannot change on an idle screen (#92). */

export type HeldRecoveryAction = 'cancel-draft' | 'escape-screen';

/**
 * Return the one safe bounded recovery for a sustained gate detail.
 *
 * `busy-indicator` is deliberately absent: it proves a live turn, so touching it
 * would corrupt active work. Unknown/no-session holds also need an external state
 * change rather than a guessed terminal keystroke.
 *
 * `geometry-mismatch` is absent for BOTH of those reasons at once (Issue #197):
 *
 *   1. A keystroke cannot fix it. The mirror is simply the wrong size for the grid the
 *      agent paints at; no byte sent to the agent resizes Tower's mirror. ESC here was
 *      always a no-op dressed as a repair.
 *   2. Worse, it cannot be shown to be safe. Every liveness proof the gate has — the
 *      profile's `busyIndicatorPattern` above all — is read off the SAME frame whose
 *      geometry we have just declared untrustworthy. Measured on a real mid-turn opencode
 *      capture: at its 110x32 capture geometry the frame classifies `busy-indicator`, and
 *      on an 80x24 mirror the reflow moves the `esc interrupt` footer off-screen so the
 *      busy signal vanishes and the same live turn classifies `geometry-mismatch`. Ordering
 *      the busy check first does NOT rescue this: the proof is gone, not merely outranked.
 *
 * So a geometry mismatch cannot prove the agent is idle, and sending ESC would interrupt a
 * live turn to no purpose. It holds with no keystroke and escalates instead — see
 * `isClassifierStuck`, which lists it so the hold is loud rather than silent. The honest
 * remedy is realigning the mirror, which is Tower's job and not the agent's.
 */
export function heldRecoveryAction(detail: string | null | undefined): HeldRecoveryAction | null {
  if (detail === 'user-text') return 'cancel-draft';
  if (detail === 'no-region-end' || detail === 'no-composer-marker') {
    return 'escape-screen';
  }
  return null;
}

/** The exact control byte for a recovery action (never message text). */
export function heldRecoveryKeystroke(action: HeldRecoveryAction): '\x03' | '\x1b' {
  return action === 'cancel-draft' ? '\x03' : '\x1b';
}
