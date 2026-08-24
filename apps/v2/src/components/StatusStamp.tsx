type Props = { status: string; as?: 'word' | 'dot' };

const CLASS: Record<string, string> = {
  'gate-waiting': 'stamp-gate',
  stalled: 'stamp-stalled',
  running: 'stamp-run',
  offline: 'stamp-offline',
};

function word(status: string): string {
  if (status === 'gate-waiting') return 'GATE';
  if (status === 'stalled') return 'STALLED';
  if (status === 'running') return 'RUN';
  if (status === 'offline') return 'OFF';
  return status;
}

export function StatusStamp({ status, as = 'word' }: Props) {
  const cls = CLASS[status] ?? 'stamp-unknown';
  /* The mockup marks an architect's state with a colour dot, not a word: the
     row already carries a name long enough to crowd. The dot keeps the status
     class so colour discipline and every existing selector still hold. */
  if (as === 'dot') {
    return <span className={`status-dot ${cls}`} role="img" aria-label={word(status)} title={word(status)} />;
  }
  return <span className={`stamp ${cls}`}>{word(status)}</span>;
}
