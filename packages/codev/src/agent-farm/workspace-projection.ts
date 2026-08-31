/**
 * Every Codev workspace is a project row, and every project row is named after its
 * directory (issue #272).
 *
 * ## What was wrong
 *
 * A project was created by `initialiseThreadBackend` — the thread-backend CONNECT —
 * and only for the workspace being connected. So a registered workspace nobody had
 * spawned into had no project row, and the sidebar cannot draw a heading for a
 * project that does not exist. "No agent here yet" and "this workspace does not
 * exist" were spelled the same way.
 *
 * Its title was `codev:<absolute path>`, which is what the sidebar heading renders
 * verbatim (a single-member project group's label IS its title). A column of
 * absolute paths does not scan, and at a narrow width every workspace truncates to
 * the same leading characters.
 *
 * ## The shape of the fix
 *
 * A sweep, not a hook on spawn. The set of workspaces Codev knows about changes
 * without any spawn happening — a `codev init`, a terminal opened somewhere new —
 * and a reconciler that re-reads the world is self-healing in a way a one-shot is
 * not.
 *
 * ## One connection per SERVER, not per workspace
 *
 * The obvious implementation is `ensureThreadBackendReady(root)` for every known
 * root: it already creates the project. It also installs a live engine and holds a
 * WebSocket open for the life of the process — so it would open roughly one socket
 * per known workspace, against what is usually one server, to write one row each.
 *
 * So roots are grouped by the server they name, and the gateway below is asked for
 * one per group. Reading is plain HTTP; the socket is opened only when there is
 * actually something to write, which in the steady state is never.
 *
 * ## The core is pure
 *
 * `planWorkspaceProjects` decides; the sweep performs. The decision is where the
 * rules live — which paths are workspaces, what they are called, which titles may
 * be rewritten — and none of it needs a server to test.
 */
import { canonicalWorkspaceKey } from './workspace-key.js';

/** The title form this code wrote before #272. See `isMachineWrittenTitle`. */
export const LEGACY_TITLE_PREFIX = 'codev:';

/** A project as the server reports it. The three fields a reconciler reads. */
export interface ProjectRow {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export type WorkspaceProjectAction =
  | { readonly kind: 'create'; readonly workspaceRoot: string; readonly title: string }
  | { readonly kind: 'rename'; readonly projectId: string; readonly title: string };

/**
 * The display name for one workspace root: its own directory name.
 *
 * Collisions are only visible across the whole set, and `workspaceDisplayNames` is
 * what resolves them. This is the one-root answer it starts from, and the fallback
 * for a root with no segments at all (`/`) — because `project.create` requires a
 * non-empty title, and a blank one would be refused by the server rather than
 * reported here.
 */
export function workspaceLeafName(workspaceRoot: string): string {
  const segments = trailingSegments(workspaceRoot);
  const leaf = segments[segments.length - 1];
  if (leaf !== undefined) return leaf;
  return workspaceRoot.trim() || 'workspace';
}

/**
 * Name every workspace by the shortest trailing path segments that make it unique.
 *
 * `/Users/chris/dev/codev-1455` is `codev-1455`. Two workspaces both called `api`
 * become `backend/api` and `mobile/api` — because two rows reading `api` in a
 * sidebar is the same failure as a column of identical path prefixes, arrived at
 * from the other direction.
 *
 * Deepening is per COLLIDING GROUP, not global: one ambiguous pair does not push
 * every other workspace to two segments. A group that cannot grow any further (two
 * spellings of one directory, which `canonicalWorkspaceKey` should already have
 * collapsed) stops rather than looping.
 *
 * Keyed by the root exactly as it was passed in, so a caller can look up what it
 * handed over without re-canonicalising.
 */
export function workspaceDisplayNames(roots: readonly string[]): Map<string, string> {
  const segmentsByRoot = new Map<string, readonly string[]>();
  for (const root of roots) segmentsByRoot.set(root, trailingSegments(root));

  const depthByRoot = new Map<string, number>();
  for (const root of roots) depthByRoot.set(root, 1);

  const nameFor = (root: string): string => {
    const segments = segmentsByRoot.get(root) ?? [];
    if (segments.length === 0) return root.trim() || 'workspace';
    const depth = Math.min(depthByRoot.get(root) ?? 1, segments.length);
    return segments.slice(segments.length - depth).join('/');
  };

  // Bounded by the deepest path rather than by a guessed constant: each pass either
  // deepens at least one group or stops, and no group can deepen past its own length.
  const maxDepth = Math.max(1, ...roots.map((root) => (segmentsByRoot.get(root) ?? []).length));
  for (let pass = 0; pass < maxDepth; pass += 1) {
    const byName = new Map<string, string[]>();
    for (const root of roots) {
      const name = nameFor(root);
      const existing = byName.get(name);
      if (existing) existing.push(root);
      else byName.set(name, [root]);
    }
    let deepened = false;
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      const canGrow = group.filter(
        (root) => (depthByRoot.get(root) ?? 1) < (segmentsByRoot.get(root) ?? []).length,
      );
      // Every member is already at full depth: these are two spellings of one path,
      // and deepening again would spin without ever separating them.
      if (canGrow.length === 0) continue;
      for (const root of group) depthByRoot.set(root, (depthByRoot.get(root) ?? 1) + 1);
      deepened = true;
    }
    if (!deepened) break;
  }

  return new Map(roots.map((root) => [root, nameFor(root)]));
}

/**
 * Which known paths are Codev workspaces worth projecting.
 *
 * Three filters, and each one is here because the real `known_workspaces` table
 * contains a case it lets through:
 *
 * - `/.builders/` paths are builder worktrees, not workspaces. They are already
 *   filtered out of Tower's v2 workspace list for the same reason.
 * - A path that no longer exists is a deleted checkout whose row was never cleaned
 *   up. Minting a project for it would put a permanent heading in the sidebar for a
 *   directory nobody can open.
 * - A path with no `.codev/` is not a Codev workspace. The table holds parent
 *   directories a terminal was once opened in.
 *
 * De-duplicated on `canonicalWorkspaceKey`, because two spellings of one workspace
 * would otherwise become two projects — the exact failure that key exists to
 * prevent. The first spelling seen wins, and the result is sorted so a sweep's plan
 * does not depend on table order.
 */
export function codevWorkspaceRoots(
  paths: readonly string[],
  isCodevWorkspace: (path: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const path of paths) {
    if (path.includes('/.builders/')) continue;
    if (!isCodevWorkspace(path)) continue;
    const key = canonicalWorkspaceKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(path);
  }
  return roots.sort();
}

/**
 * Is this title one this code wrote, and therefore safe to replace?
 *
 * A sweep that enforced a computed title would undo a rename a human made in the
 * t3code UI, silently, every time it ran. So only two titles are ever rewritten,
 * and both are strings this codebase produces:
 *
 * - `codev:<the project's own workspace root>` — the legacy form. The path is
 *   compared canonically rather than by string, so a project written under `/var`
 *   and stored under `/private/var` is still recognised as ours, while `codev:` in
 *   front of an unrelated path is not.
 * - the workspace's own leaf name — what the thread-backend connect path writes,
 *   which knows one workspace and so cannot see a collision with another. Letting
 *   the sweep deepen that to `backend/api` is a refinement of the same name, not
 *   the loss of somebody's choice; without it, a project created by a spawn would
 *   never converge on the unique name and two sidebar rows would read `api`.
 *
 * Anything else is somebody's decision and is left alone.
 */
export function isMachineWrittenTitle(project: ProjectRow): boolean {
  if (project.title === workspaceLeafName(project.workspaceRoot)) return true;
  if (!project.title.startsWith(LEGACY_TITLE_PREFIX)) return false;
  const claimed = project.title.slice(LEGACY_TITLE_PREFIX.length);
  if (claimed === '') return false;
  return canonicalWorkspaceKey(claimed) === canonicalWorkspaceKey(project.workspaceRoot);
}

/**
 * What one server needs done, given the workspaces pointed at it.
 *
 * Pure. Creates the missing projects and rewrites the legacy titles, and touches
 * nothing else — a project the server has for a workspace this sweep does not know
 * about is left entirely alone, because "I did not enumerate it" is not "it should
 * not exist".
 */
export function planWorkspaceProjects(input: {
  readonly roots: readonly string[];
  readonly names: ReadonlyMap<string, string>;
  readonly projects: readonly ProjectRow[];
}): WorkspaceProjectAction[] {
  const projectByKey = new Map<string, ProjectRow>();
  for (const project of input.projects) {
    const key = canonicalWorkspaceKey(project.workspaceRoot);
    if (!projectByKey.has(key)) projectByKey.set(key, project);
  }

  const actions: WorkspaceProjectAction[] = [];
  for (const root of input.roots) {
    const title = input.names.get(root) ?? workspaceLeafName(root);
    const existing = projectByKey.get(canonicalWorkspaceKey(root));
    if (existing === undefined) {
      actions.push({ kind: 'create', workspaceRoot: root, title });
      continue;
    }
    if (existing.title !== title && isMachineWrittenTitle(existing)) {
      actions.push({ kind: 'rename', projectId: existing.id, title });
    }
  }
  return actions;
}

/**
 * The server side of a sweep, injected so the decision above can be tested without one.
 *
 * `readProjects` is a read and must be cheap; the write methods are allowed to open a
 * connection lazily, which is what keeps a sweep with nothing to do off the socket
 * entirely. `close` is called once per group per sweep whether or not anything was
 * written.
 */
export interface WorkspaceProjectGateway {
  readProjects(): Promise<readonly ProjectRow[]>;
  createProject(workspaceRoot: string, title: string): Promise<void>;
  renameProject(projectId: string, title: string): Promise<void>;
  close(): void;
}

/** The server a group of workspaces shares. Two roots with the same pair share a gateway. */
export interface WorkspaceProjectServer {
  readonly serverUrl: string;
  readonly bootstrapToken: string;
}

export interface WorkspaceProjectionDeps {
  /** Every path Codev has recorded, unfiltered. */
  knownWorkspacePaths: () => readonly string[];
  /** Does this path exist and carry a `.codev/` directory? */
  isCodevWorkspace: (path: string) => boolean;
  /**
   * The server this workspace is thread-backed by, or `null` when it names none.
   *
   * A workspace with no server configured is skipped rather than failed: there is
   * nowhere to project it to, and that is a configuration, not a fault. A config
   * that THROWS (half-configured) is a fault and is reported as one.
   */
  serverFor: (workspaceRoot: string) => WorkspaceProjectServer | null;
  openGateway: (server: WorkspaceProjectServer) => Promise<WorkspaceProjectGateway>;
  log: (level: 'INFO' | 'WARN', message: string) => void;
}

export interface WorkspaceProjectionResult {
  readonly workspaces: number;
  readonly servers: number;
  readonly created: number;
  readonly renamed: number;
  /** One sentence per server group that could not be reconciled. Never thrown. */
  readonly failures: readonly string[];
}

/**
 * Reconcile every known Codev workspace into a project row on its own server.
 *
 * Never throws. This runs on an interval inside Tower, and a server that is down is
 * a "not yet" — the next sweep tries again. A failure in one group does not stop the
 * others, because one unreachable server must not hide every other workspace.
 */
export async function reconcileWorkspaceProjects(
  deps: WorkspaceProjectionDeps,
): Promise<WorkspaceProjectionResult> {
  let paths: readonly string[];
  try {
    paths = deps.knownWorkspacePaths();
  } catch (err) {
    // NOT an empty list. "I could not read the workspaces" reconciles nothing and
    // must not be recorded as "there were none to reconcile".
    return {
      workspaces: 0,
      servers: 0,
      created: 0,
      renamed: 0,
      failures: [`could not list known workspaces: ${describe(err)}`],
    };
  }

  const roots = codevWorkspaceRoots(paths, (path) => {
    try {
      return deps.isCodevWorkspace(path);
    } catch {
      return false;
    }
  });
  const names = workspaceDisplayNames(roots);

  const failures: string[] = [];
  const groups = new Map<string, { server: WorkspaceProjectServer; roots: string[] }>();
  for (const root of roots) {
    let server: WorkspaceProjectServer | null;
    try {
      server = deps.serverFor(root);
    } catch (err) {
      failures.push(`${root}: ${describe(err)}`);
      continue;
    }
    if (server === null) continue;
    const key = `${server.serverUrl} ${server.bootstrapToken}`;
    const existing = groups.get(key);
    if (existing) existing.roots.push(root);
    else groups.set(key, { server, roots: [root] });
  }

  let created = 0;
  let renamed = 0;
  for (const group of groups.values()) {
    let gateway: WorkspaceProjectGateway;
    try {
      gateway = await deps.openGateway(group.server);
    } catch (err) {
      failures.push(`${group.server.serverUrl}: ${describe(err)}`);
      continue;
    }
    try {
      const actions = planWorkspaceProjects({
        roots: group.roots,
        names,
        projects: await gateway.readProjects(),
      });
      for (const action of actions) {
        if (action.kind === 'create') {
          await gateway.createProject(action.workspaceRoot, action.title);
          created += 1;
          deps.log(
            'INFO',
            `Workspace projection: created project "${action.title}" for ${action.workspaceRoot}`,
          );
        } else {
          await gateway.renameProject(action.projectId, action.title);
          renamed += 1;
          deps.log(
            'INFO',
            `Workspace projection: renamed project ${action.projectId} to "${action.title}"`,
          );
        }
      }
    } catch (err) {
      failures.push(`${group.server.serverUrl}: ${describe(err)}`);
    } finally {
      try {
        gateway.close();
      } catch {
        // A gateway that cannot be closed has already reported whatever went wrong
        // through the failure above; a throw here would lose it.
      }
    }
  }

  return { workspaces: roots.length, servers: groups.size, created, renamed, failures };
}

function trailingSegments(workspaceRoot: string): string[] {
  return workspaceRoot.split('/').filter((segment) => segment !== '' && segment !== '.');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
