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

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "last seen HH:MM:SS", or nothing at all. A tree with no recorded live moment
 * gets no stamp rather than an invented one — an unknown time and a known one
 * must not be spelled the same way.
 *
 * An outage that crosses midnight gets the date as well: a bare clock time on a
 * two-day-old tree reads as today, which is the same failure in a smaller form.
 */
export function lastSeenLabel(lastLiveAt: string | null, now: Date = new Date()): string | null {
  if (!lastLiveAt) return null;
  const d = new Date(lastLiveAt);
  if (Number.isNaN(d.getTime())) return null;
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (sameDay(d, now)) return `last seen ${clock}`;
  return `last seen ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

export function ConnectionStrip({ state }: Props) {
  const lost = state.connection === 'unreachable';
  const auth = lost && state.connectionWhy === 'auth';
  const stamp = lastSeenLabel(state.lastLiveAt);

  let message: string;
  // An auth rejection ends the stream loop, so nothing here will clear on its
  // own. The copy has to say what will: the whole-page banner used to make that
  // unmissable, and a strip that only said "not retrying" would not.
  if (auth) message = 'Auth failed. The tower key was rejected. Reload to retry.';
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
