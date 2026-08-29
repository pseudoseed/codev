/**
 * Read-only porch state for codev-agent (Spec 146, Phase 5).
 *
 * A browser cannot read a remote worktree.  This module is the deliberately
 * narrow filesystem boundary: callers name an artifact root, and we read only
 * direct `codev/projects/<project>/status.yaml` children below it. No caller supplied
 * status path is ever followed outside that root, and symlinked project/status
 * entries are rejected rather than followed.
 */

import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeGateRequest } from '../../commands/porch/gate-request.js';
import type { GateStatus } from '../../commands/porch/types.js';

const MAX_STATUS_BYTES = 1024 * 1024;

export type StatusReadSignalCode =
  | 'STATUS_NOT_FOUND'
  | 'STATUS_UNREADABLE'
  | 'STATUS_MALFORMED'
  | 'STATUS_OUT_OF_SCOPE'
  | 'ROOT_MISSING';

export interface AgentStateSignal {
  readonly code: StatusReadSignalCode | string;
  readonly message: string;
  readonly source?: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly role?: 'architect' | 'builder' | 'unmanaged';
  readonly roleId?: string;
}

export interface PorchStatusProjection {
  readonly projectId: string;
  readonly title: string;
  readonly protocol: string;
  readonly phase: string;
  readonly currentPlanPhase: string | null;
  readonly gates: Readonly<Record<string, GateStatus>>;
  /** Phase 8 begins writing this optional join key. */
  readonly threadId?: string;
  readonly updatedAt?: string;
  readonly artifactRoot: string;
  readonly statusPath: string;
}

export type StatusReadResult =
  | { readonly ok: true; readonly status: PorchStatusProjection }
  | { readonly ok: false; readonly signal: AgentStateSignal };

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function normalizeGates(value: unknown): Readonly<Record<string, GateStatus>> {
  if (!plainRecord(value)) throw new Error('gates must be an object');
  const gates: Record<string, GateStatus> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!plainRecord(raw)) throw new Error(`gates.${name} must be an object`);
    if (raw.status !== 'pending' && raw.status !== 'approved') {
      throw new Error(`gates.${name}.status must be pending or approved`);
    }
    const gate: GateStatus = { status: raw.status };
    const requestedAt = optionalString(raw.requested_at, `gates.${name}.requested_at`);
    const approvedAt = optionalString(raw.approved_at, `gates.${name}.approved_at`);
    if (requestedAt !== undefined) gate.requested_at = requestedAt;
    if (approvedAt !== undefined) gate.approved_at = approvedAt;
    if (raw.request !== undefined) gate.request = normalizeGateRequest(raw.request);
    gates[name] = gate;
  }
  return gates;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function failure(
  code: StatusReadSignalCode,
  message: string,
  source: string,
): StatusReadResult {
  return { ok: false, signal: { code, message, source } };
}

/**
 * Read one status file after proving it is a direct project child of the root.
 * Exported so route and integration tests exercise the same boundary.
 */
export function readScopedStatus(artifactRoot: string, statusPath: string): StatusReadResult {
  const root = resolve(artifactRoot);
  const projectsRoot = resolve(root, 'codev', 'projects');
  const candidate = resolve(statusPath);
  const rel = relative(projectsRoot, candidate).split(sep);
  if (!isWithin(projectsRoot, candidate) || rel.length !== 2 || rel[1] !== 'status.yaml') {
    return failure(
      'STATUS_OUT_OF_SCOPE',
      `Refusing status path outside a direct codev/projects child: ${candidate}`,
      candidate,
    );
  }

  try {
    // Reject symlink traversal.  The browser needs porch state, not an arbitrary
    // file a compromised worktree arranged to point at.
    if (lstatSync(join(projectsRoot, rel[0])).isSymbolicLink() || lstatSync(candidate).isSymbolicLink()) {
      return failure('STATUS_OUT_OF_SCOPE', 'Symlinked porch state is not served', candidate);
    }
    const realProjects = realpathSync(projectsRoot);
    const realCandidate = realpathSync(candidate);
    if (!isWithin(realProjects, realCandidate)) {
      return failure('STATUS_OUT_OF_SCOPE', 'Resolved porch state escapes its artifact root', candidate);
    }

    const source = readFileSync(candidate);
    if (source.byteLength > MAX_STATUS_BYTES) {
      return failure(
        'STATUS_MALFORMED',
        `status.yaml exceeds the ${MAX_STATUS_BYTES}-byte service limit`,
        candidate,
      );
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
    const parsed = yaml.load(decoded);
    if (!plainRecord(parsed)) throw new Error('document must be an object');

    const projectId = requiredString(parsed.id, 'id');
    const threadId = optionalString(parsed.thread_id, 'thread_id');
    const status: PorchStatusProjection = {
      projectId,
      title: typeof parsed.title === 'string' ? parsed.title : rel[0],
      protocol: requiredString(parsed.protocol, 'protocol'),
      phase: requiredString(parsed.phase, 'phase'),
      currentPlanPhase: parsed.current_plan_phase === null || parsed.current_plan_phase === undefined
        ? null
        : requiredString(parsed.current_plan_phase, 'current_plan_phase'),
      gates: normalizeGates(parsed.gates ?? {}),
      ...(threadId === undefined ? {} : { threadId }),
      ...(typeof parsed.updated_at === 'string' ? { updatedAt: parsed.updated_at } : {}),
      artifactRoot: root,
      statusPath: candidate,
    };
    return { ok: true, status };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === 'ENOENT') {
      return failure('STATUS_NOT_FOUND', 'status.yaml does not exist', candidate);
    }
    if (errno.code === 'EACCES' || errno.code === 'EPERM') {
      return failure('STATUS_UNREADABLE', `status.yaml cannot be read: ${errno.code}`, candidate);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return failure('STATUS_MALFORMED', `status.yaml is malformed: ${detail}`, candidate);
  }
}

/** Enumerate status files for one artifact root without crossing its boundary. */
export function readStatusesFromArtifactRoot(artifactRoot: string): StatusReadResult[] {
  const root = resolve(artifactRoot);
  try {
    statSync(root);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === 'ENOENT') {
      return [failure(
        'ROOT_MISSING',
        `Artifact root does not exist: ${root}`,
        root,
      )];
    }
    return [failure(
      'STATUS_UNREADABLE',
      `Artifact root cannot be read: ${errno.code ?? String(error)}`,
      root,
    )];
  }
  const projectsRoot = join(root, 'codev', 'projects');
  let entries: Dirent[];
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    // A live root with no porch projects is a real empty result. A missing
    // root already returned ROOT_MISSING above; do not spell that as [].
    if (errno.code === 'ENOENT') return [];
    return [failure(
      'STATUS_UNREADABLE',
      `Porch projects directory cannot be read: ${errno.code ?? String(error)}`,
      projectsRoot,
    )];
  }

  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readScopedStatus(root, join(projectsRoot, entry.name, 'status.yaml')));
}

/** Read the workspace plus each distinct builder worktree registered beneath it. */
export function readWorkspaceStatuses(
  workspacePath: string,
  builderWorktrees: readonly string[],
): StatusReadResult[] {
  const roots = new Set<string>([resolve(workspacePath), ...builderWorktrees.map((root) => resolve(root))]);
  return [...roots].flatMap(readStatusesFromArtifactRoot);
}
