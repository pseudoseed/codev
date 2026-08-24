import type { AppState } from './stream.js';

export type ViewKind = 'loading' | 'unreachable' | 'mismatch' | 'empty' | 'site';

export function viewKind(state: AppState): ViewKind {
  if (state.connection === 'unreachable') return 'unreachable';
  if (state.bootstrap === 'mismatch' || state.reducer.mismatch !== null || state.httpMismatch !== null) {
    return 'mismatch';
  }
  if (state.bootstrap === 'empty') return 'empty';
  if (state.reducer.nodes.size === 0 && state.reducer.darkPaths.size === 0) {
    if (state.connection === 'live') return 'empty';
    return 'loading';
  }
  return 'site';
}
