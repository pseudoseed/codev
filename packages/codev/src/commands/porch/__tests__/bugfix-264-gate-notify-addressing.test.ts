/**
 * Issue #264 — what `porch approve` puts on the wire after a gate is approved.
 *
 * The defect was an address: `afx send <projectId> "<message>"`, run from
 * wherever porch happened to be, with the workspace inherited from the sending
 * process's session. A project id is not an identity — `250` reaches
 * `builder-spir-250` in any workspace that has one — so an approval for a
 * throwaway project in a temp workspace woke a live builder elsewhere, and the
 * message it delivered was indistinguishable from a real one.
 *
 * These assert the two halves of the fix at the seam where the address is
 * decided: the argv, and the message text.
 */

import { describe, it, expect } from 'vitest';
import { buildSendArgs, gateApprovedMessage } from '../notify.js';

const WORKTREE = '/Users/dev/codev-1455/.builders/spir-250';

function gateArgs(): string[] {
  return buildSendArgs({
    message: gateApprovedMessage('pr', '250', WORKTREE),
    worktreeDir: WORKTREE,
    projectWorktree: WORKTREE,
    exact: true,
  });
}

describe('issue #264 — the gate wake-up addresses the project’s own worktree', () => {
  it('pins the recipient to the worktree whose status.yaml was written', () => {
    const args = gateArgs();
    expect(args[0]).toBe('send');
    expect(args).toContain('--worktree');
    expect(args[args.indexOf('--worktree') + 1]).toBe(WORKTREE);
  });

  it('never puts the bare project id on the wire as an address', () => {
    // The whole defect in one assertion: `250` as a target is what the tail
    // match turned into a delivery to a project that approved nothing.
    const args = gateArgs();
    expect(args).not.toContain('250');
  });

  it('demands an exact match, so a miss cannot become a delivery', () => {
    expect(gateArgs()).toContain('--exact');
  });

  it('keeps the message a raw wake-up', () => {
    expect(gateArgs()).toContain('--raw');
  });
});

describe('issue #264 — the message is checkable, not an instruction', () => {
  const message = gateApprovedMessage('pr', '250', WORKTREE);

  it('names the project and the workspace it is about', () => {
    expect(message).toContain('250');
    expect(message).toContain(WORKTREE);
  });

  it('says outright that it carries no authority', () => {
    expect(message).toMatch(/not an approval/i);
    expect(message).toMatch(/no authority/i);
  });

  it('tells the recipient what to check it against, and what a mismatch means', () => {
    expect(message).toContain('porch next 250');
    expect(message).toMatch(/still pending/i);
    expect(message).toMatch(/ignore it/i);
  });
});
