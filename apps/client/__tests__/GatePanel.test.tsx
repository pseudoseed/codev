import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatePanel, type GateActionResult, type GateApprovalHandle } from '../src/gate/GatePanel.js';
import { ThreadRowView } from '../src/tree/ThreadRowView.js';
import type { ThreadRow } from '../src/tree/build.js';
import type { RowStatus } from '../src/status/derive.js';

afterEach(cleanup);

const BLOCKED: RowStatus = {
  kind: 'blocked',
  gate: 'plan-approval',
  gateRequestedAt: '2026-08-29T11:00:00Z',
  gateRequest: {
    question: 'Should the driver ship behind a flag?',
    choices: [
      { label: 'Behind a flag', consequence: 'Existing workspaces are untouched', recommended: true },
      { label: 'On by default', consequence: 'Every workspace picks it up at once' },
    ],
    terminalExcerpt: 'porch next 146\nPHASE: plan',
  },
};

/** A managed builder row carrying `status`, for the tests that need the row. */
function rowWith(status: typeof BLOCKED): ThreadRow {
  return {
    key: 'alpha:th-1',
    backing: 'terminal',
    name: 'builder-air-146',
    role: 'builder',
    management: 'managed',
    worktree: '/w/.builders/air-146',
    porch: {
      projectId: '146',
      title: 'client',
      protocol: 'air',
      phase: 'implement',
      currentPlanPhase: null,
      gates: {},
      artifactRoot: '/w/.builders/air-146',
      statusPath: '/w/.builders/air-146/codev/projects/146/status.yaml',
    },
    status,
  };
}

function handle(over: Partial<GateApprovalHandle> = {}): GateApprovalHandle {
  return {
    session: { sessionId: 'sess-1' },
    openSession: async () => ({ ok: true, message: 'open' }),
    approve: async () => ({ ok: true, message: 'approved' }),
    ...over,
  };
}

describe('the structured question renders in the row', () => {
  it('shows the question, every choice, and each consequence', () => {
    render(<GatePanel status={BLOCKED} projectId="146" approval={handle()} onResult={() => {}} />);
    expect(screen.getByText('Should the driver ship behind a flag?')).toBeTruthy();
    expect(screen.getByText('Behind a flag')).toBeTruthy();
    expect(screen.getByText('On by default')).toBeTruthy();
    expect(screen.getByText('Existing workspaces are untouched')).toBeTruthy();
    expect(screen.getByText('Every workspace picks it up at once')).toBeTruthy();
  });

  it('marks the recommended choice', () => {
    render(<GatePanel status={BLOCKED} projectId="146" approval={handle()} onResult={() => {}} />);
    const recommended = document.querySelectorAll('.gate-choices li.is-recommended');
    expect(recommended).toHaveLength(1);
    expect(recommended[0].textContent).toContain('Behind a flag');
  });

  it('shows the terminal excerpt as text, never as markup', () => {
    render(<GatePanel
      status={{ ...BLOCKED, gateRequest: { ...BLOCKED.gateRequest!, terminalExcerpt: '<img src=x onerror=1>' } }}
      projectId="146"
      approval={handle()}
      onResult={() => {}}
    />);
    const excerpt = document.querySelector('.gate-excerpt')!;
    expect(excerpt.textContent).toBe('<img src=x onerror=1>');
    expect(excerpt.querySelector('img')).toBeNull();
  });

  it('does not need navigation: everything is inside the row', () => {
    const { container } = render(<GatePanel status={BLOCKED} projectId="146" approval={handle()} onResult={() => {}} />);
    expect(container.querySelectorAll('a[href]')).toHaveLength(0);
    expect(container.querySelector('.gate-panel')).toBeTruthy();
  });

  /* A gate name alone does not satisfy the deliverable, and neither does an
     empty panel pretending there was nothing to say. */
  it('says a gate carries no structured question rather than showing nothing', () => {
    render(<GatePanel
      status={{ kind: 'blocked', gate: 'pr', gateRequestedAt: '2026-08-30T00:51:52Z' }}
      projectId="219"
      approval={handle()}
      onResult={() => {}}
    />);
    expect(screen.getByText(/no structured question/i)).toBeTruthy();
    expect(screen.getByText('pr')).toBeTruthy();
  });

  it('renders nothing at all for a row that is not blocked', () => {
    const { container } = render(
      <GatePanel status={{ kind: 'turning' }} projectId="146" approval={handle()} onResult={() => {}} />,
    );
    expect(container.querySelector('.gate-panel')).toBeNull();
  });
});

describe('approving from the client', () => {
  it('asks for a pairing token before it will approve anything', () => {
    render(
      <GatePanel status={BLOCKED} projectId="146" approval={handle({ session: null })} onResult={() => {}} />,
    );
    expect(screen.getByLabelText(/pairing token/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve plan-approval/i })).toBeNull();
  });

  it('opens a session with the token the human typed', async () => {
    const openSession = vi.fn(async () => ({ ok: true, message: 'session open until later' }));
    render(<ThreadRowView row={rowWith(BLOCKED)} approval={handle({ session: null, openSession })} />);
    fireEvent.change(screen.getByLabelText(/pairing token/i), { target: { value: 'tok-abc' } });
    fireEvent.click(screen.getByRole('button', { name: /open a session/i }));
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('tok-abc'));
    await waitFor(() => expect(screen.getByText(/session open until later/i)).toBeTruthy());
  });

  /*
   * A successful approval removes the gate, so the panel unmounts. The
   * confirmation has to outlive it, or a human cannot tell an approval from a
   * click that did nothing.
   */
  it('keeps the result on the row after the gate stops blocking', async () => {
    const approve = vi.fn(async () => ({ ok: true, message: 'approved on alpha' }));
    const { rerender } = render(<ThreadRowView row={rowWith(BLOCKED)} approval={handle({ approve })} />);
    fireEvent.click(screen.getByRole('button', { name: /approve plan-approval/i }));
    await waitFor(() => expect(document.querySelector('.gate-result.is-ok')).toBeTruthy());

    // Porch wrote status.yaml and the stream delivered it: the row is no longer
    // blocked, and the panel is gone.
    rerender(<ThreadRowView row={rowWith({ kind: 'turning' } as never)} approval={handle({ approve })} />);
    expect(document.querySelector('.gate-panel')).toBeNull();
    expect(document.querySelector('.gate-result.is-ok')!.textContent).toBe('approved on alpha');
  });

  it('approves the gate it is rendered for, and reports what came back', async () => {
    const approve = vi.fn(async () => ({
      ok: true,
      message: 'approved on alpha at 2026-08-30T01:00:00Z, session sess-1',
    }));
    render(<ThreadRowView row={rowWith(BLOCKED)} approval={handle({ approve })} />);
    fireEvent.click(screen.getByRole('button', { name: /approve plan-approval/i }));
    // The second argument is the progress sink the panel passes so the server can
    // say what it is running. Asserted as "a function" rather than ignored: a
    // panel that stopped passing it would silently go back to a bare spinner.
    await waitFor(() => expect(approve).toHaveBeenCalledWith(
      { projectId: '146', gateName: 'plan-approval' },
      expect.any(Function),
    ));
    await waitFor(() => expect(document.querySelector('.gate-result.is-ok')).toBeTruthy());
  });

  it('shows a refusal as a refusal, not as a success', async () => {
    const approve = vi.fn(async () => ({ ok: false, message: 'PHASE_CHECKS_FAILED: the checks did not pass' }));
    render(<ThreadRowView row={rowWith(BLOCKED)} approval={handle({ approve })} />);
    fireEvent.click(screen.getByRole('button', { name: /approve plan-approval/i }));
    await waitFor(() => expect(document.querySelector('.gate-result.is-refused')).toBeTruthy());
    expect(screen.getByText(/PHASE_CHECKS_FAILED/)).toBeTruthy();
    expect(document.querySelector('.gate-result.is-ok')).toBeNull();
  });

  it('says why a row with no porch record cannot be approved', () => {
    render(
      <GatePanel status={BLOCKED} projectId={undefined} approval={handle()} onResult={() => {}} />,
    );
    expect(screen.getByText(/no porch record/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/**
 * WHAT A WAITING HUMAN IS TOLD.
 *
 * Phase checks take minutes — that is the entire reason an approval outlives its
 * request — and a button reading "Approving…" for four of them is
 * indistinguishable from one that is stuck. What is shown comes from the server
 * and nowhere else.
 */
describe('while an approval is running', () => {
  function handleThatReports(
    updates: Array<Parameters<NonNullable<Parameters<GateApprovalHandle['approve']>[1]>>[0]>,
  ): GateApprovalHandle {
    let release: () => void = () => {};
    const finished = new Promise<void>((resolve) => { release = resolve; });
    return {
      session: { sessionId: 's1' },
      openSession: async () => ({ ok: true, message: '' }),
      approve: async (_gate, onProgress) => {
        for (const update of updates) onProgress?.(update);
        await finished;
        return { ok: true, message: 'approved' };
      },
      // Exposed for the test to end the wait.
      ...({ release: () => release() } as Record<string, unknown>),
    } as GateApprovalHandle & { release: () => void };
  }

  it('names the phase and the checks the server said it is running', async () => {
    const approval = handleThatReports([
      { state: 'running', operationId: 'op-1', phase: 'review', checks: ['build', 'tests'] },
    ]) as GateApprovalHandle & { release: () => void };
    render(
      <GatePanel status={BLOCKED} projectId="146" approval={approval} onResult={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve plan-approval/i }));

    await waitFor(() => {
      const progress = document.querySelector('.gate-progress')!;
      expect(progress.textContent).toContain('review');
      expect(progress.textContent).toContain('build, tests');
      // And it says the work survives the page, which is what makes waiting safe.
      expect(progress.textContent).toContain('leaving the page does not stop it');
    });
    approval.release();
  });

  it('says a phase with no checks declares none, rather than showing an empty list', async () => {
    const approval = handleThatReports([
      { state: 'running', operationId: 'op-2', phase: 'verify', checks: [] },
    ]) as GateApprovalHandle & { release: () => void };
    render(
      <GatePanel status={BLOCKED} projectId="146" approval={approval} onResult={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve plan-approval/i }));

    await waitFor(() => {
      expect(document.querySelector('.gate-progress')!.textContent)
        .toContain('verify phase, which declares no checks');
    });
    approval.release();
  });

  it('distinguishes accepted-not-started from running', async () => {
    const approval = handleThatReports([
      { state: 'submitted', operationId: 'op-3' },
    ]) as GateApprovalHandle & { release: () => void };
    render(
      <GatePanel status={BLOCKED} projectId="146" approval={approval} onResult={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve plan-approval/i }));

    await waitFor(() => {
      const progress = document.querySelector('.gate-progress')!;
      expect(progress.textContent).toContain('op-3');
      expect(progress.textContent).toContain('Not started yet');
    });
    approval.release();
  });

  it('shows nothing about progress once the approval has finished', async () => {
    const approval: GateApprovalHandle = {
      session: { sessionId: 's1' },
      openSession: async () => ({ ok: true, message: '' }),
      approve: async (_gate, onProgress) => {
        onProgress?.({ state: 'running', operationId: 'op-4', phase: 'review', checks: ['build'] });
        return { ok: true, message: 'approved' };
      },
    };
    render(
      <GatePanel status={BLOCKED} projectId="146" approval={approval} onResult={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve plan-approval/i }));
    // The panel stops claiming work is in flight the moment it is not.
    await waitFor(() => expect(document.querySelector('.gate-progress')).toBeNull());
  });
});

/**
 * FOUR OUTCOMES, THREE APPEARANCES, AND THE MIDDLE ONE IS THE POINT.
 *
 * `failed` and `refused` both mean the gate was not approved and share the
 * refused treatment, their messages carrying which. `interrupted` does NOT: the
 * host stopped and the gate may well be approved, so it renders as unknown —
 * rendering it as a refusal would send a human to approve something already
 * approved.
 */
describe('how each terminal outcome reaches the row', () => {
  function handleReturning(result: GateActionResult): GateApprovalHandle {
    return {
      session: { sessionId: 's1' },
      openSession: async () => ({ ok: true, message: '' }),
      approve: async () => result,
    };
  }

  async function resultClassFor(result: GateActionResult): Promise<string> {
    const seen: GateActionResult[] = [];
    render(
      <GatePanel
        status={BLOCKED}
        projectId="146"
        approval={handleReturning(result)}
        onResult={(r) => { if (r.message) seen.push(r); }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve plan-approval/i }));
    await waitFor(() => expect(seen).toHaveLength(1));
    return seen[0].unconfirmed ? 'is-unknown' : seen[0].ok ? 'is-ok' : 'is-refused';
  }

  it('renders a failed approval as refused, carrying its reason', async () => {
    expect(await resultClassFor({
      ok: false, message: 'GATE_APPROVAL_FAILED: ENOSPC writing status.yaml',
    })).toBe('is-refused');
  });

  it('renders an interrupted approval as unknown, never as refused', async () => {
    expect(await resultClassFor({
      ok: false,
      unconfirmed: true,
      message: 'this host stopped while it ran, and status.yaml now shows pr APPROVED.',
    })).toBe('is-unknown');
  });

  it('renders a refusal as refused', async () => {
    expect(await resultClassFor({
      ok: false, message: 'PHASE_CHECKS_FAILED: the checks did not pass',
    })).toBe('is-refused');
  });

  it('renders a success as a success', async () => {
    expect(await resultClassFor({ ok: true, message: 'approved on alpha' })).toBe('is-ok');
  });
});
