/**
 * What a stale `.gitignore` should gain on backfill, derived rather than restated.
 *
 * `gitignore.test.ts` and `update.test.ts` both assert the exact set a pre-#880 project
 * gains from `backfillGitignore`, and both spelled that set out as a literal array. Adding
 * one entry to `CODEV_GITIGNORE_ENTRIES` therefore had to be mirrored in two places, and the
 * second was missed — the full suite caught it as `2 failed | 6648 passed`. The list now has
 * one home per fixture, computed from `CODEV_GITIGNORE_ENTRIES` itself.
 *
 * The parser here is deliberately its own three lines rather than a reuse of the one inside
 * `gitignore.ts`. Deriving the expected value with the code under test would make the
 * assertion agree with the implementation by construction, including when the implementation
 * is wrong. What is being single-sourced is the *entry list*, not the parsing of it.
 */
import { CODEV_GITIGNORE_ENTRIES } from '../../lib/gitignore.js';

/** A `.gitignore` from before issue #880 — the Codev block as it stood then. */
export const PRE_880_GITIGNORE =
  '# Codev\n.agent-farm/\n.consult/\ncodev/.update-hashes.json\n.builders/\n';

/** The same, plus `.architect-role.md`: a project that took #880 but not #1192. */
export const PRE_1192_GITIGNORE = `${PRE_880_GITIGNORE}.architect-role.md\n`;

function entriesOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * The entries `backfillGitignore` should add to a `.gitignore` that currently holds
 * `existing`, in the order `CODEV_GITIGNORE_ENTRIES` declares them.
 */
export function entriesMissingFrom(existing: string): string[] {
  const present = new Set(entriesOf(existing));
  return entriesOf(CODEV_GITIGNORE_ENTRIES).filter((entry) => !present.has(entry));
}
