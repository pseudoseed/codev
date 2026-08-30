import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatePanel, type GateApprovalHandle } from '../src/gate/GatePanel.js';
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
    await waitFor(() => expect(approve).toHaveBeenCalledWith({ projectId: '146', gateName: 'plan-approval' }));
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
