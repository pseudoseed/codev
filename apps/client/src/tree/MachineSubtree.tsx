import type { GateApprovalHandle } from '../gate/GatePanel.js';
import type { MachineNode } from './build.js';
// ONE age formatter for the whole client. There were two, and they disagreed:
// the same 240,000 ms read "4m ago" under a row and "240s" at the machine, and a
// one-hour stale entry read "3600s". Two spellings of one number in one view is
// a reader doing arithmetic to check whether they are the same fact.
import { ageWords } from '../status/derive.js';
import type { T3codeObservation, T3codeReachability } from '../connection/types.js';
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
  /*
   * Connected, answering, and telling us it could not read part of what it was
   * about to send. Not LIVE — the tree under it is last-known — and not
   * DISCONNECTED, because the connection is fine and the reason is specific.
   */
  if (connection.status === 'degraded') {
    return (
      <div className="conn-strip conn-degraded">
        <span className="stamp conn-word">STALE</span>
        <span className="conn-detail">
          {connection.lastLiveAt
            ? `last complete ${relative(connection.lastLiveAt, nowMs)} · ${connection.lastLiveAt}`
            : 'no complete snapshot has arrived'}
          {' · connected'}
        </span>
        {connection.message ? <p className="conn-why">{connection.message}</p> : null}
        {connection.signal ? <p className="conn-signal stamp">{connection.signal}</p> : null}
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
  /*
   * A THIRD BAND, because the host reached no verdict at all. Its credential
   * store would not parse, so it could not say whether this machine is
   * authorized — and rendering that as either "disconnected" or "revoked" states
   * something nobody established.
   */
  const indeterminate = connection.why === 'indeterminate';
  const band = revoked ? 'conn-revoked' : indeterminate ? 'conn-indeterminate' : 'conn-down';
  const word = revoked ? 'ACCESS REVOKED' : indeterminate ? 'CANNOT VERIFY' : 'DISCONNECTED';
  return (
    <div className={`conn-strip ${band}`}>
      <span className="stamp conn-word">{word}</span>
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
      {indeterminate ? (
        <p className="conn-why">
          The host could not check this machine&rsquo;s credential, which is not the same as
          refusing it. Still trying; this clears on its own if the store becomes readable.
        </p>
      ) : null}
      {connection.signal ? <p className="conn-signal stamp">{connection.signal}</p> : null}
    </div>
  );
}

/**
 * The machine-level account of why rows cannot report a session.
 *
 * STATED ONCE, HERE, and never repeated under every row: a server-wide cause
 * printed on each line buries the rows that have something specific to say under
 * identical text. Each branch names a different remedy — upgrade the server,
 * configure one, fix the config, wait, wait for a timer, check the server — so
 * none of them may be merged for brevity.
 *
 * `stale` is the branch that must not read as an outage. The server has content
 * and has stopped watching, so the rows still show their last-known word; what
 * this says is how much to trust it.
 */
function sessionVisibilityNote(
  visibility: T3codeReachability,
  observation: T3codeObservation | undefined,
): string {
  const porchIsCurrent = ' Gates and phases come from porch and are current.';
  switch (visibility) {
    case 'not-configured':
      return 'This workspace has no t3code server configured, so no row has a session to report.'
        + porchIsCurrent;
    case 'misconfigured':
      // The server's own words say WHICH part is half-written. Dropping them
      // leaves an operator to go and diff their config to learn what this
      // process already knew.
      return 'This workspace\u2019s t3code configuration is incomplete, so no session could be '
        + `observed${observation?.message ? `: ${observation.message}` : ''}. `
        + 'This is a configuration fault, not an unreachable server.' + porchIsCurrent;
    case 'connecting':
      return 'This server is still connecting to t3code. Session state should appear shortly.'
        + porchIsCurrent;
    case 'cooling-down':
      // WHEN it failed and WHY, not just that it is waiting. "Waiting before it
      // retries" with neither is a status with its evidence removed.
      return 'This server\u2019s last t3code connection failed'
        + `${observation?.since ? ` at ${observation.since}` : ''}`
        + `${observation?.message ? ` (${observation.message})` : ''}`
        + ' and it is waiting before it retries, so session state is unavailable until then.'
        + porchIsCurrent;
    case 'unreachable':
      return 'This machine cannot reach t3code, so no row can say whether its session is '
        + `working, turning or settled${observation?.message ? `: ${observation.message}` : ''}.`
        + porchIsCurrent;
    case 'stale':
      return 'This server has stopped watching t3code. Session words below are last-known, '
        + `observed ${ageWords(observation?.ageMs)} `
        + 'ago, and a row that looked settled is reported as unknown rather than finished.'
        + porchIsCurrent;
    default:
      return 'This server does not report session state, so no row can say whether its session '
        + 'is working, turning or settled.' + porchIsCurrent;
  }
}

export function MachineSubtree({ node, nowMs, approval }: {
  node: MachineNode;
  nowMs: number;
  approval?: GateApprovalHandle | null;
}) {
  // Anything that is not a complete, current snapshot leaves the tree labelled
  // stale — `degraded` included, which is the whole point of having it.
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

          {workspace.sessionVisibility !== 'available' ? (
            <p className="session-note">
              {sessionVisibilityNote(workspace.sessionVisibility, workspace.sessionObservation)}
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
