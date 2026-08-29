/**
 * Porch State Management
 *
 * Handles project state persistence with atomic writes.
 * Fails loudly on any error - no guessing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectState, Protocol, PlanPhase } from './types.js';
import type { ArtifactResolver } from './artifacts.js';
import { detectProjectIdFromCwd } from './project-id.js';

const execFileAsync = promisify(execFile);

/** Directory for project state (relative to project root) */
export const PROJECTS_DIR = 'codev/projects';

// ============================================================================
// ID / Name Utilities
// ============================================================================

/**
 * Strip the project ID prefix from a title string.
 * Handles zero-padded IDs: stripIdPrefix('0364-terminal-refresh', '364') → 'terminal-refresh'
 */
export function stripIdPrefix(title: string, projectId: string): string {
  const normalizedId = projectId.replace(/^0+/, '') || '0';
  return title.replace(new RegExp(`^0*${normalizedId}-`), '');
}

/**
 * Resolve the canonical artifact base name (e.g. "0364-terminal-refresh-button")
 * by looking up the actual spec file on disk. Falls back to `${projectId}-${cleanTitle}`.
 *
 * This prevents doubled IDs like "364-0364-name" when state.id is unpadded
 * but spec files use zero-padded IDs.
 */
export function resolveArtifactBaseName(
  workspaceRoot: string, projectId: string, title: string,
  resolver?: ArtifactResolver
): string {
  // When a resolver is provided, delegate to it first
  if (resolver) {
    const resolved = resolver.findSpecBaseName(projectId, title);
    if (resolved) return resolved;
    // Fall through to ID-based fallback
    const cleanTitle = stripIdPrefix(title, projectId);
    return `${projectId}-${cleanTitle}`;
  }

  // Legacy: scan codev/specs/ directory directly
  const isNumericId = /^\d+$/.test(projectId);
  if (isNumericId) {
    const specsDir = path.join(workspaceRoot, 'codev', 'specs');
    if (fs.existsSync(specsDir)) {
      const normalizedId = projectId.replace(/^0+/, '') || '0';
      try {
        const files = fs.readdirSync(specsDir);
        const specFile = files.find(f => {
          if (!f.endsWith('.md')) return false;
          const numMatch = f.match(/^(\d+)/);
          if (!numMatch) return false;
          return (numMatch[1].replace(/^0+/, '') || '0') === normalizedId;
        });
        if (specFile) {
          return specFile.replace(/\.md$/, '');
        }
      } catch { /* ignore */ }
    }
  }
  // Fallback: strip any existing ID prefix from title, then prepend projectId
  const cleanTitle = stripIdPrefix(title, projectId);
  return `${projectId}-${cleanTitle}`;
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get the project directory path
 */
export function getProjectDir(workspaceRoot: string, projectId: string, name: string): string {
  return path.join(workspaceRoot, PROJECTS_DIR, `${projectId}-${stripIdPrefix(name, projectId)}`);
}

/**
 * Get the status.yaml path for a project
 */
export function getStatusPath(workspaceRoot: string, projectId: string, name: string): string {
  return path.join(getProjectDir(workspaceRoot, projectId, name), 'status.yaml');
}

/**
 * Derive the artifact root (worktree root) from a status.yaml path.
 * Status paths are always <artifactRoot>/codev/projects/<id>-<name>/status.yaml,
 * so the artifact root is three levels up from the containing directory.
 *
 * Used by commands that must resolve specs/plans/reviews relative to the
 * worktree that owns the status file (bugfix #676). `findStatusPath` already
 * searches `.builders/*` first, so this matches its resolution.
 */
export function getArtifactRoot(statusPath: string): string {
  return path.resolve(path.dirname(statusPath), '..', '..', '..');
}

// ============================================================================
// State Operations
// ============================================================================

/**
 * Read project state from status.yaml
 * Fails loudly if file is missing or corrupted.
 */
export function readState(statusPath: string): ProjectState {
  if (!fs.existsSync(statusPath)) {
    throw new Error(`Project not found: ${statusPath}\nRun 'porch init' to create a new project.`);
  }

  try {
    const content = fs.readFileSync(statusPath, 'utf-8');
    const state = yaml.load(content) as ProjectState;

    // Basic validation
    if (!state || typeof state !== 'object') {
      throw new Error('Invalid state file: not an object');
    }
    if (!state.id || !state.protocol || !state.phase) {
      throw new Error('Invalid state file: missing required fields (id, protocol, phase)');
    }

    // Spec 653: backward compat migration — rename 'complete' → 'verified'
    // Universal: applies to ALL protocols, not just those with a verify phase.
    // readState is pure — it migrates in-memory but does NOT write to disk.
    // Callers that mutate state will commit the migrated value via writeStateAndCommit.
    if (state.phase === 'complete') {
      state.phase = 'verified';
    }

    return state;
  } catch (err) {
    if (err instanceof yaml.YAMLException) {
      throw new Error(`Invalid state file: YAML parse error\n${err.message}`);
    }
    throw err;
  }
}

/**
 * Write project state atomically (tmp file + rename)
 */
export function writeState(statusPath: string, state: ProjectState): void {
  const dir = path.dirname(statusPath);
  const tmpPath = `${statusPath}.tmp`;

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  // Update timestamp
  state.updated_at = new Date().toISOString();

  // Write to temp file then rename (atomic)
  const content = yaml.dump(state, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, statusPath);
}

export function recordThreadId(statusPath: string, threadId: string): void {
  const state = readState(statusPath);
  state.thread_id = threadId;
  writeState(statusPath, state);
}

/**
 * Write state and commit+push to git.
 * Uses execFile with args array (no shell injection risk).
 * Uses `git push -u origin HEAD` so new branches get upstream tracking.
 *
 * Spec 653 §B.3: every phase transition, gate request, gate approval,
 * and verify skip must commit and push status.yaml. Zero gaps.
 */
export async function writeStateAndCommit(
  statusPath: string,
  state: ProjectState,
  message: string,
): Promise<void> {
  writeState(statusPath, state);

  // Find the worktree root (status path is <root>/codev/projects/<id>/status.yaml)
  const worktreeRoot = path.resolve(path.dirname(statusPath), '..', '..', '..');

  // Skip git operations in test environment (vitest sets VITEST=true).
  // State mutation is still tested; only the git IO is skipped.
  if (process.env.VITEST) {
    return;
  }

  try {
    await execFileAsync('git', ['add', statusPath], { cwd: worktreeRoot });
    await execFileAsync('git', ['commit', '-m', message], { cwd: worktreeRoot });
    await execFileAsync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: worktreeRoot });
  } catch (err: unknown) {
    // If git commit fails because nothing changed, that's a logic bug — don't mask it.
    // If git push fails (network, auth), surface the error clearly.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`writeStateAndCommit failed: ${msg}`);
  }
}

/**
 * Create initial state for a new project.
 *
 * Always starts at the first protocol phase. If artifacts (spec, plan)
 * already exist with approval metadata (YAML frontmatter), the run loop
 * will detect this and skip those phases automatically.
 */
export function createInitialState(
  protocol: Protocol,
  projectId: string,
  title: string,
  _workspaceRoot?: string
): ProjectState {
  const now = new Date().toISOString();

  // Initialize gates from protocol
  const gates: ProjectState['gates'] = {};
  for (const phase of protocol.phases) {
    if (phase.gate) {
      gates[phase.gate] = { status: 'pending' };
    }
  }

  const initialPhase = protocol.phases[0]?.id || 'specify';

  return {
    id: projectId,
    title,
    protocol: protocol.name,
    phase: initialPhase,
    plan_phases: [],
    current_plan_phase: null,
    gates,
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: now,
    updated_at: now,
  };
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Search a single codev/projects/ directory for a matching project.
 */
function findProjectInDir(projectsDir: string, projectId: string): string | null {
  if (!fs.existsSync(projectsDir)) return null;

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === projectId || entry.name.startsWith(`${projectId}-`))) {
      const statusPath = path.join(projectsDir, entry.name, 'status.yaml');
      if (fs.existsSync(statusPath)) {
        return statusPath;
      }
    }
  }

  return null;
}

/**
 * Walk up from cwd until `codev/projects` exists. `cli()` used `process.cwd()`
 * as the workspace root, so `porch done` from `packages/codev` reported
 * "Project N not found" for a project that existed two levels up (#151).
 *
 * Looks for `codev/projects` specifically, not a child named `codev`, because
 * walking from `packages/codev` would otherwise stop at `packages/` (air-1238).
 */
export function resolvePorchWorkspaceRoot(startDir: string = process.cwd()): string {
  const start = path.resolve(startDir);
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, PROJECTS_DIR))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * Find status.yaml by project ID.
 * Searches .builders/ worktrees FIRST (active, up-to-date state),
 * then falls back to local codev/projects/ (main — may be stale after merge).
 *
 * Spec 653: in multi-PR workflows, early phases merge status.yaml to main,
 * which becomes stale. Worktree copies are always the most recent.
 */
export function findStatusPath(
  workspaceRoot: string,
  projectId: string,
  opts?: { alias?: boolean },
): string | null {
  // 1. Search builder worktrees first (.builders/*/codev/projects/)
  // These have the most up-to-date state in multi-PR workflows.
  const buildersDir = path.join(workspaceRoot, '.builders');
  if (fs.existsSync(buildersDir)) {
    const worktrees = fs.readdirSync(buildersDir, { withFileTypes: true });
    for (const wt of worktrees) {
      if (!wt.isDirectory()) continue;
      const result = findProjectInDir(path.join(buildersDir, wt.name, PROJECTS_DIR), projectId);
      if (result) return result;
    }
  }

  // 2. Fall back to local codev/projects/ (main copy)
  const localResult = findProjectInDir(path.join(workspaceRoot, PROJECTS_DIR), projectId);
  if (localResult) return localResult;

  // 3. Bare issue number → unique prefixed porch id (bugfix-109, experiment-63, …).
  // Exact `109` / `109-*` already won above. Alias only when that miss is unique.
  // Off for existence checks (`porch init`): a leftover bugfix-109 on main
  // must not block `porch init pir 109`.
  if ((opts?.alias ?? true) && /^\d+$/.test(projectId)) {
    const aliases = listPrefixedAliases(workspaceRoot, projectId);
    if (aliases.length === 1) return aliases[0].statusPath;
  }

  return null;
}

function isPrefixedNumericId(id: string, numericId: string): boolean {
  const dash = id.lastIndexOf('-');
  if (dash <= 0) return false;
  const prefix = id.slice(0, dash);
  const rest = id.slice(dash + 1);
  return /^[a-z]+$/i.test(prefix) && rest === numericId;
}

export function listPrefixedAliases(
  workspaceRoot: string,
  numericId: string,
): Array<{ id: string; statusPath: string }> {
  return listAllProjects(workspaceRoot)
    .filter((p) => isPrefixedNumericId(p.state.id, numericId))
    .map((p) => ({ id: p.state.id, statusPath: p.statusPath }));
}

export function projectNotFoundMessage(workspaceRoot: string, projectId: string): string {
  const aliases = /^\d+$/.test(projectId)
    ? listPrefixedAliases(workspaceRoot, projectId).map((a) => a.id)
    : [];
  if (aliases.length > 0) {
    const quoted = aliases.map((id) => `'${id}'`).join(' or ');
    return `Project ${projectId} not found. Did you mean ${quoted}?`;
  }
  return `Project ${projectId} not found.\nRun 'porch init' to create a new project.`;
}

/**
 * Enumerate every project on disk, parsing each status.yaml.
 *
 * Precedence matches findStatusPath(): `.builders/<x>/codev/projects/<id>` wins
 * over `codev/projects/<id>` when the same project id appears in both. In
 * multi-PR flows (Spec 653) early phases merge status.yaml to main, so the
 * worktree copy is the fresher one.
 *
 * status.yaml files that fail to parse are skipped. Callers can observe these
 * skips by passing `onParseError`; otherwise failures are silent.
 */
export function listAllProjects(
  workspaceRoot: string,
  opts?: { onParseError?: (statusPath: string, err: unknown) => void },
): Array<{ statusPath: string; state: ProjectState }> {
  const collected = new Map<string, { statusPath: string; state: ProjectState }>();

  const addFromDir = (projectsDir: string): void => {
    if (!fs.existsSync(projectsDir)) return;
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statusPath = path.join(projectsDir, entry.name, 'status.yaml');
      if (!fs.existsSync(statusPath)) continue;
      try {
        const state = readState(statusPath);
        if (!collected.has(state.id)) {
          collected.set(state.id, { statusPath, state });
        }
      } catch (err) {
        opts?.onParseError?.(statusPath, err);
      }
    }
  };

  // 1. Builder worktrees first (freshest in multi-PR layouts)
  const buildersDir = path.join(workspaceRoot, '.builders');
  if (fs.existsSync(buildersDir)) {
    for (const wt of fs.readdirSync(buildersDir, { withFileTypes: true })) {
      if (!wt.isDirectory()) continue;
      addFromDir(path.join(buildersDir, wt.name, PROJECTS_DIR));
    }
  }

  // 2. Local main copy
  addFromDir(path.join(workspaceRoot, PROJECTS_DIR));

  return [...collected.values()];
}

/**
 * Detect project ID from the current working directory if inside a builder worktree.
 * Works from any subdirectory within the worktree.
 * Returns the porch project ID (e.g. "bugfix-237", "1298", or "0073"), or null if not in a recognized worktree.
 */
// Moved to ./project-id.ts (issue #41) and re-exported here so existing
// importers are unaffected. It lives in a leaf module now because importing
// THIS file pulls in `execFile` via `writeStateAndCommit`, which is more than a
// pure path-to-id rule should cost a caller.
//
// Imported as well as re-exported: `export { x } from` does NOT bind the name
// in this module's scope, and `resolveProjectId` below calls it directly.
export { detectProjectIdFromCwd };

export type ResolvedProjectId = { id: string; source: 'explicit' | 'cwd' | 'filesystem' };

/**
 * Resolve project ID using the priority chain:
 * 1. Explicit CLI argument (highest priority)
 * 2. CWD worktree detection
 * 3. Filesystem scan fallback
 * 4. Error if none succeed
 */
export function resolveProjectId(
  provided: string | undefined,
  cwd: string,
  workspaceRoot: string,
): ResolvedProjectId {
  // 1. Explicit CLI argument (highest priority)
  if (provided) return { id: provided, source: 'explicit' };

  // 2. CWD worktree detection
  const fromCwd = detectProjectIdFromCwd(cwd);
  if (fromCwd) return { id: fromCwd, source: 'cwd' };

  // 3. Filesystem scan fallback
  const detected = detectProjectId(workspaceRoot);
  if (detected) return { id: detected, source: 'filesystem' };

  // 4. Error — none of the detection methods succeeded
  throw new Error('Cannot determine project ID. Provide it explicitly or run from a builder worktree.');
}

/**
 * Auto-detect project ID when only one project exists.
 * Returns null if zero or multiple projects found.
 */
export function detectProjectId(workspaceRoot: string): string | null {
  const projectsDir = path.join(workspaceRoot, PROJECTS_DIR);

  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const projects: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Extract project ID from directory name
      // Matches: "0076-skip-close" -> "0076", "bugfix-237-fix-name" -> "bugfix-237"
      const match = entry.name.match(/^(bugfix-\d+|\d{4})-/);
      if (match) {
        const statusPath = path.join(projectsDir, entry.name, 'status.yaml');
        if (fs.existsSync(statusPath)) {
          projects.push(match[1]);
        }
      }
    }
  }

  // Only return if exactly one project
  return projects.length === 1 ? projects[0] : null;
}
