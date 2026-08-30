/**
 * One rule, one encoding: a `--no-enter` message cannot be delivered to a thread.
 *
 * WHY THIS FILE EXISTS RATHER THAN THE RULE LIVING AT BOTH SITES
 *
 * The rule is enforced twice, and it has to be: `deliverAgentMail` ends the row
 * terminally (holding it would raise a starvation notice with no remedy), and
 * `makeDeliveryPorts().writeMessage` refuses it as a backstop for anything that reaches
 * the port another way. Two enforcement points is correct. Two *statements* of the rule
 * is not.
 *
 * This is the third time the same shape has bitten in issue #219: a duplicated sentence
 * across this exact pair of files went stale on one side and had to be corrected twice —
 * once in the log line, then again eight lines above it in the block comment that still
 * said "the row stays held" after the caller had started dismissing it. Nothing made a
 * one-sided change fail, so the stale copy simply won until a reviewer read it.
 *
 * So the condition and the words both live here, and `spec-146-phase-9-no-enter-rule.test.ts`
 * fails if either site stops importing them.
 *
 * WHY IT IS A RULE AT ALL
 *
 * `--no-enter` means "put this in the composer and leave it for a human". A thread has no
 * composer: `thread.turn.start` IS the submit, and nothing in the protocol stages text
 * without running it. Delivering such a message would RUN an instruction that was sent to
 * wait — and `--no-enter` is the form porch's gate notifications use, so the message that
 * would run itself is exactly the one a human was meant to decide about.
 */

/**
 * Can a thread transport honour this message's `--no-enter`?
 *
 * Never — the answer is the flag inverted. It is a function rather than a bare `if` at
 * each site so that the day the answer stops being "never" (a protocol that can stage
 * text, say), it stops being so in one place.
 */
export function threadCanHonourNoEnter(noEnter: boolean): boolean {
  return !noEnter;
}

/** The fact both sites state, in the words both sites use. */
export const THREAD_HAS_NO_COMPOSER =
  'A thread has no composer — thread.turn.start is the submit — so a --no-enter message '
  + 'cannot be left to wait for a human, and delivering it any other way would RUN it.';

/** What a sender should do instead. Part of the rule, so it lives with it. */
export const THREAD_NO_ENTER_REMEDY = 'Re-send without --no-enter if it should run.';
