import { useCallback, useEffect, useState } from 'react';
import { loadMachines, type MachineConfigLoad } from './config.js';
import { connectMachine, type MachineConfig, type MachineState } from './connection/machine.js';
import { approveGate, openHumanSession, type HumanSession } from './gate/approval.js';
import type { GateApprovalHandle } from './gate/GatePanel.js';
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
  /*
   * A human session belongs to ONE machine. Sessions are per host — each server
   * issues and revokes its own — so a single shared session would either be
   * presented to hosts that never issued it, or would silently let one machine's
   * approval stand in for another's. Kept in memory only, never in storage.
   */
  const [sessions, setSessions] = useState<Record<string, HumanSession>>({});

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

  const approvalFor = useCallback((machineKey: string): GateApprovalHandle | null => {
    const config = configs.find((candidate) => candidate.id === machineKey);
    if (!config) return null;
    const session = sessions[machineKey] ?? null;
    const fetchImpl = globalThis.fetch.bind(globalThis);
    return {
      session: session ? { sessionId: session.sessionId } : null,
      openSession: async (pairingToken) => {
        const result = await openHumanSession(fetchImpl, config, pairingToken);
        if (!result.ok) return { ok: false, message: `${result.signal}: ${result.message}` };
        setSessions((prev) => ({ ...prev, [machineKey]: result.session }));
        return { ok: true, message: `session open until ${result.session.expiresAt}` };
      },
      approve: async (gate) => {
        if (!session) return { ok: false, message: 'no human session is open on this machine' };
        const result = await approveGate(fetchImpl, config, session, gate);
        if (result.ok) {
          const approved = `approved on ${result.machine} at ${result.approvedAt}, session ${result.sessionId}`;
          // The gate IS approved. Saying so first, and naming the push failure
          // second, is the difference between a caveat and a retry.
          return {
            ok: true,
            message: result.pushFailed
              ? `${approved} — but not pushed: ${result.pushFailed}. Do not approve again; push from the worktree.`
              : approved,
          };
        }
        /*
         * A session that has ended is DROPPED, so the panel offers a pairing
         * token again. Sessions idle out after 30 minutes; keeping a dead one in
         * state left an Approve button that could only ever fail, and the only
         * way back was to reload the page.
         */
        if (result.sessionEnded) {
          setSessions((prev) => {
            const next = { ...prev };
            delete next[machineKey];
            return next;
          });
          return {
            ok: false,
            message: `${result.signal}: ${result.message} — that session has ended; pair again to approve.`,
          };
        }
        return { ok: false, message: `${result.signal}: ${result.message}` };
      },
    };
  }, [configs, sessions]);

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
            <Tree machines={machines} nowMs={nowMs} approvalFor={approvalFor} />
          </>
        )}
      </main>
    </div>
  );
}
