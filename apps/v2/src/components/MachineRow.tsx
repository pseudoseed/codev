import type { ConnectionState } from '../lib/stream.js';

type Props = { hostname: string; connection: ConnectionState };

/*
 * The mockup labels each machine "Mac Studio · foreman's rig" and stamps it
 * "online · 41% load". The stream carries neither a hardware description nor
 * a load figure, so this row states the two facts that exist: which machine
 * this is, and whether its stream is live.
 */
export function MachineRow({ hostname, connection }: Props) {
  const live = connection === 'live';
  return (
    <div className="machine-row" data-testid="machine-row">
      <span className={live ? 'dot dot-online' : 'dot dot-off'} aria-hidden="true" />
      <h1 className="machine-name">{hostname}</h1>
      <span className="stamp machine-meta">this machine</span>
      <span className={live ? 'stamp machine-status online' : 'stamp machine-status off'}>
        {live ? 'online' : connection}
      </span>
    </div>
  );
}
