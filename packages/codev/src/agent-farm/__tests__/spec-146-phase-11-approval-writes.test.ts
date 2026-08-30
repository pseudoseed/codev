/**
 * WHICH WRITE FAILED DECIDES WHAT THE HUMAN IS TOLD (Spec 146, Phase 11).
 *
 * `writeStateAndCommit` raises `StatePushFailed` when the state was written and
 * committed but the push failed, and codev-agent turns that into "approved, but
 * not pushed — do not approve again". That is right for the write that approves
 * the gate and catastrophic for the three above it: `approve()` also writes for
 * the verify auto-complete, the upgrade gate-creation and the verify phase
 * transition, all BEFORE the gate is approved. A push failure there reported an
 * approval that never happened and told the human not to retry — they walk away
 * believing a gate is approved that is not.
 *
 * ## Why this reads source instead of driving the function
 *
 * `writeStateAndCommit` skips git entirely when `process.env.VITEST` is set, so
 * no behavioural test in this suite can make a push fail. The gap sat exactly
 * where the harness does not go — for the third time in this phase. A structural
 * assertion is what can be made here, so it is what is made, and it is written to
 * fail on a NEW write added before the gate rather than only on today's three.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PORCH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands', 'porch');

/** The body of `approve()`, found by brace depth so a reformat does not break it. */
function approveBody(): string {
  const source = readFileSync(join(PORCH, 'index.ts'), 'utf8');
  const signature = source.indexOf('export async function approve(');
  expect(signature, 'porch no longer exports an `approve` function').toBeGreaterThan(-1);
  const open = source.indexOf('{', source.indexOf('): Promise<', signature));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('approve() has unbalanced braces; this test could not read it');
}

describe('only the gate write may report "approved but not pushed"', () => {
  /*
   * ASSERTED BY WHAT EACH CALL IS, NOT BY WHERE IT SITS.
   *
   * The first version of this test sliced the body at the `gate-approved`
   * template literal and counted raw calls before it — and the gate write's own
   * `await writeStateAndCommit(` sits BEFORE that literal, so the gate write
   * counted as a violation of itself. A positional check that has to be right
   * about ordering to be right about safety is a check that will be wrong again.
   */
  it('permits exactly two raw writes: the wrapper\'s own, and the gate write', () => {
    const body = approveBody();
    const calls = [...body.matchAll(/await writeStateAndCommit\(/g)]
      .map((match) => body.slice(match.index ?? 0, (match.index ?? 0) + 140).replace(/\s+/g, ' '));

    const offenders = calls.filter((call) => !(
      // The wrapper's own call — the single place a pre-approval write is made.
      call.includes('writeStateAndCommit(statusPath, state, message)')
      // The gate write, the one whose push failure is a caveat on a real approval.
      || call.includes('gate-approved')
    ));
    expect(
      offenders,
      'a write in approve() goes neither through writeBeforeApproval nor is the gate write. '
      + 'If it runs BEFORE the gate is approved, a push failure there is reported to a human as '
      + 'a completed approval, with an instruction not to retry.',
    ).toEqual([]);

    // The wrapper is actually used, so the check above is not vacuous because
    // every write moved somewhere this pattern no longer sees.
    expect([...body.matchAll(/await writeBeforeApproval\(/g)].length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBe(2);
  });

  it('lets exactly one write raise StatePushFailed to the caller', () => {
    const body = approveBody();
    // One catch of StatePushFailed for the gate write, one inside the wrapper.
    expect([...body.matchAll(/instanceof StatePushFailed/g)].length).toBe(2);
    // The wrapper converts it into a plain failure that says NOT approved.
    expect(body).toMatch(/gate was NOT approved/);
  });

  it('reports the persisted record rather than one built for the response', () => {
    const body = approveBody();
    // Both returns read from `state.gates[gateName]`, which is what was written.
    expect([...body.matchAll(/state\.gates\[gateName\]\.approved_at/g)].length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("outcome: 'already-approved'");
    expect(body).toContain("outcome: 'approved'");
  });

  it('never fabricates a timestamp in the route that answers a client', () => {
    const route = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'servers', 'agent-routes.ts'),
      'utf8',
    );
    const handler = route.slice(route.indexOf('function handleGateApprove'));
    const body = handler.slice(0, handler.indexOf('\n}\n'));
    // The approval response used `new Date()` for `approvedAt`, so an old
    // approval was reported as having just happened.
    expect(body, 'handleGateApprove builds a timestamp instead of reporting porch\'s')
      .not.toMatch(/approvedAt:\s*new Date\(\)/);
    expect(body).toContain('result.approvedAt');
  });
});
