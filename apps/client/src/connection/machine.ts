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
}

/**
 * Why a subtree is closed.
 *
 * `revoked` IS NOT `auth`, AND IT IS NOT A GENERIC DISCONNECT. A withdrawn
 * credential is a decision a human made; an unreachable server is a fault. They
 * send an operator to two different places — reissue, or go find out why the box
 * is down — and reconnecting fixes exactly one of them. The server already keeps
 * these apart across seven machine-credential codes; collapsing them here would
 * undo that at the last step, which is where it would actually be read.
 *
 * `indeterminate` is the third one, and leaving it out was a real defect in the
 * first version of this file. When the credential STORE cannot be read, the
 * server has not refused this machine — it could not tell. Treating that as a
 * refusal fails the subtree closed forever over a condition that clears the
 * moment the file is readable again, which is "I could not tell" spelled as
 * "no", one level up from where this project keeps finding it.
 */
export type DisconnectWhy = 'auth' | 'revoked' | 'indeterminate' | 'transport' | 'protocol';

/**
 * Codes that mean the host could not reach a verdict, rather than reaching a
 * negative one. These keep retrying; everything else in the refusal family does
 * not, because no amount of reconnecting turns an unknown credential into a
 * known one.
 */
const INDETERMINATE = new Set(['MACHINE_STORE_UNREADABLE', 'MACHINE_STORE_LOCKED']);

export interface MachineState {
  readonly config: MachineConfig;
  /**
   * `degraded` is CONNECTED BUT NOT CURRENT.
   *
   * The stream is open and the server is answering, and it has told us it could
   * not read some of the state it was about to send. Leaving that as `live`
   * showed an old tree under a LIVE badge for as long as the failure lasted —
   * heartbeats keep the silence deadline from firing, so nothing else would ever
   * catch it. Precisely the property the disconnected state gets right, one
   * branch over.
   */
  readonly status: 'connecting' | 'live' | 'degraded' | 'disconnected';
  readonly why: DisconnectWhy | null;
  readonly message: string | null;
  /** The server's own code, verbatim, when it gave one. Never invented. */
  readonly signal: string | null;
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

/**
 * THE MACHINE CREDENTIAL, AND NOTHING ELSE.
 *
 * An earlier version also sent Tower's shared host secret, which inverted the
 * point of the whole surface. That secret is all-or-nothing: it cannot be
 * revoked for one machine without rotating it for all, so a page holding it
 * would grant host-wide access to every workspace to anything that could read
 * it — and revoking the machine credential, which is criterion 15, would not
 * have taken that access away.
 *
 * It was never needed either. `isRequestAllowed` in `server-utils.ts` exempts
 * this whole surface from the shared secret precisely so a paired device can
 * reach it holding only what pairing gave it: something scoped and revocable.
 *
 * The guard in `no-dangerous-html.test.ts` greps this directory for the names of
 * that secret, so it is described here rather than named. A guard taught to skip
 * comments is a guard that has started going blind.
 */
export function machineHeaders(config: MachineConfig): Record<string, string> {
  return {
    [MACHINE_CREDENTIAL_HEADER]: config.credential,
    Accept: 'text/event-stream',
  };
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
    signal: null,
    snapshot: null,
    lastLiveAt: null,
    retrying: true,
  };

  function emit(next: Partial<MachineState>): void {
    state = { ...state, ...next };
    deps.onState(state);
  }

  /** Fail closed: no retry, and the subtree says why. */
  function failClosed(why: DisconnectWhy, message: string, signal: string | null = null): void {
    emit({ status: 'disconnected', why, message, signal, retrying: false });
  }

  function drop(why: DisconnectWhy, message: string, signal: string | null = null): void {
    emit({ status: 'disconnected', why, message, signal, retrying: true });
  }

  /**
   * Turn a refusal into the facts a human acts on: was it withdrawn, was it
   * merely uncheckable, and what did the server call it. A body this client
   * cannot parse yields no signal rather than a guessed one.
   */
  async function refusal(response: Response): Promise<{
    why: DisconnectWhy;
    retry: boolean;
    message: string;
    signal: string | null;
  }> {
    let body: { signal?: unknown; message?: unknown } = {};
    try {
      body = await response.json() as typeof body;
    } catch {
      /* a refusal with no readable body still refuses */
    }
    const signal = typeof body.signal === 'string' ? body.signal : null;
    const message = typeof body.message === 'string' ? body.message : null;
    const refused = response.status === 401 || response.status === 403;
    const verdict = classify(signal, refused);
    return {
      ...verdict,
      signal,
      message: message ?? (refused
        ? `the server refused this machine's credential (HTTP ${response.status})`
        : `the server answered ${response.status}`),
    };
  }

  /**
   * `retry-after-progress` means this attempt received at least one valid
   * snapshot before it ended. The caller resets its backoff on that and only
   * that.
   */
  async function openOnce(): Promise<'failed-closed' | 'retry' | 'retry-after-progress'> {
    let progressed = false;
    const again = (): 'retry' | 'retry-after-progress' => (progressed ? 'retry-after-progress' : 'retry');
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
      return again();
    }
    if (stopped) { release(); return 'failed-closed'; }

    /*
     * EVERY non-200 IS READ FOR ITS SIGNAL, not only 401 and 403.
     *
     * An unreadable credential store answers 503, deliberately — the host cannot
     * say whether this machine is authorized, so it does not answer 401. Reading
     * the code only on the refusal statuses flattened that into "the server
     * answered 503", which names the number and drops the one fact an operator
     * would act on. It looked exactly like a server having a bad minute.
     */
    if (response.status !== 200 || !response.body) {
      release();
      const refused = await refusal(response);
      void response.body?.cancel().catch(() => {});
      if (refused.retry) {
        drop(refused.why, refused.message, refused.signal);
        return again();
      }
      failClosed(refused.why, refused.message, refused.signal);
      return 'failed-closed';
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
          return again();
        }
        if (step.done) break;
        if (stopped) { finish(); return 'failed-closed'; }
        const frame = step.value;
        // A heartbeat comment is proof of life and nothing else.
        if (frame.event === 'comment') continue;
        if (frame.event === 'protocol-state-unauthorized') {
          finish();
          // Criterion 15's live case: the credential was revoked while the
          // stream was open. The server re-checks and names the code; it is not
          // re-derived from the fact that the stream stopped.
          const code = parseField(frame.data, 'code');
          // The stream event IS the refusal — the server terminated the stream
          // because its own re-check said no — so an unrecognised code here is a
          // refusal, not a bad response.
          const verdict = classify(code, true);
          const message = parseMessage(frame.data, 'this stream is no longer authorized');
          if (verdict.retry) {
            drop(verdict.why, message, code);
            return 'retry';
          }
          failClosed(verdict.why, message, code);
          return 'failed-closed';
        }
        if (frame.event === 'protocol-state-error') {
          /*
           * The stream is open and the server has told us a read failed. The
           * tree on screen is therefore last-known, not current — so the row
           * says so, and `lastLiveAt` is NOT advanced. A later good snapshot
           * clears this by setting `live` again.
           */
          emit({
            status: 'degraded',
            why: null,
            message: parseMessage(frame.data, 'the server reported a state-read failure'),
            signal: parseField(frame.data, 'code'),
          });
          continue;
        }
        const parsed = parseSnapshot(frame.data);
        if (!parsed) {
          // A payload this build cannot read is NOT an empty workspace.
          finish();
          drop('protocol', 'the server sent a snapshot this client does not understand');
          return again();
        }
        progressed = true;
        emit({
          status: 'live',
          why: null,
          message: null,
          signal: null,
          snapshot: parsed,
          lastLiveAt: now(),
        });
      }
    } catch (error) {
      finish();
      if (stopped) return 'failed-closed';
      drop('transport', `the stream ended: ${(error as Error).message}`);
      return again();
    }
    finish();
    if (stopped) return 'failed-closed';
    drop('transport', 'the server closed the stream');
    return again();
  }

  async function run(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      /*
       * THE RESET KEYS OFF WHAT THE ATTEMPT ACHIEVED, NOT OFF THE STATUS.
       *
       * It used to test `state.status === 'live'` after `openOnce` returned —
       * and `openOnce` always sets the status to `disconnected` before it
       * returns, so the test was never true and the delay only ever grew. A
       * machine that blipped a few times over an afternoon ended up waiting the
       * maximum before every reconnect, for no reason connected to its health.
       *
       * "Did this attempt receive a valid snapshot" is the fact worth keying on:
       * a connection that worked and then dropped is a different thing from one
       * that never worked.
       */
      const outcome = await openOnce();
      if (outcome === 'failed-closed' || stopped) return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      attempt = outcome === 'retry-after-progress' ? 0 : attempt + 1;
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

/**
 * Withdrawn, unverifiable, plainly refused, or merely a bad response — and
 * whether to keep trying.
 *
 * `refused` says the STATUS was 401/403. Without it, an unrecognised signal on a
 * 500 would be classified as a permanent authentication failure and the subtree
 * would fail closed over a server restart.
 */
function classify(signal: string | null, refused: boolean): { why: DisconnectWhy; retry: boolean } {
  if (signal === 'MACHINE_CREDENTIAL_REVOKED') return { why: 'revoked', retry: false };
  if (signal !== null && INDETERMINATE.has(signal)) return { why: 'indeterminate', retry: true };
  return refused ? { why: 'auth', retry: false } : { why: 'transport', retry: true };
}

function parseField(data: string, key: string): string | null {
  try {
    const body = JSON.parse(data) as Record<string, unknown>;
    return typeof body[key] === 'string' ? body[key] as string : null;
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
