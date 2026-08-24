type Props = { status: string };

export function StatusStamp({ status }: Props) {
  if (status === 'gate-waiting') return <span className="stamp stamp-gate">GATE</span>;
  if (status === 'stalled') return <span className="stamp stamp-stalled">STALLED</span>;
  if (status === 'running') return <span className="stamp stamp-run">RUN</span>;
  if (status === 'offline') return <span className="stamp stamp-offline">OFF</span>;
  return <span className="stamp stamp-unknown">{status}</span>;
}
