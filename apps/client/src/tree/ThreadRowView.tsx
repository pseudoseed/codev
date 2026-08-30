import { useState } from 'react';
import type { ThreadRow } from './build.js';
import { GatePanel, type GateActionResult, type GateApprovalHandle } from '../gate/GatePanel.js';
import { StatusStamp } from './StatusStamp.js';

const PREFIX: Record<ThreadRow['role'], string> = {
  architect: 'architect/',
  builder: 'builder/',
  unmanaged: 'thread/',
};

/**
 * One row of the tree.
 *
 * The kind prefix is part of the name, not decoration: `builder/air-220` and
 * `architect/main` are what a human reads to tell two rows apart, and dropping
 * the prefix is exactly what made the spec 83 client unusable while its tests
 * stayed green.
 */
/**
 * `builders.id` carries its own `builder-` prefix — every one of the real rows
 * does — so rendering the prefix in front of the raw id gives
 * `builder/builder-air-220`. The prefix is what stays; the duplicate goes.
 */
function displayName(row: ThreadRow): string {
  return row.role === 'builder' ? row.name.replace(/^builder-/, '') : row.name;
}

export function ThreadRowView({ row, approval }: { row: ThreadRow; approval?: GateApprovalHandle | null }) {
  // Owned by the ROW, not by the gate panel: an approval removes the gate, so a
  // result held inside the panel would disappear with it.
  const [result, setResult] = useState<GateActionResult | null>(null);
  const porch = row.porch;
  const classes = [
    'thread-row',
    `role-${row.role}`,
    row.status.kind === 'blocked' ? 'needs-attn' : '',
    row.management === 'unmanaged' && row.role !== 'architect' ? 'is-unmanaged' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} data-kind={row.role} data-id={row.name} data-status={row.status.kind}>
      <div className="thread-row-top">
        <span className="stamp thread-name">
          <span className="kind-prefix">{PREFIX[row.role]}</span>
          {displayName(row)}
        </span>
        <StatusStamp status={row.status} />
      </div>

      <div className="thread-row-meta">
        {porch ? (
          <span className="porch-phase stamp" title={porch.statusPath}>
            {porch.protocol.toUpperCase()} · {porch.phase}
            {porch.currentPlanPhase ? ` · ${porch.currentPlanPhase}` : ''}
          </span>
        ) : row.role === 'builder' || row.role === 'unmanaged' ? (
          <span className="porch-phase stamp is-absent">no porch record — unmanaged</span>
        ) : null}
      </div>

      {/*
        * The reason is on the STAMP as a title and stated once at the machine.
        * Repeating the same sentence under every row buried the rows that had
        * something specific to say — an unrecognised session state, say — in a
        * wall of identical text.
        */}
      {row.status.kind === 'unknown' && row.status.why && row.status.whyIsRowSpecific ? (
        <p className="row-why">{row.status.why}</p>
      ) : null}

      <GatePanel
        status={row.status}
        projectId={porch?.projectId}
        approval={approval ?? null}
        onResult={(next) => setResult(next.message === '' ? null : next)}
      />

      {result ? (
        <p className={`gate-result ${
          result.unconfirmed ? 'is-unknown' : result.ok ? 'is-ok' : 'is-refused'
        }`}>
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
