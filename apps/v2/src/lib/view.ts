import type { AppState } from './stream.js';

export type ViewKind = 'loading' | 'unreachable' | 'mismatch' | 'empty' | 'site';

/**
 * Is there anything drawn? A snapshot has landed and left either nodes or a
 * dark path behind, so there is a tree on the page worth keeping.
 */
export function hasTree(state: AppState): boolean {
  return state.reducer.nodes.size > 0 || state.reducer.darkPaths.size > 0;
}

/*
 * Issue #106. Spec 83 D2: state survives the socket, and a reconnect is not a
 * page reload. A clean EOF already honoured that — it sets `reconnecting` and
 * keeps the tree — while a thrown fetch or a 5xx swapped the whole page for a
 * banner and threw away a tree that was still in state.
 *
 * The rule: once a snapshot has landed, a transport failure keeps the tree on
 * screen and puts the connection state on a strip above it. The full
 * unreachable page is for when there is nothing to show — before the first
 * snapshot, or after a bootstrap failure.
 *
 * D5 is unchanged. Empty, dark and unreachable stay visibly distinct; only
 * *where* unreachable is expressed moves.
 */
export function viewKind(state: AppState): ViewKind {
  if (state.connection === 'unreachable' && !hasTree(state)) return 'unreachable';
  if (state.bootstrap === 'mismatch' || state.reducer.mismatch !== null || state.httpMismatch !== null) {
    return 'mismatch';
  }
  if (state.bootstrap === 'empty') return 'empty';
  if (!hasTree(state)) {
    if (state.connection === 'live') return 'empty';
    return 'loading';
  }
  return 'site';
}
