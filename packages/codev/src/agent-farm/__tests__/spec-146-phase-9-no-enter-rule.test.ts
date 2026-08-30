/**
 * Issue #219 round 7 — the `--no-enter`-on-a-thread rule has one encoding.
 *
 * The rule is ENFORCED at three points, and that is correct: `deliverAgentMail` ends the
 * row terminally, `writeMessage` refuses as a backstop, and the send route explains the
 * refusal to the sender. Three enforcement points is right. Three *statements* of the rule
 * is not.
 *
 * That duplication already went wrong twice in this issue, in this exact pair of files: a
 * sentence saying "the row stays held" survived the change that made the caller dismiss
 * the row, and had to be corrected once in the log line and again eight lines above it in
 * a block comment. Nothing made a one-sided change fail, so the stale copy won until
 * someone read it.
 *
 * These tests are the thing that makes a one-sided change fail. They are source-text
 * assertions on purpose: the defect is a second copy of the words, and a behavioural test
 * cannot see a second copy — it sees the copy that runs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  threadCanHonourNoEnter,
  THREAD_HAS_NO_COMPOSER,
  THREAD_NO_ENTER_REMEDY,
} from '../servers/thread-no-enter.js';

const serversDir = resolve(import.meta.dirname, '..', 'servers');

/** Every place that states the rule. Adding a fourth means adding it here. */
const SITES = [
  'mailbox-delivery.ts',
  'mailbox-wiring.ts',
  'tower-routes.ts',
] as const;

function sourceOf(file: string): string {
  return readFileSync(join(serversDir, file), 'utf8');
}

describe('the --no-enter-on-a-thread rule is stated once', () => {
  it('is what the shared module says it is', () => {
    // Never, and the answer is the flag inverted. Stated as a test so the day it stops
    // being "never" the change is deliberate rather than incidental.
    expect(threadCanHonourNoEnter(true)).toBe(false);
    expect(threadCanHonourNoEnter(false)).toBe(true);
    expect(THREAD_HAS_NO_COMPOSER).toContain('thread.turn.start is the submit');
    expect(THREAD_NO_ENTER_REMEDY).toContain('Re-send without --no-enter');
  });

  it.each(SITES)('%s takes the rule from the shared module rather than restating it', (file) => {
    const src = sourceOf(file);
    expect(src, `${file} does not import the shared rule`).toContain("from './thread-no-enter.js'");
    expect(src, `${file} does not use the shared predicate`).toContain('threadCanHonourNoEnter(');
    expect(src, `${file} does not use the shared wording`).toContain('THREAD_HAS_NO_COMPOSER');
  });

  /**
   * The specific failure this guards. A site that hardcodes the sentence keeps working —
   * that is what makes it dangerous — and drifts the moment the shared one changes.
   */
  it.each(SITES)('%s does not carry its own copy of the sentence', (file) => {
    const src = sourceOf(file);
    // The distinctive phrase from the shared constant. Its presence outside
    // `thread-no-enter.ts` means someone wrote the words again instead of importing them.
    expect(src, `${file} restates the rule instead of importing it`)
      .not.toContain('thread.turn.start is the submit —');
  });

  it('the shared module is the only place the sentence is written', () => {
    const owner = readFileSync(join(serversDir, 'thread-no-enter.ts'), 'utf8');
    expect(owner).toContain('thread.turn.start is the submit —');
  });
});
