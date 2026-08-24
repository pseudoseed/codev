import type { AppState } from '../lib/stream.js';

type Props = { state: AppState; kind: 'unreachable' | 'mismatch' | 'reconnecting' };

export function ConnectionBanner({ state, kind }: Props) {
  if (kind === 'reconnecting') {
    return <div className="reconnecting stamp">Reconnecting</div>;
  }
  if (kind === 'unreachable') {
    const auth = state.connectionWhy === 'auth';
    return (
      <div className="banner" data-testid="unreachable">
        <h2>{auth ? 'Auth failed' : 'Cannot reach Tower'}</h2>
        <p>{auth ? 'The tower key was rejected.' : 'The connection failed. Retrying.'}</p>
      </div>
    );
  }
  const frame = state.reducer.mismatch;
  const boot = state.bootstrapMismatch;
  const http = state.httpMismatch;
  let detail = 'The client cannot read this contract.';
  if (http) detail = `HTTP ${http.status}`;
  else if (boot) detail = boot.how + (boot.preview ? `: ${boot.preview}` : '');
  else if (frame) {
    if (frame.how === 'invalid-json') {
      detail = `invalid JSON after cursor ${frame.afterSeq}` + (frame.preview ? `: ${frame.preview}` : '');
    } else {
      detail = [frame.type, frame.seq, frame.field].filter((x) => x !== undefined).join(' · ');
    }
  }
  return (
    <div className="banner" data-testid="mismatch">
      <h2>Contract mismatch</h2>
      <p>{detail}</p>
    </div>
  );
}
