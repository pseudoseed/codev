import type { GateApprovalHandle } from '../gate/GatePanel.js';
import type { MachineNode } from './build.js';
import { ThreadRowView } from './ThreadRowView.js';

function relative(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * The connection strip.
 *
 * Three states that must never be spelled the same way: connected and current,
 * connected and holding nothing, and disconnected as of a stated time. A subtree
 * that renders its last known state without saying when that state is from reads
 * as a live one, so the timestamp is load-bearing.
 */
function ConnectionStrip({ node, nowMs }: { node: MachineNode; nowMs: number }) {
  const { connection } = node;
  if (connection.status === 'live') {
    return (
      <div className="conn-strip conn-live">
        <span className="stamp conn-word">LIVE</span>
        <span className="conn-detail">
          updated {connection.lastLiveAt ? relative(connection.lastLiveAt, nowMs) : 'just now'}
        </span>
      </div>
    );
  }
  if (connection.status === 'connecting') {
    return (
      <div className="conn-strip conn-connecting">
        <span className="stamp conn-word">CONNECTING</span>
        <span className="conn-detail">no state received yet</span>
      </div>
    );
  }
  /*
   * REVOKED IS ITS OWN BAND, not a shade of disconnected.
   *
   * A withdrawn credential is a decision somebody made; an unreachable server is
   * a fault. Rendering the first as the second sends an operator to check a box
   * that is fine, and leaves them waiting for a reconnection that is never
   * coming — the retry line says so out loud for that reason.
   */
  const revoked = connection.why === 'revoked';
  return (
    <div className={`conn-strip ${revoked ? 'conn-revoked' : 'conn-down'}`}>
      <span className="stamp conn-word">{revoked ? 'ACCESS REVOKED' : 'DISCONNECTED'}</span>
      <span className="conn-detail">
        {connection.lastLiveAt
          ? `last live ${relative(connection.lastLiveAt, nowMs)} · ${connection.lastLiveAt}`
          : 'never connected'}
        {connection.retrying ? ' · retrying' : ' · not retrying'}
      </span>
      {connection.message ? <p className="conn-why">{connection.message}</p> : null}
      {revoked ? (
        <p className="conn-why">
          Reconnecting will not help. This machine needs to be paired again before its subtree
          can be live.
        </p>
      ) : null}
      {connection.signal ? <p className="conn-signal stamp">{connection.signal}</p> : null}
    </div>
  );
}

export function MachineSubtree({ node, nowMs, approval }: {
  node: MachineNode;
  nowMs: number;
  approval?: GateApprovalHandle | null;
}) {
  const down = node.connection.status !== 'live';
  const workspace = node.workspace;
  return (
    <section
      className={`machine${down ? ' machine-down' : ''}`}
      data-machine={node.key}
      data-connection={node.connection.status}
    >
      <header className="machine-head">
        <h2 className="machine-name">{node.label}</h2>
        <span className="machine-origin stamp">{node.origin}</span>
      </header>
      <ConnectionStrip node={node} nowMs={nowMs} />

      {workspace === null ? (
        <p className="empty-note">
          No state has arrived from this machine, so nothing is known about its workspace.
        </p>
      ) : (
        <div className={`workspace${down ? ' is-stale' : ''}`} data-workspace={workspace.path}>
          <div className="workspace-head">
            <span className="stamp workspace-label">workspace</span>
            <span className="workspace-path">{workspace.path}</span>
          </div>
          {down ? (
            <p className="stale-note">
              Showing the last state received. It is not current.
            </p>
          ) : null}

          {workspace.architects.length === 0
            && workspace.unattributedBuilders.length === 0
            && workspace.unmanagedThreads.length === 0 ? (
            <p className="empty-note">
              This machine is connected and reports no architects, builders or threads.
            </p>
          ) : null}

          {workspace.architects.map((group) => (
            <div className="architect-group" key={group.key}>
              <ThreadRowView row={group.architect} approval={approval} />
              <div className="builder-list">
                {group.builders.length === 0 ? (
                  <p className="empty-note nested">No builders under this architect.</p>
                ) : (
                  group.builders.map((row) => <ThreadRowView row={row} approval={approval} key={row.key} />)
                )}
              </div>
            </div>
          ))}

          {workspace.unattributedBuilders.length > 0 ? (
            <div className="architect-group orphan-group">
              <div className="group-label stamp">
                builders with no architect recorded on this machine
              </div>
              <div className="builder-list">
                {workspace.unattributedBuilders.map((row) => (
                  <ThreadRowView row={row} approval={approval} key={row.key} />
                ))}
              </div>
            </div>
          ) : null}

          {workspace.unmanagedThreads.length > 0 ? (
            <div className="architect-group orphan-group">
              <div className="group-label stamp">threads with no Codev identity</div>
              <div className="builder-list">
                {workspace.unmanagedThreads.map((row) => (
                  <ThreadRowView row={row} approval={approval} key={row.key} />
                ))}
              </div>
            </div>
          ) : null}

          {workspace.signals.length > 0 ? (
            <details className="signals">
              <summary className="stamp">
                {workspace.signals.length} state signal{workspace.signals.length === 1 ? '' : 's'}
              </summary>
              <ul>
                {workspace.signals.map((signal, index) => (
                  <li key={`${signal.code}-${index}`}>
                    <span className="stamp signal-code">{signal.code}</span> {signal.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}
