/**
 * The interval that runs `reconcileWorkspaceProjects` inside Tower (issue #272).
 *
 * Separate from `workspace-projection.ts` on purpose. That module is the decision —
 * which paths are workspaces, what they are called, which titles may be rewritten —
 * and it imports nothing heavier than the workspace key helper, so its rules can be
 * tested without a database, a filesystem or a server. This file is the wiring: it
 * is where `global.db`, `.codev/`, the thread-backend config and a real t3code
 * connection are named.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  openProjectGateway,
  readThreadBackendConfig,
} from './thread-backend.js';
import {
  reconcileWorkspaceProjects,
  type WorkspaceProjectionDeps,
  type WorkspaceProjectionResult,
} from './workspace-projection.js';

/**
 * 30 s, and the interval is doing less work than it looks like.
 *
 * A pass that finds nothing to do is one token exchange and one HTTP GET per
 * configured server — no WebSocket, because the gateway opens one lazily and a pass
 * with no actions never writes. The reason it repeats at all is that the workspace
 * set changes without any Codev command running: a `codev init` elsewhere, a
 * terminal opened in a new checkout.
 */
const DEFAULT_SWEEP_MS = 30_000;

export interface WorkspaceProjectionSweeper {
  /** One pass, awaited. Exposed so a caller can run it without an interval. */
  sweep(): Promise<WorkspaceProjectionResult>;
  start(): void;
  stop(): void;
}

export interface WorkspaceProjectionSweeperOptions {
  /** Every path Codev has recorded. Tower passes `getKnownWorkspacePaths`. */
  knownWorkspacePaths: () => readonly string[];
  log: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
  intervalMs?: number;
  /** Overridden only by tests that must not reach a real server. */
  deps?: Partial<WorkspaceProjectionDeps>;
}

/**
 * Does this path exist, and is it a Codev workspace?
 *
 * `.codev/` is the marker, because it is the directory `codev init` creates and the
 * one the config resolver reads. A path with a `codev/` (our own instance
 * directory) but no `.codev/` is a repository that has never been initialised, and
 * a sidebar heading for it would be a heading for a workspace no Codev command
 * would accept.
 */
export function isCodevWorkspaceDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
  } catch {
    // A path that cannot be stat'd is gone, or is behind a permission we do not
    // have. Either way there is nothing here to project, and this is the ordinary
    // case for a `known_workspaces` row pointing at a deleted checkout.
    return false;
  }
  return existsSync(join(path, '.codev'));
}

export function createWorkspaceProjectionSweeper(
  options: WorkspaceProjectionSweeperOptions,
): WorkspaceProjectionSweeper {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const deps: WorkspaceProjectionDeps = {
    knownWorkspacePaths: options.knownWorkspacePaths,
    isCodevWorkspace: isCodevWorkspaceDirectory,
    serverFor: (workspaceRoot) => {
      // Throws on a half-configured workspace, and that throw is wanted: the sweep
      // records it against the workspace rather than skipping it, because
      // "serverUrl without bootstrapToken" is a mistake and not a decision to stay
      // on PTY. `readThreadBackendConfig` draws that line already.
      const config = readThreadBackendConfig(workspaceRoot);
      if (config === null) return null;
      return { serverUrl: config.serverUrl, bootstrapToken: config.bootstrapToken };
    },
    openGateway: (server) => openProjectGateway(server),
    log: options.log,
    ...options.deps,
  };

  async function sweep(): Promise<WorkspaceProjectionResult> {
    const result = await reconcileWorkspaceProjects(deps);
    for (const failure of result.failures) {
      options.log(
        'WARN',
        `Workspace projection sweep: ${failure}. No workspace is lost by this — the next pass retries.`,
      );
    }
    return result;
  }

  return {
    sweep,
    start() {
      if (timer) return;
      const run = (): void => {
        // ONE PASS AT A TIME. A slow or unreachable server makes a pass outlast its
        // interval, and overlapping passes would both read the same snapshot and
        // both decide to create the same project — which the server refuses, so the
        // second one would be reported as a failure of a sweep that was working.
        if (running) return;
        running = true;
        void sweep()
          .catch((error: unknown) => {
            options.log(
              'ERROR',
              `Workspace projection sweep could not begin: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          })
          .finally(() => {
            running = false;
          });
      };
      timer = setInterval(run, options.intervalMs ?? DEFAULT_SWEEP_MS);
      // Never the reason a process stays alive.
      timer.unref?.();
      // Immediately, the way the thread adoption sweeper does. The first pass is the
      // one that matters most: it is what puts every already-registered workspace in
      // the sidebar after a Tower start, and waiting a full interval for it would
      // leave the tree looking exactly as broken as before for 30 s.
      run();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
