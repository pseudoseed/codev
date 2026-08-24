/**
 * Read-time overlay of porch status.yaml onto an afx builder row.
 *
 * Spawn writes status=implementing / phase=init into global.db and never
 * updates those columns. The live phase lives in the worktree
 * codev/projects directory. Overlay at display time rather than keeping
 * a second write path in sync (issue #109).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Builder } from '../types.js';

const PHASE_LINE = /^phase:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/m;

export function readPorchPhase(worktree: string): string | null {
  if (!worktree) return null;
  const projectsDir = join(worktree, 'codev', 'projects');
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
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
  const phase = readPorchPhase(builder.worktree);
  if (!phase) return builder;
  return {
    ...builder,
    phase,
    status: statusFromPorchPhase(phase, builder.status),
  };
}
