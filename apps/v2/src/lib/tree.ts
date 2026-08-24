import type { DarkEntry } from './reducer.js';
import type { ClientNode } from './validate.js';

export type ArchitectGroup = {
  node: ClientNode;
  builders: ClientNode[];
};

export type WorkspacePlotModel = {
  id: string;
  name: string;
  status: string | null;
  flags: { heldMail: boolean };
  dark: DarkEntry | null;
  architects: ArchitectGroup[];
  builders: ClientNode[];
};

export type TreeModel = {
  plots: WorkspacePlotModel[];
  orphanArchitects: ArchitectGroup[];
  orphanBuilders: ClientNode[];
};

const WS_PREFIX = 'workspace:';

export function workspaceLabel(id: string): string {
  const path = id.startsWith(WS_PREFIX) ? id.slice(WS_PREFIX.length) : id;
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

export function buildTree(
  nodes: Map<string, ClientNode>,
  darkPaths: Map<string, DarkEntry>,
): TreeModel {
  const plots = new Map<string, WorkspacePlotModel>();

  for (const n of nodes.values()) {
    if (n.kind !== 'workspace') continue;
    plots.set(n.id, {
      id: n.id,
      name: n.name,
      status: n.status,
      flags: { ...n.flags },
      dark: darkPaths.get(n.id) ?? null,
      architects: [],
      builders: [],
    });
  }

  for (const [id, entry] of darkPaths) {
    if (plots.has(id)) continue;
    plots.set(id, {
      id,
      name: workspaceLabel(id),
      status: null,
      flags: { heldMail: false },
      dark: entry,
      architects: [],
      builders: [],
    });
  }

  const architects = new Map<string, ArchitectGroup>();
  const orphanArchitects: ArchitectGroup[] = [];
  for (const n of nodes.values()) {
    if (n.kind !== 'architect') continue;
    const group: ArchitectGroup = { node: n, builders: [] };
    architects.set(n.id, group);
    const plot = n.parentId ? plots.get(n.parentId) : undefined;
    if (plot) plot.architects.push(group);
    else orphanArchitects.push(group);
  }

  const orphanBuilders: ClientNode[] = [];
  for (const n of nodes.values()) {
    if (n.kind !== 'builder') continue;
    const underArch = n.parentId ? architects.get(n.parentId) : undefined;
    if (underArch) {
      underArch.builders.push(n);
      continue;
    }
    const plot = n.parentId ? plots.get(n.parentId) : undefined;
    if (plot) plot.builders.push(n);
    else orphanBuilders.push(n);
  }

  return { plots: [...plots.values()], orphanArchitects, orphanBuilders };
}
