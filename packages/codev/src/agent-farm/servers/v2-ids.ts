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
