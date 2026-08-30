import type { MachineNode } from './build.js';
import { MachineSubtree } from './MachineSubtree.js';

export function Tree({ machines, nowMs }: { machines: readonly MachineNode[]; nowMs: number }) {
  if (machines.length === 0) {
    return (
      <p className="empty-note">
        No machines are configured. The client shows what it is connected to and nothing else.
      </p>
    );
  }
  return (
    <nav className="tree" aria-label="Machines, workspaces, architects and builders">
      {machines.map((node) => <MachineSubtree node={node} nowMs={nowMs} key={node.key} />)}
    </nav>
  );
}
