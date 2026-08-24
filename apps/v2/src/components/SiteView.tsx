import type { AppState } from '../lib/stream.js';
import { buildTree } from '../lib/tree.js';
import { MachineFooter } from './MachineFooter.js';
import { WorkspacePlot } from './WorkspacePlot.js';

type Props = { state: AppState; hostname: string };

export function SiteView({ state, hostname }: Props) {
  const plots = buildTree(state.reducer.nodes, state.reducer.darkPaths);
  return (
    <>
      <header className="lot-header">
        <h1>{hostname}</h1>
        <span className="stamp">this machine</span>
      </header>
      <main className="site-main grid-bg">
        <section className="plot corner lot">
          <span className="stamp lot-tag">Machine Lot</span>
          <div className="plot-grid">
            {plots.map((p) => (
              <WorkspacePlot key={p.id} plot={p} />
            ))}
          </div>
        </section>
      </main>
      <MachineFooter counts={state.reducer.counts} />
    </>
  );
}
