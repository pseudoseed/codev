import path from 'node:path';

export function workspaceId(workspacePath: string): string {
  return `workspace:${workspacePath}`;
}

export function architectId(workspacePath: string, architectName: string): string {
  return `architect:${workspacePath}#${architectName}`;
}

export function builderId(workspacePath: string, worktreeDirName: string): string {
  return `builder:${workspacePath}#${worktreeDirName}`;
}

export function worktreeDirName(worktreePath: string): string {
  return path.basename(worktreePath);
}

export function workspaceName(workspacePath: string): string {
  return path.basename(workspacePath);
}

export function workspacePathFromId(id: string): string | null {
  if (id.startsWith('workspace:')) return id.slice('workspace:'.length);
  if (id.startsWith('architect:')) {
    const rest = id.slice('architect:'.length);
    const hash = rest.lastIndexOf('#');
    return hash >= 0 ? rest.slice(0, hash) : rest;
  }
  if (id.startsWith('builder:')) {
    const rest = id.slice('builder:'.length);
    const hash = rest.lastIndexOf('#');
    return hash >= 0 ? rest.slice(0, hash) : rest;
  }
  return null;
}
