import type { WorkspacePlotModel } from '../lib/tree.js';
import { ArchitectHeader } from './ArchitectHeader.js';
import { BuilderRow } from './BuilderRow.js';
import { StatusStamp } from './StatusStamp.js';

type Props = { plot: WorkspacePlotModel };

export function WorkspacePlot({ plot }: Props) {
  const dim = Boolean(plot.dark) || plot.status === 'offline';
  const cls = dim ? 'ws-plot dim-sub' : 'ws-plot';
  return (
    <div className={cls} data-kind="workspace" data-id={plot.id} data-dark={plot.dark ? 'true' : 'false'}>
      <div className="stamp ws-plot-name">
        <span className="ws-plot-label">{plot.name}</span>
        {plot.flags.heldMail ? <span className="held-mail">mail</span> : null}
        {plot.status ? <StatusStamp status={plot.status} /> : null}
      </div>
      {plot.dark ? (
        <div className="dark-meta stamp">
          {plot.dark.reason} · {plot.dark.at}
        </div>
      ) : null}
      {plot.architects.map((g) => (
        <ArchitectHeader key={g.node.id} node={g.node} builders={g.builders} />
      ))}
      {plot.builders.length > 0 ? (
        <div className="stake-list">
          {plot.builders.map((b) => (
            <BuilderRow key={b.id} node={b} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
