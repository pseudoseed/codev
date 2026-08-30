import type { AgentMessage, MessageLogReachability } from '../connection/types.js';

function relative(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * The last few messages addressed to an agent — criterion 4's third element.
 *
 * ## Three absences, three sentences
 *
 * An agent with no messages, an agent on a machine whose message log would not
 * open, and an agent on a server too old to send messages at all are three
 * different facts. Spelled the same way, the second and third read as the first,
 * and an operator concludes nobody has said anything to a builder that may have
 * a queue of unread instructions. Each gets its own line.
 *
 * ## A cut body says it was cut
 *
 * The server truncates at a fixed limit and marks the row. Rendering the cut
 * text without the mark turns a partial message into a complete short one, and a
 * message misreported is exactly what this program keeps finding.
 */
export function MessageLog({
  messages,
  log,
  nowMs,
  limit = 3,
}: {
  messages: readonly AgentMessage[] | undefined;
  log: MessageLogReachability;
  nowMs: number;
  limit?: number;
}) {
  if (log === 'unreadable') {
    return (
      <p className="msg-note is-unknown">
        This machine&rsquo;s message log would not open, so this pane cannot say whether
        anything was sent to this agent.
      </p>
    );
  }
  if (log === 'not-provided') {
    return (
      <p className="msg-note is-unknown">
        This server does not report messages. Nothing here means nothing was asked, not
        that nothing was said.
      </p>
    );
  }
  const shown = (messages ?? []).slice(0, limit);
  if (shown.length === 0) {
    return <p className="msg-note is-empty">No messages have been sent to this agent.</p>;
  }
  return (
    <ol className="msg-log">
      {shown.map((message) => (
        <li className={`msg${message.held ? ' is-held' : ''}`} key={message.id}>
          <div className="msg-head">
            <span className="stamp msg-from">{message.from}</span>
            <span className="msg-at" title={message.at}>{relative(message.at, nowMs)}</span>
            {message.held ? <span className="stamp msg-held">HELD</span> : null}
          </div>
          <p className="msg-body">{message.body}</p>
          {message.truncated ? (
            <p className="stamp msg-truncated">CUT — this message is longer than shown</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
