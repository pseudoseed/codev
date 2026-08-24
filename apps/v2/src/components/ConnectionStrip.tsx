import type { AppState } from '../lib/stream.js';

type Props = { state: AppState };

/*
 * The connection state, expressed over a tree that is still on the page
 * (#106). The full-page ConnectionBanner is for when there is no tree; this
 * strip is for when there is one, and its job is to keep the tree readable
 * while saying plainly that it is no longer current.
 *
 * Colour discipline (spec 83): rust belongs to gates and nothing else, so a
 * lost connection is ochre — something may be wrong, nobody is blocked.
 */

function clockTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * "last seen HH:MM:SS", or nothing at all. A tree with no recorded live moment
 * gets no stamp rather than an invented one — an unknown time and a known one
 * must not be spelled the same way.
 */
export function lastSeenLabel(lastLiveAt: string | null): string | null {
  if (!lastLiveAt) return null;
  const t = clockTime(lastLiveAt);
  return t ? `last seen ${t}` : null;
}

export function ConnectionStrip({ state }: Props) {
  const lost = state.connection === 'unreachable';
  const auth = lost && state.connectionWhy === 'auth';
  const stamp = lastSeenLabel(state.lastLiveAt);

  let message: string;
  if (auth) message = 'Auth failed. The tower key was rejected. Not retrying.';
  else if (lost) message = 'Cannot reach Tower. Retrying.';
  else message = 'Reconnecting';

  return (
    <div
      className={lost ? 'conn-strip conn-strip-lost stamp' : 'conn-strip stamp'}
      data-testid={lost ? 'connection-lost' : 'reconnecting'}
      role="status"
    >
      <span className={lost ? 'dot dot-lost' : 'dot dot-off'} aria-hidden="true" />
      <span className="conn-strip-msg">{message}</span>
      <span className="conn-strip-stale">
        {stamp ? `showing the last known tree · ${stamp}` : 'showing the last known tree'}
      </span>
    </div>
  );
}
