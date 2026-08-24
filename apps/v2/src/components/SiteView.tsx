import type { AppState } from '../lib/stream.js';
import { buildTree } from '../lib/tree.js';
import { ArchitectHeader } from './ArchitectHeader.js';
import { BuilderRow } from './BuilderRow.js';
import { MachineFooter } from './MachineFooter.js';
import { MachineRow } from './MachineRow.js';
import { SiteHeader } from './SiteHeader.js';
import { WorkspacePlot } from './WorkspacePlot.js';

type Props = { state: AppState; hostname: string };

export function SiteView({ state, hostname }: Props) {
  const { plots, orphanArchitects, orphanBuilders } = buildTree(state.reducer.nodes, state.reducer.darkPaths);
  const hasOrphans = orphanArchitects.length > 0 || orphanBuilders.length > 0;
  return (
    <>
      <SiteHeader counts={state.reducer.counts} />
      <main className="site-main grid-bg">
        <MachineRow hostname={hostname} connection={state.connection} />
        <section className="plot corner lot">
          <span className="stamp lot-tag">Machine Lot</span>
          <div className="plot-grid">
            {plots.map((p) => (
              <WorkspacePlot key={p.id} plot={p} />
            ))}
            {hasOrphans ? (
              <div className="ws-plot unattached" data-testid="unattached">
                <div className="stamp ws-plot-name">
                  <span className="ws-plot-label">parent not in tree</span>
                </div>
                {orphanArchitects.map((g) => (
                  <ArchitectHeader key={g.node.id} node={g.node} builders={g.builders} />
                ))}
                {orphanBuilders.length > 0 ? (
                  <div className="stake-list">
                    {orphanBuilders.map((b) => (
                      <BuilderRow key={b.id} node={b} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      </main>
      <MachineFooter counts={state.reducer.counts} />
    </>
  );
}
