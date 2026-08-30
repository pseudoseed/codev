import type { ThreadRow } from './build.js';
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

export function ThreadRowView({ row }: { row: ThreadRow }) {
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

      {row.status.kind === 'unknown' && row.status.why ? (
        <p className="row-why">{row.status.why}</p>
      ) : null}
    </div>
  );
}
