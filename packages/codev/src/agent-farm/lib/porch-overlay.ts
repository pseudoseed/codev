/**
 * Read-time overlay of porch status.yaml onto an afx builder row.
 *
 * Spawn writes status=implementing / phase=init into global.db and never
 * updates those columns. The live phase lives in the worktree
 * codev/projects directory. Overlay at display time rather than keeping
 * a second write path in sync (issue #109).
 *
 * A worktree carries every tracked codev/projects dir from HEAD. The
 * overlay must match the builder's own porch id — first-dir-wins would
 * report an unrelated project's phase (usually `complete` from 0087).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Builder } from '../types.js';

const PHASE_LINE = /^phase:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/m;

export function porchIdFromBuilder(builder: Builder): string | null {
  const dirName = basename(builder.worktree.replace(/[/\\]+$/, ''));
  const fromDir = porchIdFromWorktreeName(dirName);
  if (fromDir) return fromDir;
  if (builder.type === 'bugfix' && builder.issueNumber != null) {
    return `bugfix-${builder.issueNumber}`;
  }
  if (builder.issueNumber != null) return String(builder.issueNumber);
  return null;
}

export function porchIdFromWorktreeName(dirName: string): string | null {
  const bugfix = dirName.match(/^bugfix-(\d+)/);
  if (bugfix) return `bugfix-${bugfix[1]}`;
  const keepPrefix = dirName.match(/^(experiment|maintain)-(\d+)/);
  if (keepPrefix) return `${keepPrefix[1]}-${keepPrefix[2]}`;
  const bare = dirName.match(/^(?:spir|tick|air|aspir|pir)-(\d+)/);
  if (bare) return bare[1];
  const numeric = dirName.match(/^(\d+)(?:-|$)/);
  if (numeric) return numeric[1];
  return null;
}

function dirMatchesProject(dirName: string, projectId: string): boolean {
  if (dirName === projectId || dirName.startsWith(`${projectId}-`)) return true;
  if (/^\d+$/.test(projectId)) {
    const padded = projectId.padStart(4, '0');
    if (dirName === padded || dirName.startsWith(`${padded}-`)) return true;
  }
  return false;
}

export function readPorchPhase(worktree: string, projectId: string | null): string | null {
  if (!worktree || !projectId) return null;
  const projectsDir = join(worktree, 'codev', 'projects');
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!dirMatchesProject(entry.name, projectId)) continue;
    let content: string;
    try {
      content = readFileSync(join(projectsDir, entry.name, 'status.yaml'), 'utf8');
    } catch {
      continue;
    }
    const match = PHASE_LINE.exec(content);
    if (match) return match[1];
  }
  return null;
}

export function statusFromPorchPhase(
  phase: string,
  fallback: Builder['status'],
): Builder['status'] {
  if (phase === 'verified' || phase === 'complete') return 'complete';
  if (phase === 'pr') return 'pr';
  return fallback;
}

export function overlayBuilderFromPorch(builder: Builder): Builder {
  const phase = readPorchPhase(builder.worktree, porchIdFromBuilder(builder));
  if (!phase) return builder;
  return {
    ...builder,
    phase,
    status: statusFromPorchPhase(phase, builder.status),
  };
}
