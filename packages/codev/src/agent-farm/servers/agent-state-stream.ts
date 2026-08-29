/** Filesystem-backed porch state stream for codev-agent (Spec 146, Phase 5). */

import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import type http from 'node:http';
import type { AgentStateSignal } from './status-reader.js';

export interface AgentStreamSnapshot<T> {
  readonly payload: T;
  /** Workspace and builder artifact roots represented by payload. */
  readonly artifactRoots: readonly string[];
}

export interface AgentStateStreamEvent<T> {
  readonly type: 'PROTOCOL_STATE_SNAPSHOT' | 'STATE_STREAM_WATCH_FAILED';
  readonly sequence: number;
  readonly at: string;
  readonly snapshot?: T;
  readonly signal?: AgentStateSignal;
}

export interface StateSubscription {
  close(): void;
}

export interface StateStreamOptions<T> {
  readonly workspacePath: string;
  readonly snapshot: () => AgentStreamSnapshot<T>;
  readonly onEvent: (event: AgentStateStreamEvent<T>) => void;
  readonly debounceMs?: number;
}

/**
 * Watch project directories rather than status files themselves: porch writes
 * atomically by renaming `status.yaml.tmp`, which replaces the inode and would
 * strand a file-level watcher after the first update.
 */
export function watchAgentState<T>(options: StateStreamOptions<T>): StateSubscription {
  const watchers = new Map<string, FSWatcher>();
  const debounceMs = options.debounceMs ?? 30;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let closed = false;

  const closeWatchers = (): void => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };

  const emitFailure = (path: string, error: unknown): void => {
    options.onEvent({
      type: 'STATE_STREAM_WATCH_FAILED',
      sequence: ++sequence,
      at: new Date().toISOString(),
      signal: {
        code: 'STATE_STREAM_WATCH_FAILED',
        message: `Cannot watch porch state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        source: path,
      },
    });
  };

  const watchedDirectories = (artifactRoots: readonly string[]): string[] => {
    const directories = new Set<string>();
    const buildersRoot = join(resolve(options.workspacePath), '.builders');
    if (existsSync(buildersRoot)) directories.add(buildersRoot);
    for (const artifactRoot of artifactRoots) {
      const projects = join(resolve(artifactRoot), 'codev', 'projects');
      if (!existsSync(projects)) continue;
      directories.add(projects);
      try {
        for (const entry of readdirSync(projects, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.add(join(projects, entry.name));
        }
      } catch (error) {
        emitFailure(projects, error);
      }
    }
    return [...directories];
  };

  const rebuildWatchers = (artifactRoots: readonly string[]): void => {
    const desired = new Set(watchedDirectories(artifactRoots));
    for (const [path, watcher] of watchers) {
      if (!desired.has(path)) {
        watcher.close();
        watchers.delete(path);
      }
    }
    for (const path of desired) {
      if (watchers.has(path)) continue;
      try {
        const watcher = watch(path, () => schedule());
        watcher.on('error', (error) => emitFailure(path, error));
        watchers.set(path, watcher);
      } catch (error) {
        emitFailure(path, error);
      }
    }
  };

  const emitSnapshot = (): void => {
    if (closed) return;
    let current: AgentStreamSnapshot<T>;
    try {
      current = options.snapshot();
    } catch (error) {
      emitFailure(options.workspacePath, error);
      return;
    }
    rebuildWatchers(current.artifactRoots);
    options.onEvent({
      type: 'PROTOCOL_STATE_SNAPSHOT',
      sequence: ++sequence,
      at: new Date().toISOString(),
      snapshot: current.payload,
    });
  };

  function schedule(): void {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      emitSnapshot();
    }, debounceMs);
  }

  emitSnapshot();
  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      closeWatchers();
    },
  };
}

/** Adapt the watcher to an authenticated Server-Sent Events response. */
export function openAgentStateSse<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: Omit<StateStreamOptions<T>, 'onEvent'>,
): StateSubscription {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const subscription = watchAgentState({
    ...options,
    onEvent: (event) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`id: ${event.sequence}\n`);
      res.write(`event: ${event.type === 'PROTOCOL_STATE_SNAPSHOT' ? 'protocol-state' : 'protocol-state-error'}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
  });
  const close = (): void => subscription.close();
  req.once('close', close);
  res.once('close', close);
  return subscription;
}
