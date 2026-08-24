import { useEffect, useState } from 'react';
import { ConnectionBanner } from './components/ConnectionBanner.js';
import { MachineFooter } from './components/MachineFooter.js';
import { MachineRow } from './components/MachineRow.js';
import { SiteHeader } from './components/SiteHeader.js';
import { SiteView } from './components/SiteView.js';
import { connect, initialAppState, type AppState } from './lib/stream.js';
import { viewKind } from './lib/view.js';

export function Page({ state, hostname }: { state: AppState; hostname: string }) {
  const kind = viewKind(state);
  if (kind === 'unreachable') {
    return (
      <div className="page">
        <ConnectionBanner state={state} kind="unreachable" />
      </div>
    );
  }
  if (kind === 'mismatch') {
    return (
      <div className="page">
        <ConnectionBanner state={state} kind="mismatch" />
      </div>
    );
  }
  if (kind === 'empty') {
    return (
      <div className="page">
        <SiteHeader counts={state.reducer.counts} />
        <main className="site-main grid-bg">
          <MachineRow hostname={hostname} connection={state.connection} />
          <p className="empty-copy stamp" data-testid="empty-site">
            No workspaces on this machine.
          </p>
        </main>
        <MachineFooter counts={state.reducer.counts} />
      </div>
    );
  }
  if (kind === 'loading') {
    return (
      <div className="page">
        <SiteHeader counts={state.reducer.counts} />
        <main className="site-main grid-bg">
          <MachineRow hostname={hostname} connection={state.connection} />
          <p className="empty-copy stamp">Loading</p>
        </main>
      </div>
    );
  }
  return (
    <div className="page">
      {state.connection === 'reconnecting' ? (
        <ConnectionBanner state={state} kind="reconnecting" />
      ) : null}
      <SiteView state={state} hostname={hostname} />
    </div>
  );
}

export function App() {
  const [state, setState] = useState<AppState>(initialAppState);
  useEffect(() => {
    const session = connect({ fetch: globalThis.fetch, onState: setState });
    return () => session.stop();
  }, []);
  return <Page state={state} hostname={window.location.hostname} />;
}
