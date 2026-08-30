import type { GateApprovalHandle } from '../gate/GatePanel.js';
import type { MessageLogReachability } from '../connection/types.js';
import type { MachineNode, ThreadRow, WorkspaceNode } from '../tree/build.js';

/**
 * A pane and the machine facts it needs, flattened across every machine.
 *
 * The tree groups by machine because that is what the tree is for. The grid does
 * not: six builders tile as six tiles whether they came from one host or three,
 * and a grid that boxed each machine separately could not produce the 3x2 the
 * criterion names as soon as a second machine appeared.
 *
 * What the machine boundary still carries is per-machine and travels with each
 * pane: whether that host's snapshot is current, whether its message log could
 * be read, and which approval handle a gate on that pane must use. A shared
 * handle would let one machine's session stand in for another's.
 */
export interface PaneItem {
  readonly row: ThreadRow;
  readonly messageLog: MessageLogReachability;
  /**
   * Whether that machine could see session state. Carried per pane and stated
   * ONCE above the grid: six rows reading UNKNOWN with no cause anywhere on the
   * screen is how a working client reads as a broken one.
   */
  readonly sessionVisibility: WorkspaceNode['sessionVisibility'];
  /** True when this machine's snapshot is not current, so the pane says so. */
  readonly stale: boolean;
  readonly approval: GateApprovalHandle | null;
}

export interface Collected {
  readonly builders: readonly PaneItem[];
  readonly architects: readonly PaneItem[];
  /**
   * One sentence per distinct reason a machine cannot report session state.
   * Distinct rather than per-machine: two machines with the same cause is one
   * fact, and repeating it is what buried the specific notes in the tree.
   */
  readonly sessionNotes: readonly string[];
  /** True once more than one machine is configured; panes then carry a machine tag. */
  readonly multiMachine: boolean;
}

/** Gates first, then by name: a pane waiting on a human belongs where one looks first. */
function order(items: PaneItem[]): PaneItem[] {
  return [...items].sort((a, b) => {
    const blocked = Number(b.row.status.kind === 'blocked') - Number(a.row.status.kind === 'blocked');
    if (blocked !== 0) return blocked;
    const machine = a.row.machine.localeCompare(b.row.machine);
    return machine !== 0 ? machine : a.row.name.localeCompare(b.row.name);
  });
}

export function collectPanes(
  machines: readonly MachineNode[],
  approvalFor?: (machineKey: string) => GateApprovalHandle | null,
): Collected {
  const builders: PaneItem[] = [];
  const architects: PaneItem[] = [];

  for (const machine of machines) {
    const workspace = machine.workspace;
    if (!workspace) continue;
    const stale = machine.connection.status !== 'live';
    const approval = approvalFor?.(machine.key) ?? null;
    const messageLog = workspace.messageLog;
    const sessionVisibility = workspace.sessionVisibility;
    const push = (row: ThreadRow) => {
      const item: PaneItem = { row, messageLog, sessionVisibility, stale, approval };
      (row.role === 'architect' ? architects : builders).push(item);
    };
    for (const group of workspace.architects) {
      push(group.architect);
      for (const row of group.builders) push(row);
    }
    for (const row of workspace.unattributedBuilders) push(row);
    // Unmanaged threads tile as builders. They are work in the workspace; a
    // filtered-out row is the one failure mode the tree was built to avoid.
    for (const row of workspace.unmanagedThreads) push(row);
  }

  const sessionNotes = new Set<string>();
  for (const item of [...builders, ...architects]) {
    if (item.sessionVisibility === 'unreachable') {
      sessionNotes.add(
        'A machine here cannot reach t3code, so no pane on it can say whether its session is '
        + 'working, turning or settled. Gates and phases come from porch and are current.',
      );
    } else if (item.sessionVisibility === 'not-provided') {
      sessionNotes.add(
        'A server here does not report session state, so no pane on it can say whether its '
        + 'session is working, turning or settled. Gates and phases come from porch and are current.',
      );
    }
  }

  return {
    builders: order(builders),
    architects: order(architects),
    sessionNotes: [...sessionNotes],
    multiMachine: machines.length > 1,
  };
}
