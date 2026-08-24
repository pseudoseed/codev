import type { WorkspacePlotModel } from '../lib/tree.js';
import { ArchitectHeader } from './ArchitectHeader.js';
import { BuilderRow } from './BuilderRow.js';
import { Glyph } from './Glyph.js';
import { StatusStamp } from './StatusStamp.js';

type Props = { plot: WorkspacePlotModel };

export function WorkspacePlot({ plot }: Props) {
  const dim = Boolean(plot.dark) || plot.status === 'offline';
  const cls = dim ? 'ws-plot dim-sub' : 'ws-plot';
  const empty = plot.architects.length === 0 && plot.builders.length === 0;
  return (
    <div className={cls} data-kind="workspace" data-id={plot.id} data-dark={plot.dark ? 'true' : 'false'}>
      <div className="stamp ws-plot-name">
        <span className="ws-plot-title">
          <span className="kind-prefix">workspace /</span>
          <span className="ws-plot-label">{plot.name}</span>
        </span>
        {plot.flags.heldMail ? <span className="held-mail">mail</span> : null}
        <span className="ws-plot-right">
          {plot.status ? <StatusStamp status={plot.status} /> : null}
          <Glyph kind="workspace" />
        </span>
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
      {/* A lot with nothing standing on it. Only says "reconnect" when the
          workspace is actually unreachable — an idle live workspace is empty
          for a different reason and gets no copy. */}
      {empty && dim ? (
        <div className="empty-lot stamp" data-testid="empty-lot">
          reconnect to resume
        </div>
      ) : null}
    </div>
  );
}
