import type { GateApprovalHandle } from '../gate/GatePanel.js';
import type { MachineNode } from './build.js';
import { MachineSubtree } from './MachineSubtree.js';

export function Tree({ machines, nowMs, approvalFor }: {
  machines: readonly MachineNode[];
  nowMs: number;
  approvalFor?: (machineKey: string) => GateApprovalHandle | null;
}) {
  if (machines.length === 0) {
    return (
      <p className="empty-note">
        No machines are configured. The client shows what it is connected to and nothing else.
      </p>
    );
  }
  return (
    <nav className="tree" aria-label="Machines, workspaces, architects and builders">
      {machines.map((node) => (
        <MachineSubtree
          node={node}
          nowMs={nowMs}
          approval={approvalFor?.(node.key) ?? null}
          key={node.key}
        />
      ))}
    </nav>
  );
}
