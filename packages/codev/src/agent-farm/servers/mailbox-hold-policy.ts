/** Recovery policy for render-gate holds that cannot change on an idle screen (#92). */

export type HeldRecoveryAction = 'cancel-draft' | 'escape-screen';

/**
 * Return the one safe bounded recovery for a sustained gate detail.
 *
 * `busy-indicator` is deliberately absent: it proves a live turn, so touching it
 * would corrupt active work. Unknown/no-session holds also need an external state
 * change rather than a guessed terminal keystroke.
 */
export function heldRecoveryAction(detail: string | null | undefined): HeldRecoveryAction | null {
  if (detail === 'user-text') return 'cancel-draft';
  if (detail === 'no-region-end' || detail === 'no-composer-marker' || detail === 'geometry-mismatch') {
    return 'escape-screen';
  }
  return null;
}

/** The exact control byte for a recovery action (never message text). */
export function heldRecoveryKeystroke(action: HeldRecoveryAction): '\x03' | '\x1b' {
  return action === 'cancel-draft' ? '\x03' : '\x1b';
}
