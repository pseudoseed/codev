import { readSseFrames } from './sse-reader.js';
import { validateSnapshot, type AgentProtocolSnapshot } from './types.js';

/** One server. The client holds several, and they succeed and fail independently. */
export interface MachineConfig {
  /** Stable id used as a React key and a `data-machine` attribute. */
  readonly id: string;
  /** What a human calls this machine. */
  readonly label: string;
  /** Origin of that machine's codev-agent, e.g. `http://127.0.0.1:4100`. */
  readonly origin: string;
  /** Absolute workspace path on that machine. */
  readonly workspacePath: string;
  /** `<credentialId>.<secret>` from pairing. Never logged. */
  readonly credential: string;
  /**
   * The server's shared local key. codev-agent's routes sit behind Tower's own
   * choke point, which is a REACHABILITY check on top of the per-machine
   * credential and not a substitute for it — one key for every client cannot
   * express "revoke the iPad, keep the laptop".
   */
  readonly towerKey?: string;
}

export type DisconnectWhy = 'auth' | 'transport' | 'protocol';

export interface MachineState {
  readonly config: MachineConfig;
  readonly status: 'connecting' | 'live' | 'disconnected';
  readonly why: DisconnectWhy | null;
  readonly message: string | null;
  /** Last snapshot received. Retained while disconnected, and labelled as stale. */
  readonly snapshot: AgentProtocolSnapshot | null;
  /**
   * When `snapshot` was last confirmed current, ISO-8601.
   *
   * A subtree kept on screen through a dropped connection is LAST KNOWN, not
   * current, and one that does not say when it was last true reads as live. This
   * is the field that makes the difference observable, so it is not decoration.
   */
  readonly lastLiveAt: string | null;
  /** False means failed closed: a revoked credential is not retried. */
  readonly retrying: boolean;
}

export interface MachineDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => string;
  readonly onState: (state: MachineState) => void;
  readonly backoffMs?: readonly number[];
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * How long the stream may say nothing at all before the link is treated as
   * dead. Three heartbeats; see {@link SILENCE_DEADLINE_MS}.
   */
  readonly silenceMs?: number;
}

export interface MachineLink {
  stop(): void;
  getState(): MachineState;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 15_000] as const;

/**
 * How long total silence is tolerated before the subtree is called disconnected.
 *
 * A TCP connection through a proxy can outlive the server behind it, so waiting
 * for the stream to end is waiting for something that may never happen — the
 * server this was tested against was killed and the browser sat on a LIVE tree
 * indefinitely. The server heartbeats every 10s; three missed in a row is a dead
 * link, and a dead link that still reads LIVE is the worst answer available.
 */
export const SILENCE_DEADLINE_MS = 32_000;
export const MACHINE_CREDENTIAL_HEADER = 'x-codev-machine-credential';
export const TOWER_KEY_HEADER = 'codev-tower-key';

export function machineHeaders(config: MachineConfig): Record<string, string> {
  const headers: Record<string, string> = {
    [MACHINE_CREDENTIAL_HEADER]: config.credential,
    Accept: 'text/event-stream',
  };
  if (config.towerKey) headers[TOWER_KEY_HEADER] = config.towerKey;
  return headers;
}

/** base64url of the absolute path, matching `decodeWorkspacePath` on the server. */
export function encodeWorkspacePath(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function streamUrl(config: MachineConfig): string {
  return `${config.origin}/api/agent/v1/workspaces/${encodeWorkspacePath(config.workspacePath)}/stream`;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Hold one machine's subtree live.
 *
 * Everything this function reports is one of three things and never a fourth:
 * connected and current, connected and empty, or disconnected as of a stated
 * time. It never goes quiet, and it never presents a retained snapshot as fresh.
 */
export function connectMachine(config: MachineConfig, deps: MachineDeps): MachineLink {
  const now = deps.now ?? (() => new Date().toISOString());
  const backoff = deps.backoffMs ?? DEFAULT_BACKOFF;
  const sleep = deps.sleep ?? defaultSleep;
  const silenceMs = deps.silenceMs ?? SILENCE_DEADLINE_MS;
  const controller = new AbortController();
  let stopped = false;

  let state: MachineState = {
    config,
    status: 'connecting',
    why: null,
    message: null,
    snapshot: null,
    lastLiveAt: null,
    retrying: true,
  };

  function emit(next: Partial<MachineState>): void {
    state = { ...state, ...next };
    deps.onState(state);
  }

  /** Fail closed: no retry, and the subtree says why. */
  function failClosed(why: DisconnectWhy, message: string): void {
    emit({ status: 'disconnected', why, message, retrying: false });
  }

  function drop(why: DisconnectWhy, message: string): void {
    emit({ status: 'disconnected', why, message, retrying: true });
  }

  async function openOnce(): Promise<'failed-closed' | 'retry'> {
    // One controller per attempt, so the silence watchdog can end THIS read
    // without ending the link. Aborting the outer one would stop retrying.
    const attempt = new AbortController();
    const abortAttempt = (): void => attempt.abort();
    controller.signal.addEventListener('abort', abortAttempt, { once: true });
    const release = (): void => controller.signal.removeEventListener('abort', abortAttempt);
    const silence = (): string => `the server has said nothing for ${Math.round(silenceMs / 1000)}s`;

    let response: Response;
    try {
      response = await deps.fetch(streamUrl(config), {
        headers: machineHeaders(config),
        signal: attempt.signal,
      });
    } catch (error) {
      release();
      if (stopped) return 'failed-closed';
      drop('transport', `the server could not be reached: ${(error as Error).message}`);
      return 'retry';
    }
    if (stopped) { release(); return 'failed-closed'; }

    if (response.status === 401 || response.status === 403) {
      release();
      void response.body?.cancel().catch(() => {});
      failClosed('auth', 'this machine is not authorized; its credential was refused or revoked');
      return 'failed-closed';
    }
    if (response.status !== 200 || !response.body) {
      release();
      void response.body?.cancel().catch(() => {});
      drop('transport', `the server answered ${response.status}`);
      return 'retry';
    }

    /*
     * THE READ IS RACED AGAINST A DEADLINE, not merely aborted by a timer.
     *
     * A proxied TCP connection can outlive the server behind it: the socket
     * stays open, `read()` never settles, and nothing throws. Waiting for the
     * stream to end is waiting for something that may never happen, and a tree
     * that keeps saying LIVE through it is the exact defect this client exists
     * to avoid. Only the side that holds a clock can tell.
     */
    const iterator = readSseFrames(response.body)[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = (): Promise<'silent'> => new Promise((resolveSilent) => {
      timer = setTimeout(() => resolveSilent('silent'), silenceMs);
    });
    /*
     * NOT awaited, deliberately. An async generator suspended inside
     * `reader.read()` does not run its `finally` until that read settles, so
     * awaiting `return()` on a stream that has gone silent waits on exactly the
     * thing that is not coming. Aborting the attempt is what makes the read
     * settle; the generator then cleans itself up behind us.
     */
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      release();
      attempt.abort();
      void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
    };

    try {
      while (true) {
        const step = await Promise.race([iterator.next(), deadline()]);
        if (timer !== undefined) clearTimeout(timer);
        if (step === 'silent') {
          finish();
          if (stopped) return 'failed-closed';
          drop('transport', silence());
          return 'retry';
        }
        if (step.done) break;
        if (stopped) { finish(); return 'failed-closed'; }
        const frame = step.value;
        // A heartbeat comment is proof of life and nothing else.
        if (frame.event === 'comment') continue;
        if (frame.event === 'protocol-state-unauthorized') {
          finish();
          failClosed('auth', parseMessage(frame.data, 'this stream is no longer authorized'));
          return 'failed-closed';
        }
        if (frame.event === 'protocol-state-error') {
          // The stream is still open; the server is telling us one read failed.
          emit({ message: parseMessage(frame.data, 'the server reported a state-read failure') });
          continue;
        }
        const parsed = parseSnapshot(frame.data);
        if (!parsed) {
          // A payload this build cannot read is NOT an empty workspace.
          finish();
          drop('protocol', 'the server sent a snapshot this client does not understand');
          return 'retry';
        }
        emit({ status: 'live', why: null, message: null, snapshot: parsed, lastLiveAt: now() });
      }
    } catch (error) {
      finish();
      if (stopped) return 'failed-closed';
      drop('transport', `the stream ended: ${(error as Error).message}`);
      return 'retry';
    }
    finish();
    if (stopped) return 'failed-closed';
    drop('transport', 'the server closed the stream');
    return 'retry';
  }

  async function run(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      const outcome = await openOnce();
      if (outcome === 'failed-closed' || stopped) return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      attempt = state.status === 'live' ? 0 : attempt + 1;
      await sleep(delay, controller.signal);
    }
  }

  deps.onState(state);
  void run();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
    getState: () => state,
  };
}

function parseSnapshot(data: string): AgentProtocolSnapshot | null {
  try {
    const body = JSON.parse(data) as { snapshot?: unknown };
    return validateSnapshot(body.snapshot ?? body);
  } catch {
    return null;
  }
}

function parseMessage(data: string, fallback: string): string {
  try {
    const body = JSON.parse(data) as { message?: unknown };
    return typeof body.message === 'string' && body.message.length > 0 ? body.message : fallback;
  } catch {
    return fallback;
  }
}
