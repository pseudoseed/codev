import { useEffect, useState } from 'react';
import { loadMachines, type MachineConfigLoad } from './config.js';
import { connectMachine, type MachineConfig, type MachineState } from './connection/machine.js';
import { buildTree } from './tree/build.js';
import { Tree } from './tree/Tree.js';

/**
 * One connection per machine, each independently live.
 *
 * The connections are deliberately not merged into one stream: a machine that
 * goes down must fail its own subtree and leave the others alone, which a shared
 * stream cannot express.
 */
export function App() {
  const [load, setLoad] = useState<MachineConfigLoad | null>(null);
  const [states, setStates] = useState<Record<string, MachineState>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void loadMachines().then((result) => { if (!cancelled) setLoad(result); });
    return () => { cancelled = true; };
  }, []);

  const configs: readonly MachineConfig[] = load?.ok ? load.machines : [];

  useEffect(() => {
    if (configs.length === 0) return;
    const links = configs.map((config) => connectMachine(config, {
      fetch: globalThis.fetch.bind(globalThis),
      onState: (state) => setStates((prev) => ({ ...prev, [config.id]: state })),
    }));
    return () => { for (const link of links) link.stop(); };
  }, [configs]);

  // The "last live" age has to keep ageing while the page sits open; a timestamp
  // frozen at the moment of disconnection reads as recent forever.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const machines = buildTree(configs.map((config) => states[config.id]).filter(Boolean));
  const live = machines.filter((machine) => machine.connection.status === 'live').length;

  return (
    <div className="page">
      <header className="app-header">
        <div className="mark">
          <span className="mark-badge">C</span>
          <span className="mark-name">Codev</span>
        </div>
        <span className="mark-rule" />
        <span className="header-register stamp">
          {machines.length} machine{machines.length === 1 ? '' : 's'} · {live} live
        </span>
      </header>
      <main className="app-body">
        {load === null ? (
          <p className="empty-note">Reading machine configuration…</p>
        ) : !load.ok ? (
          <p className="config-error">{load.message}</p>
        ) : (
          <>
            {load.dropped > 0 ? (
              <p className="config-error">
                {load.dropped} configured machine{load.dropped === 1 ? ' was' : 's were'} unreadable
                and {load.dropped === 1 ? 'is' : 'are'} not shown.
              </p>
            ) : null}
            <Tree machines={machines} nowMs={nowMs} />
          </>
        )}
      </main>
    </div>
  );
}
