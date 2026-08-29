/** Recovery policy for render-gate holds that cannot change on an idle screen (#92). */

import { CLEAR_DRAFT_BYTES, INTERRUPT_BYTES, type ClearDraftKey } from '../utils/harness.js';

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
