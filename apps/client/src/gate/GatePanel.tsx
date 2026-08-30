import { useState } from 'react';
import type { GateRequest } from '../connection/types.js';
import type { RowStatus } from '../status/derive.js';

/**
 * An outcome a human reads.
 *
 * THREE STATES, NOT TWO. `unconfirmed` is a server answer this client could not
 * read: the gate may be approved. Rendering it as a refusal would send someone
 * to approve again at the one point in the product where a duplicate costs
 * something, so it gets its own appearance and its own words.
 */
export interface GateActionResult {
  readonly ok: boolean;
  readonly unconfirmed?: boolean;
  readonly message: string;
}

/**
 * What the server says while an approval runs. Never composed here.
 *
 * A button that says "Approving…" for four minutes with nothing behind it is
 * indistinguishable from one that is stuck — and phase checks take minutes, which
 * is the entire reason the approval outlives its request. So the panel shows the
 * server's own phase and check names, or it shows that it has not been told yet.
 */
export interface GateProgress {
  readonly state: 'submitted' | 'running';
  readonly operationId: string;
  readonly phase?: string;
  readonly checks?: readonly string[];
}

export interface GateApprovalHandle {
  /** Null until a session is open on this machine. */
  readonly session: { readonly sessionId: string } | null;
  readonly openSession: (pairingToken: string) => Promise<GateActionResult>;
  readonly approve: (
    gate: { projectId: string; gateName: string },
    onProgress?: (progress: GateProgress) => void,
  ) => Promise<GateActionResult>;
}

/**
 * What a waiting human is told, from what the server has actually said.
 *
 * The phases of this are three different facts and they are not merged: the
 * submit has been accepted and nothing has started; the work is running and the
 * server has not yet named what; the work is running and these are the checks.
 * A single "Approving…" for all three is the spinner this phase exists to stop.
 */
function progressWords(progress: GateProgress | null): string {
  if (!progress) return 'Submitted. Waiting for the server to start the work.';
  if (progress.state === 'submitted') {
    return `Accepted as operation ${progress.operationId}. Not started yet.`;
  }
  if (progress.checks && progress.checks.length > 0) {
    return `Running the ${progress.phase ?? 'current'} phase checks: ${progress.checks.join(', ')}. `
      + 'This takes as long as they take; leaving the page does not stop it.';
  }
  if (progress.phase) {
    return `Running in the ${progress.phase} phase, which declares no checks.`;
  }
  return `Running as operation ${progress.operationId}. Leaving the page does not stop it.`;
}

/**
 * The structured decision, in the row.
 *
 * NO NAVIGATION. A gate name alone tells a human that something is waiting and
 * not what it is waiting for, which leaves them opening a terminal to find out —
 * and #128 put the question into `status.yaml` precisely so they would not have
 * to. The question and its choices render here or the deliverable is not met.
 *
 * Everything below is TEXT, and React escapes text. Agent output is the
 * untrusted input on this page and this page holds N machines' credentials, so
 * the raw-HTML escape hatch is not used here — and the guard that enforces that
 * greps the source, so it will not be named in a comment either. A guard taught
 * to ignore comments is a guard that has started going blind.
 */
export function GatePanel({
  status,
  projectId,
  approval,
  onResult,
}: {
  status: RowStatus;
  projectId: string | undefined;
  approval: GateApprovalHandle | null;
  /**
   * Where the outcome goes, and it is NOT inside this component.
   *
   * A successful approval makes porch write `status.yaml`, the stream delivers
   * the new snapshot within milliseconds, and the row stops being blocked — so
   * this panel unmounts. Holding the result here meant the confirmation a human
   * had just earned flashed and vanished, leaving them unable to tell an
   * approval from a click that did nothing. The row outlives the gate, so the
   * row owns the answer.
   */
  onResult: (result: GateActionResult) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<GateProgress | null>(null);

  if (status.kind !== 'blocked' || !status.gate) return null;
  const request: GateRequest | undefined = status.gateRequest;

  const run = async (action: () => Promise<GateActionResult>): Promise<void> => {
    setBusy(true);
    setProgress(null);
    onResult({ ok: true, message: '' });
    try {
      onResult(await action());
    } catch (error) {
      onResult({ ok: false, message: (error as Error).message });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <section className="gate-panel" data-gate={status.gate}>
      <header className="gate-head">
        <span className="stamp gate-label">the question</span>
        {status.gateRequestedAt ? (
          <span className="gate-since stamp">requested {status.gateRequestedAt}</span>
        ) : null}
      </header>

      {request ? (
        <>
          <p className="gate-question">{request.question}</p>
          <ul className="gate-choices">
            {request.choices.map((choice, index) => (
              <li className={choice.recommended ? 'is-recommended' : ''} key={`${choice.label}-${index}`}>
                <span className="choice-label">{choice.label}</span>
                {choice.recommended ? <span className="stamp choice-flag">recommended</span> : null}
                <span className="choice-consequence">{choice.consequence}</span>
              </li>
            ))}
          </ul>
          {request.terminalExcerpt ? (
            <pre className="gate-excerpt">{request.terminalExcerpt}</pre>
          ) : null}
        </>
      ) : (
        /* NOT the same as "no question". Porch auto-requests some gates with no
           structured content, and saying so is different from showing nothing. */
        <p className="gate-question is-absent">
          This gate carries no structured question. Only its name, <code>{status.gate}</code>, is recorded.
        </p>
      )}

      {approval === null || projectId === undefined ? (
        <p className="gate-note">
          {projectId === undefined
            ? 'This row has no porch record, so there is no project to approve against.'
            : 'This machine cannot be approved from here.'}
        </p>
      ) : approval.session === null ? (
        <form
          className="gate-approve"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => approval.openSession(token));
          }}
        >
          <label className="stamp gate-label" htmlFor={`token-${projectId}`}>
            pairing token
          </label>
          <input
            id={`token-${projectId}`}
            className="gate-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="a fresh token, from the machine"
          />
          <button className="gate-button" type="submit" disabled={busy || token.length === 0}>
            Open a session
          </button>
          <p className="gate-note">
            Approving needs a session, and one costs a fresh single-use pairing token minted on
            that machine. The token makes this a deliberate, recorded act &mdash; it does not
            prove a person is here, because anything that can write the pairing store can mint
            one. What it authorized is recorded alongside the approval.
          </p>
        </form>
      ) : (
        <div className="gate-approve">
          <button
            className="gate-button is-primary"
            type="button"
            disabled={busy}
            onClick={() => void run(() => approval.approve(
              { projectId, gateName: status.gate! },
              setProgress,
            ))}
          >
            {busy ? 'Approving…' : `Approve ${status.gate}`}
          </button>
          <span className="gate-note">session {approval.session.sessionId}</span>
          {busy ? (
            <p className="gate-progress" data-state={progress?.state ?? 'submitted'}>
              {progressWords(progress)}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
