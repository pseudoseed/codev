/** Recovery policy for render-gate holds that cannot change on an idle screen (#92). */

import { INTERRUPT_BYTES, type InterruptSignal } from '../utils/harness.js';

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
 * The control byte for a recovery action on a given harness (never message text).
 *
 * `escape-screen` is ESC on every harness. `cancel-draft` WANTS Ctrl+C — the byte that
 * clears a leftover composer line — but Ctrl+C QUITS opencode (Issue #196), and this
 * recovery fires AUTOMATICALLY after the #92 starvation window with no operator in the
 * loop. So the harness's recorded {@link InterruptSignal} decides: a `ctrl-c` harness gets
 * the clearing byte, an `esc` harness gets ESC. On opencode that may not clear the draft
 * and the row stays held for a human — which is the correct trade against killing the
 * session and the conversation behind it.
 */
export function heldRecoveryKeystroke(
  action: HeldRecoveryAction,
  signal: InterruptSignal,
): string {
  if (action !== 'cancel-draft') return INTERRUPT_BYTES.esc;
  return INTERRUPT_BYTES[signal];
}
