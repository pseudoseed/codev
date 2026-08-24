import type { ClientCounts } from '../lib/validate.js';

type Props = { counts: ClientCounts | null };

export function MachineFooter({ counts }: Props) {
  if (!counts) return null;
  return (
    <footer className="machine-footer stamp" data-testid="machine-totals">
      Machine totals: {counts.workspaces} workspaces · {counts.builders.total} builders ·{' '}
      {counts.gateWaiting} gate-waiting
    </footer>
  );
}
