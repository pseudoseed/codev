/** Filesystem-backed porch state stream for codev-agent (Spec 146, Phase 5). */

import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import type http from 'node:http';
import type { AgentStateSignal } from './status-reader.js';

/**
 * Server-side re-stat interval. The watcher is the fast path; this backstop
 * finds a change when watch() returning is not FSEvents being live, which
 * Node cannot observe. 5s is below human-scale lag on a missed gate badge
 * and cheap for stat'ing a handful of status.yaml files. The client still
 * does not poll. This does not close the macOS arming window; it makes a
 * miss visible and repaired on a bounded schedule.
 */
export const RECONCILE_INTERVAL_MS = 5_000;

export interface AgentStreamSnapshot<T> {
  readonly payload: T;
  /** Workspace and builder artifact roots represented by payload. */
  readonly artifactRoots: readonly string[];
}

export interface AgentStateStreamEvent<T> {
  readonly type: 'PROTOCOL_STATE_SNAPSHOT' | 'PROTOCOL_STATE_RECONCILED' | 'STATE_STREAM_WATCH_FAILED';
  readonly sequence: number;
  readonly at: string;
  readonly snapshot?: T;
  readonly signal?: AgentStateSignal;
}

export interface WatchDiagnostics {
  watchStarted: number;
  watchErrors: number;
  scheduleCalls: number;
  snapshotCalls: number;
  reconcilePasses: number;
  reconcileRepairs: number;
}

export interface StateSubscription {
  close(): void;
  readonly diagnostics: WatchDiagnostics;
}

export interface StateStreamOptions<T> {
  readonly workspacePath: string;
  readonly snapshot: () => AgentStreamSnapshot<T>;
  readonly onEvent: (event: AgentStateStreamEvent<T>) => void;
  readonly debounceMs?: number;
  readonly reconcileMs?: number;
  /** Test seam. Production uses fs.watch. */
  readonly watchImpl?: typeof watch;
}

function fingerprintRoots(
  workspacePath: string,
  artifactRoots: readonly string[],
): { ok: true; fingerprint: string } | { ok: false; message: string; source: string } {
  const parts: string[] = [];
  const builders = join(resolve(workspacePath), '.builders');
  try {
    const st = statSync(builders);
    parts.push(`builders:${builders}:${st.mtimeMs}:${st.size}`);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== 'ENOENT') {
      return {
        ok: false,
        message: `Artifact root cannot be read: ${errno.code ?? String(error)}`,
        source: builders,
      };
    }
    parts.push(`builders:${builders}:absent`);
  }

  for (const artifactRoot of artifactRoots) {
    const root = resolve(artifactRoot);
    try {
      statSync(root);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        parts.push(`missing:${root}`);
        continue;
      }
      return {
        ok: false,
        message: `Artifact root cannot be read: ${errno.code ?? String(error)}`,
        source: root,
      };
    }
    const projects = join(root, 'codev', 'projects');
    let entries;
    try {
      entries = readdirSync(projects, { withFileTypes: true });
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        parts.push(`empty-projects:${root}`);
        continue;
      }
      return {
        ok: false,
        message: `Porch projects directory cannot be read: ${errno.code ?? String(error)}`,
        source: projects,
      };
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const statusPath = join(projects, entry.name, 'status.yaml');
      try {
        const st = statSync(statusPath);
        parts.push(`${statusPath}:${st.mtimeMs}:${st.size}`);
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === 'ENOENT') {
          parts.push(`${statusPath}:absent`);
          continue;
        }
        return {
          ok: false,
          message: `status.yaml cannot be read: ${errno.code ?? String(error)}`,
          source: statusPath,
        };
      }
    }
  }
  return { ok: true, fingerprint: parts.join('|') };
}

/**
 * Watch project directories rather than status files themselves: porch writes
 * atomically by renaming `status.yaml.tmp`, which replaces the inode and would
 * strand a file-level watcher after the first update.
 */
export function watchAgentState<T>(options: StateStreamOptions<T>): StateSubscription {
  const watchers = new Map<string, FSWatcher>();
  const debounceMs = options.debounceMs ?? 30;
  const reconcileMs = options.reconcileMs ?? RECONCILE_INTERVAL_MS;
  const watchFn = options.watchImpl ?? watch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let sequence = 0;
  let closed = false;
  let lastFingerprint: string | undefined;
  let lastArtifactRoots: readonly string[] = [resolve(options.workspacePath)];
  const diagnostics: WatchDiagnostics = {
    watchStarted: 0,
    watchErrors: 0,
    scheduleCalls: 0,
    snapshotCalls: 0,
    reconcilePasses: 0,
    reconcileRepairs: 0,
  };

  const closeWatchers = (): void => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };

  const emitFailure = (path: string, error: unknown, code = 'STATE_STREAM_WATCH_FAILED'): void => {
    diagnostics.watchErrors += 1;
    options.onEvent({
      type: 'STATE_STREAM_WATCH_FAILED',
      sequence: ++sequence,
      at: new Date().toISOString(),
      signal: {
        code,
        message: `Cannot watch porch state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        source: path,
      },
    });
  };

  const emitUnreadable = (source: string, message: string): void => {
    diagnostics.watchErrors += 1;
    options.onEvent({
      type: 'STATE_STREAM_WATCH_FAILED',
      sequence: ++sequence,
      at: new Date().toISOString(),
      signal: { code: 'STATUS_UNREADABLE', message, source },
    });
  };

  const canonicalDir = (path: string): string | undefined => {
    try {
      return realpathSync(path);
    } catch (error) {
      emitFailure(path, error);
      return undefined;
    }
  };

  const watchedDirectories = (artifactRoots: readonly string[]): string[] => {
    const directories = new Set<string>();
    const buildersRoot = join(resolve(options.workspacePath), '.builders');
    if (existsSync(buildersRoot)) {
      const canonical = canonicalDir(buildersRoot);
      if (canonical !== undefined) directories.add(canonical);
    }
    for (const artifactRoot of artifactRoots) {
      const projects = join(resolve(artifactRoot), 'codev', 'projects');
      if (!existsSync(projects)) continue;
      const canonicalProjects = canonicalDir(projects);
      if (canonicalProjects === undefined) continue;
      directories.add(canonicalProjects);
      try {
        for (const entry of readdirSync(canonicalProjects, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const child = canonicalDir(join(canonicalProjects, entry.name));
            if (child !== undefined) directories.add(child);
          }
        }
      } catch (error) {
        emitFailure(canonicalProjects, error);
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
        const watcher = watchFn(path, () => schedule());
        diagnostics.watchStarted += 1;
        watcher.on('error', (error) => emitFailure(path, error));
        watchers.set(path, watcher);
      } catch (error) {
        emitFailure(path, error);
      }
    }
  };

  const recordFingerprint = (artifactRoots: readonly string[]): void => {
    const fp = fingerprintRoots(options.workspacePath, artifactRoots);
    if (fp.ok) lastFingerprint = fp.fingerprint;
    else emitUnreadable(fp.source, fp.message);
  };

  const emitSnapshot = (type: 'PROTOCOL_STATE_SNAPSHOT' | 'PROTOCOL_STATE_RECONCILED'): void => {
    if (closed) return;
    let current: AgentStreamSnapshot<T>;
    try {
      current = options.snapshot();
    } catch (error) {
      emitFailure(options.workspacePath, error);
      return;
    }
    diagnostics.snapshotCalls += 1;
    lastArtifactRoots = current.artifactRoots;
    rebuildWatchers(current.artifactRoots);
    recordFingerprint(current.artifactRoots);
    const event: AgentStateStreamEvent<T> = {
      type,
      sequence: ++sequence,
      at: new Date().toISOString(),
      snapshot: current.payload,
    };
    if (type === 'PROTOCOL_STATE_RECONCILED') {
      diagnostics.reconcileRepairs += 1;
      options.onEvent({
        ...event,
        signal: {
          code: 'STREAM_PROJECTION_REPAIRED',
          message: 'Stream projection lagged status.yaml; repaired from disk',
        },
      });
      return;
    }
    options.onEvent(event);
  };

  function schedule(): void {
    diagnostics.scheduleCalls += 1;
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      emitSnapshot('PROTOCOL_STATE_SNAPSHOT');
    }, debounceMs);
  }

  const reconcile = (): void => {
    diagnostics.reconcilePasses += 1;
    if (closed) return;
    const fp = fingerprintRoots(options.workspacePath, lastArtifactRoots);
    if (!fp.ok) {
      emitUnreadable(fp.source, fp.message);
      return;
    }
    if (fp.fingerprint === lastFingerprint) return;
    emitSnapshot('PROTOCOL_STATE_RECONCILED');
  };

  let probeRoots = lastArtifactRoots;
  try {
    probeRoots = options.snapshot().artifactRoots;
  } catch (error) {
    emitFailure(options.workspacePath, error);
  }
  rebuildWatchers(probeRoots);
  emitSnapshot('PROTOCOL_STATE_SNAPSHOT');
  reconcile();
  if (reconcileMs > 0) {
    reconcileTimer = setInterval(reconcile, reconcileMs);
    reconcileTimer.unref();
  }

  return {
    diagnostics,
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (reconcileTimer !== undefined) clearInterval(reconcileTimer);
      closeWatchers();
    },
  };
}

/** How often an open stream re-checks that its credential is still good. */
const STREAM_REAUTHORIZE_MS = 5_000;

export interface StreamAuthorization {
  readonly ok: boolean;
  /** Why authorization was lost, e.g. MACHINE_CREDENTIAL_REVOKED. */
  readonly code?: string;
  readonly message?: string;
}

/**
 * Adapt the watcher to an authenticated Server-Sent Events response.
 *
 * AUTHENTICATION AT THE HANDSHAKE IS NOT AUTHENTICATION FOR THE CONNECTION.
 * A stream that checks its credential once and then runs for hours is a
 * credential that cannot be revoked: success criterion 15 says revoking a machine
 * makes that subtree fail closed, and an already-open stream IS the subtree. The
 * `/state` request after a revocation was refused while the `/stream` opened
 * before it kept delivering the same content.
 *
 * So `stillAuthorized` is re-checked on two schedules, and it needs both:
 * before every write, which covers a busy stream promptly, and on a timer, which
 * covers an IDLE one — a revoked device holding a quiet stream is still holding a
 * live channel, and an event-driven check alone would never notice.
 *
 * Losing authorization is announced before the socket closes, with the code that
 * says why. A stream that simply went silent is indistinguishable from a network
 * failure, and "your access was withdrawn" is not the same instruction as "your
 * connection dropped".
 */
export function openAgentStateSse<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: Omit<StateStreamOptions<T>, 'onEvent'> & {
    readonly stillAuthorized?: () => StreamAuthorization;
    readonly reauthorizeMs?: number;
  },
): StateSubscription {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let terminated = false;
  let reauthorizeTimer: NodeJS.Timeout | undefined;
  // `watchAgentState` emits its opening snapshot SYNCHRONOUSLY, so `terminate`
  // can run before the subscription exists — a credential already revoked when
  // the stream opens hits exactly that. Hold it in a `let` and close on
  // assignment, rather than reaching into a binding that is still in its dead
  // zone.
  let subscription: StateSubscription | undefined;

  /** Announce why, then end. Never just go quiet. */
  const terminate = (authorization: StreamAuthorization): void => {
    if (terminated) return;
    terminated = true;
    if (!res.destroyed && !res.writableEnded) {
      res.write('event: protocol-state-unauthorized\n');
      res.write(`data: ${JSON.stringify({
        type: 'STREAM_AUTHORIZATION_LOST',
        code: authorization.code ?? 'MACHINE_CREDENTIAL_REQUIRED',
        message: authorization.message ?? 'this stream is no longer authorized',
      })}\n\n`);
      res.end();
    }
    subscription?.close();
    if (reauthorizeTimer !== undefined) clearInterval(reauthorizeTimer);
  };

  /** Returns true while the stream may keep delivering. */
  const authorized = (): boolean => {
    if (!options.stillAuthorized) return true;
    let verdict: StreamAuthorization;
    try {
      verdict = options.stillAuthorized();
    } catch (error) {
      // A store that cannot be read is "I could not tell", and a stream carrying
      // protocol state is not the place to resolve that optimistically.
      verdict = {
        ok: false,
        code: 'MACHINE_STORE_UNREADABLE',
        message: `credential could not be re-checked: ${(error as Error).message}`,
      };
    }
    if (verdict.ok) return true;
    terminate(verdict);
    return false;
  };

  subscription = watchAgentState({
    ...options,
    onEvent: (event) => {
      if (terminated || res.destroyed || res.writableEnded) return;
      if (!authorized()) return;
      const sseEvent = event.type === 'PROTOCOL_STATE_SNAPSHOT'
        ? 'protocol-state'
        : event.type === 'PROTOCOL_STATE_RECONCILED'
          ? 'protocol-state-reconciled'
          : 'protocol-state-error';
      res.write(`id: ${event.sequence}\n`);
      res.write(`event: ${sseEvent}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
  });

  // Terminated during the opening snapshot: the subscription exists now, so the
  // close that could not happen inside `terminate` happens here.
  if (terminated) subscription.close();

  if (!terminated && options.stillAuthorized) {
    const interval = options.reauthorizeMs ?? STREAM_REAUTHORIZE_MS;
    if (interval > 0) {
      reauthorizeTimer = setInterval(() => { authorized(); }, interval);
      reauthorizeTimer.unref();
    }
  }

  const stream = subscription;
  const close = (): void => {
    if (reauthorizeTimer !== undefined) clearInterval(reauthorizeTimer);
    stream.close();
  };
  req.once('close', close);
  res.once('close', close);
  return stream;
}
