import { useState } from 'react';
import type { MessageLogReachability } from '../connection/types.js';
import { GatePanel, type GateActionResult, type GateApprovalHandle } from '../gate/GatePanel.js';
import type { ThreadRow } from '../tree/build.js';
import { StatusStamp } from '../tree/StatusStamp.js';
import { MessageLog } from './MessageLog.js';

const PREFIX: Record<ThreadRow['role'], string> = {
  architect: 'architect/',
  builder: 'builder/',
  unmanaged: 'thread/',
};

/**
 * `builders.id` already carries its own `builder-` prefix, so rendering the kind
 * prefix in front of the raw id gives `builder/builder-air-220`. The prefix
 * stays and the duplicate goes — dropping the prefix instead is what made the
 * spec 83 client unreadable while its tests stayed green (#112).
 */
export function displayName(row: ThreadRow): string {
  return row.role === 'builder' ? row.name.replace(/^builder-/, '') : row.name;
}

/**
 * One tile: builder id, status, and the last three messages (criterion 4).
 *
 * The three elements the criterion names are the three that render
 * unconditionally. Everything else — the machine tag, the porch phase, the gate
 * panel — is additive and can be absent without the pane losing its meaning.
 *
 * The pane's minimum height is set here rather than left to the grid, so a row
 * of short panes cannot collapse under the floor when its neighbours are short
 * too. Its minimum WIDTH is the grid's job, because a pane in the paged layout
 * has no floor to hold: it is as wide as the phone.
 */
export function BuilderPane({
  row,
  approval,
  messageLog,
  nowMs,
  showMachine,
  stale,
}: {
  row: ThreadRow;
  approval: GateApprovalHandle | null;
  messageLog: MessageLogReachability;
  nowMs: number;
  showMachine: boolean;
  stale: boolean;
}) {
  // Owned by the PANE, not the gate panel: an approval removes the gate, so a
  // result held inside the panel would unmount with it.
  const [result, setResult] = useState<GateActionResult | null>(null);
  const porch = row.porch;

  return (
    <article
      className={[
        'pane',
        `role-${row.role}`,
        row.status.kind === 'blocked' ? 'needs-attn' : '',
        stale ? 'is-stale' : '',
      ].filter(Boolean).join(' ')}
      data-pane={row.key}
      data-kind={row.role}
      data-id={row.name}
      data-status={row.status.kind}
      data-machine={row.machine}
    >
      <header className="pane-head">
        <span className="stamp pane-name">
          <span className="kind-prefix">{PREFIX[row.role]}</span>
          {displayName(row)}
        </span>
        <StatusStamp status={row.status} />
      </header>

      <div className="pane-meta">
        {showMachine ? <span className="stamp pane-machine">{row.machine}</span> : null}
        {porch ? (
          <span className="porch-phase stamp" title={porch.statusPath}>
            {porch.protocol.toUpperCase()} · {porch.phase}
            {porch.currentPlanPhase ? ` · ${porch.currentPlanPhase}` : ''}
          </span>
        ) : (
          <span className="porch-phase stamp is-absent">no porch record — unmanaged</span>
        )}
      </div>

      {stale ? <p className="stale-note">Last state received. It is not current.</p> : null}

      <div className="pane-messages">
        <div className="stamp pane-section">last messages</div>
        <MessageLog messages={row.messages} log={messageLog} nowMs={nowMs} />
      </div>

      <GatePanel
        status={row.status}
        projectId={porch?.projectId}
        approval={approval}
        onResult={(next) => setResult(next.message === '' ? null : next)}
      />

      {result ? (
        <p className={`gate-result ${
          result.unconfirmed ? 'is-unknown' : result.ok ? 'is-ok' : 'is-refused'
        }`}>
          {result.message}
        </p>
      ) : null}
    </article>
  );
}
