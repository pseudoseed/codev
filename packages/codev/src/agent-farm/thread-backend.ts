/**
 * Production wiring for thread-backed spawns (Spec 146 Phase 9, issue #179 item 2).
 *
 * `installThreadSpawnFactory` had no caller outside tests, so `chooseSpawnPath`
 * returned `pty` unconditionally in production and Phase 8's thread branch was
 * unreachable. This module is that caller.
 *
 * Thread-backed spawning is OPT-IN and stays off until a t3code server is
 * configured — the cutover is per-workspace and deliberate, not a flag day. But
 * "configured and unreachable" is NOT "not configured": the first returns `pty`
 * silently, the second throws. A server that was named and could not be reached must
 * never be spelled the same way as a server that was never named.
 */
import { join, resolve } from 'node:path';
import { DispatchJournal } from '@cluesmith/porch-driver/commands';
import { TurnTracker } from '@cluesmith/porch-driver/turn';
import { createPorchThreadEngine } from './porch-thread-engine.js';
import {
  canonicalWorkspaceKey,
  installThreadSpawnFactory,
  setThreadEngine,
  setThreadStreamer,
  tryGetThreadEngine,
} from './thread-runtime.js';
import { logger } from './utils/logger.js';
import { loadConfig } from '../lib/config.js';

/**
 * How long a socket may sit connected-but-not-upgraded before it is called a failure.
 *
 * Overridable per call rather than by environment. The test needs a small bound so it can drive
 * a real server that accepts TCP and never upgrades — a bound nobody has watched fire is not a
 * bound — but an env var would have been a new `CODEV_*` variable on a repo whose test suite now
 * scrubs every `CODEV_*` except four named opt-ins, making this test's correctness depend on
 * where the scrub runs relative to where the value is set. That coupling is invisible. A
 * parameter is not global, not scrubbed, and commits nothing to production configuration.
 */
const DEFAULT_SOCKET_UPGRADE_TIMEOUT_MS = 15_000;

export interface ThreadBackendConfig {
  /** Base URL of the t3code server, e.g. `http://127.0.0.1:3799`. */
  readonly serverUrl: string;
  /**
   * Bootstrap token exchanged for an access token at connect time.
   *
   * **It must be a credential that survives repeated exchange, and t3code has both kinds.**
   * Every `afx` invocation is a fresh process with no session to reuse, so this token is
   * exchanged again on every spawn. At the pinned t3code commit, `PairingGrantStore.consume`
   * decrements `remainingUses` and DELETES the grant at `<= 1`, after which the next exchange
   * returns `UnknownBootstrapCredentialError`. So:
   *
   * - A **pairing-issued** token (`issueOneTimeToken`) works for exactly one spawn and then
   *   fails. Do not configure one here.
   * - A **config-seeded desktop bootstrap token** (`desktopBootstrapToken`) is issued with
   *   `remainingUses: "unbounded"`, deliberately, so it can be re-exchanged. That is the kind
   *   this field requires.
   *
   * This is a documented constraint rather than a silent one, and the second exchange's
   * failure is reported as a refusal rather than as an unreachable server — see
   * `ensureThreadBackendReady`. Caching an access token across processes would remove the
   * constraint, and is not done here: it means writing a credential to disk, which is a
   * storage decision this phase's scope does not cover.
   */
  readonly bootstrapToken: string;
  readonly workspaceRoot: string;
  readonly defaultHarness?: string;
  readonly defaultModel?: string;
}

/**
 * Read the thread backend configuration, or `null` when thread-backed spawns are
 * not configured for this workspace.
 *
 * Environment wins over the file so a single spawn can be pointed at a different
 * server without editing committed config.
 */
export function readThreadBackendConfig(workspaceRoot: string): ThreadBackendConfig | null {
  const envUrl = process.env.CODEV_T3_URL?.trim();
  const envToken = process.env.CODEV_T3_TOKEN?.trim();
  if (envUrl && envToken) {
    return {
      serverUrl: envUrl,
      bootstrapToken: envToken,
      workspaceRoot,
      defaultHarness: process.env.CODEV_T3_HARNESS?.trim() || undefined,
      defaultModel: process.env.CODEV_T3_MODEL?.trim() || undefined,
    };
  }

  // Through `loadConfig`, NOT a direct read of `.codev/config.json`. That loader merges five
  // layers, and layer 5 is `.codev/config.local.json` — per-engineer and already gitignored.
  // Reading the committed file directly meant an engineer who put `threads` in the local
  // override got `not-configured`: "I could not see it" spelled exactly like "there is none".
  // It also meant the only way to keep a token out of git was to gitignore the whole committed
  // config, which carries the shell block teams reasonably commit.
  //
  // Malformed JSON still throws rather than reading as unconfigured — `readJsonFile` raises
  // `Failed to parse <path>` — so that distinction survives the move.
  const threads = loadConfig(workspaceRoot).threads;
  if (!threads) return null;

  const serverUrl = typeof threads.serverUrl === 'string' ? threads.serverUrl.trim() : '';
  const bootstrapToken = typeof threads.bootstrapToken === 'string' ? threads.bootstrapToken.trim() : '';
  if (!serverUrl && !bootstrapToken) return null;
  if (!serverUrl || !bootstrapToken) {
    // Half-configured is a mistake, not a decision to stay on PTY.
    throw new Error(
      `Incomplete "threads" config for ${workspaceRoot}: both serverUrl and bootstrapToken are required `
      + `(got serverUrl=${serverUrl ? 'set' : 'missing'}, bootstrapToken=${bootstrapToken ? 'set' : 'missing'}). `
      + `Checked .codev/config.json and .codev/config.local.json.`,
    );
  }
  return {
    serverUrl,
    bootstrapToken,
    workspaceRoot,
    defaultHarness: typeof threads.harness === 'string' ? threads.harness : undefined,
    defaultModel: typeof threads.model === 'string' ? threads.model : undefined,
  };
}

/**
 * The WebSocket constructor to use, which is NOT always the global one.
 *
 * `@cluesmith/codev` declares `engines.node: >=20.0.0`, and Node 20 has no global
 * `WebSocket` — `typeof WebSocket` is `'undefined'` on 20.19.2. Constructing the global
 * therefore threw `ReferenceError` on the project's own minimum supported runtime, after
 * the bootstrap token had already been exchanged, so a configured spawn burned its
 * credential and then failed. `ws` is already a runtime dependency of this package, so the
 * fallback costs nothing.
 *
 * The global is preferred where it exists rather than always using `ws`, so newer runtimes
 * keep the platform implementation and this stays a compatibility shim rather than a switch.
 *
 * Exported for the test that pins this to the minimum supported Node's CONDITION — no global
 * `WebSocket` — rather than to whatever version the test runner happens to be.
 */
export async function webSocketCtor(): Promise<new (url: string) => WebSocket> {
  const globalCtor = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (typeof globalCtor === 'function') return globalCtor;
  const ws = await import('ws');
  return (ws.WebSocket ?? ws.default) as unknown as new (url: string) => WebSocket;
}

/** How far the connection got before it failed. Each value gets its own sentence. */
type ConnectFailure =
  | 'client-missing'
  | 'token-refused'
  | 'ticket-refused'
  | 'never-completed'
  | 'unreachable';

/** Thrown when the socket opens its TCP connection and then never completes the upgrade. */
class SocketUpgradeTimeout extends Error {
  constructor(readonly serverUrl: string, readonly timeoutMs: number) {
    super(`t3code socket to ${serverUrl} did not complete its upgrade within ${timeoutMs}ms`);
    this.name = 'SocketUpgradeTimeout';
  }
}

/**
 * Which of the four ways this connection can fail actually happened.
 *
 * `AuthError` means the server was reached, parsed the request, and said no — but WHICH request
 * matters, and the first version of this ignored that. It matched any `AuthError` and reported
 * every one as a refused bootstrap token, so a 4xx from `issueWebSocketTicket` — which happens
 * AFTER the token has been accepted — was blamed on the token. That is a message naming the
 * wrong cause, which is the same defect this connect path was rewritten to remove, one step
 * further along.
 *
 * Matched by `name` and `endpoint` rather than by `instanceof` because the class is loaded
 * through a dynamic import and a second module instance would defeat the identity check.
 */
export function classifyConnectFailure(err: unknown): ConnectFailure {
  // The t3-client entry point failing to load is a LOCAL INSTALLATION fault, not a
  // statement about the server — and it was folded into 'unreachable' until CI surfaced
  // it, which sent the reader to check a network for a server that was never contacted.
  // A PR whose thesis is one sentence per state cannot silently carry a fifth in another's.
  if (err instanceof Error && (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
    return 'client-missing';
  }
  if (err instanceof Error && err.name === 'SocketUpgradeTimeout') return 'never-completed';
  if (err instanceof Error && err.name === 'AuthError') {
    const endpoint = (err as { endpoint?: unknown }).endpoint;
    return typeof endpoint === 'string' && endpoint.includes('websocket-ticket')
      ? 'ticket-refused'
      : 'token-refused';
  }
  return 'unreachable';
}

/**
 * Open an authenticated t3code WebSocket and wrap it as a porch-driver dispatcher.
 *
 * The access token comes back with it because the project lookup below needs one:
 * exchanging the bootstrap token a second time would fail, and does not merely cost
 * a round trip — a pairing grant is one-time.
 */
async function connectDispatcher(
  config: ThreadBackendConfig,
  upgradeTimeoutMs: number,
  onClosed: () => void,
): Promise<{
  dispatcher: { call: (m: string, p: unknown) => Promise<unknown> };
  /**
   * The READ side of the same socket, for an observer that never issues a
   * command. One socket rather than two, because opening a second would spend
   * the bootstrap token — see `token-refused` below for why that is one-time.
   */
  streamer: { stream: (m: string, p: unknown, onValue: (v: unknown) => void) => Promise<unknown> };
  accessToken: string;
  /**
   * Hang up. Every path that abandons this connection before an engine owns it must
   * call this — see the note in `initialiseThreadBackend`.
   */
  close: () => void;
}> {
  const { T3Client } = await import('@cluesmith/t3-client/client');
  const auth = await import('@cluesmith/t3-client/auth');
  const access = await auth.exchangeBootstrapToken(config.serverUrl, config.bootstrapToken, {
    clientLabel: 'codev-afx',
  });
  const ticket = await auth.issueWebSocketTicket(config.serverUrl, access.access_token);
  const WebSocketCtor = await webSocketCtor();
  const socket = new WebSocketCtor(auth.webSocketUrl(config.serverUrl, ticket.ticket));
  // Bounded, because neither listener fires when a server accepts the TCP connection and then
  // never completes the WebSocket upgrade. Unbounded is not "slow": the await never settles, so
  // a spawn hangs forever having reported nothing — the one failure this whole connect path was
  // rewritten to make impossible, in the code that rewrote it.
  await new Promise<void>((res, rej) => {
    // A bound that does not CANCEL is not a bound, it is a lie with a timer on it.
    //
    // This rejected and walked away, leaving the socket alive: a server that accepts the
    // TCP connection and holds the upgrade open kept a live connection past the advertised
    // deadline, and Tower — which retries — accumulated one orphan per attempt, each still
    // holding a file descriptor and each still able to fire events into a closure nobody
    // was reading. The whole point of the bound is that nothing survives it.
    //
    // `abandon` runs on every exit from this promise, including the successful one, so
    // there is one place where the handshake listeners stop mattering.
    let settled = false;
    const abandon = (closeSocket: boolean) => {
      settled = true;
      clearTimeout(timer);
      if (closeSocket) {
        try {
          socket.close();
        } catch {
          /* already closing, or a ctor whose close throws after an aborted handshake */
        }
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      abandon(true);
      rej(new SocketUpgradeTimeout(config.serverUrl, upgradeTimeoutMs));
    }, upgradeTimeoutMs);
    socket.addEventListener('open', () => {
      if (settled) return;
      abandon(false);
      res();
    }, { once: true });
    socket.addEventListener('error', () => {
      if (settled) return;
      // Closed here too: an errored socket is not necessarily a closed one, and the
      // caller is about to stop referencing it.
      abandon(true);
      rej(new Error(`t3code socket error connecting to ${config.serverUrl}`));
    }, { once: true });
  });
  // Both listeners above are `{ once: true }`, so after `open` resolves the socket has no error
  // listener left and a later failure vanishes. This one is durable and outlives the handshake.
  socket.addEventListener('error', () => {
    logger.warn(`t3code socket error after connecting to ${config.serverUrl}`);
  });
  // A dead socket must not stay registered as a live engine.
  //
  // In the CLI this could not matter: the process exits. Tower holds its engine for as
  // long as it runs, and THIS PR proves the t3code server can be restarted — after which
  // every delivery through the stale engine fails, forever, until Tower is restarted.
  // Warning about it was all the old listener did.
  //
  // Eviction, not reconnection: the next `ensureThreadBackendReady` for this workspace
  // finds no engine and connects again, with a fresh credential exchange. Reconnecting
  // from in here would need a credential this closure does not have.
  socket.addEventListener('close', () => {
    logger.warn(`t3code socket to ${config.serverUrl} closed; dropping the engine for ${config.workspaceRoot}`);
    onClosed();
  });
  const client = new T3Client({
    send: (d: string) => socket.send(d),
    close: () => socket.close(),
    addEventListener: ((t: string, l: (ev: unknown) => void) =>
      socket.addEventListener(t as 'message', l as never)) as never,
    get readyState() {
      return socket.readyState;
    },
  });
  return {
    dispatcher: { call: (method: string, payload: unknown) => client.call(method, payload) },
    streamer: {
      stream: (method: string, payload: unknown, onValue: (value: unknown) => void) =>
        client.stream(method, payload, onValue),
    },
    accessToken: access.access_token,
    close: () => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
  };
}

/**
 * Which project t3code already holds for this workspace root, if any.
 *
 * `project.create` is NOT idempotent: t3code refuses a second active project for a
 * workspace root (`requireActiveProjectWorkspaceRootAbsent`). `ensureThreadBackendReady`
 * created one unconditionally, so it worked in the first process to run against a
 * workspace and failed in every one after it — and every `afx` invocation is a fresh
 * process. The failure arrived as "the server was named and could not be used", which
 * sends a reader to check the server.
 *
 * Read over HTTP rather than through `orchestration.subscribeShell`: the subscription
 * never exits, so taking one snapshot from it would leave a live subscription behind
 * for the life of the process.
 *
 * THREE ANSWERS, NOT TWO. `unknown` is not `none`: a lookup that could not be performed
 * must not be spelled like a workspace with no project, because the caller's next move
 * on `none` is to create one — which is exactly what fails.
 */
export type ProjectLookup =
  | { readonly kind: 'found'; readonly projectId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly detail: string };

export async function activeProjectForWorkspace(
  serverUrl: string,
  accessToken: string,
  workspaceRoot: string,
  timeoutMs: number = DEFAULT_SOCKET_UPGRADE_TIMEOUT_MS,
): Promise<ProjectLookup> {
  let body: unknown;
  try {
    // Bounded, for the same reason the WebSocket upgrade is. A server that accepts the
    // connection and never answers left this await unsettled forever, and it sits
    // between a completed handshake and a registered engine — so the whole of
    // `ensureThreadBackendReady` hung, having reported nothing. An unbounded wait is
    // not "slow"; it never ends.
    //
    // The signal covers the body read as well as the headers, so a response that starts
    // and stalls is bounded too.
    const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { kind: 'unknown', detail: `GET /api/orchestration/shell answered ${response.status}` };
    }
    body = await response.json();
  } catch (err) {
    return { kind: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
  const projects = (body as { projects?: ReadonlyArray<{ id?: unknown; workspaceRoot?: unknown }> }).projects;
  if (!Array.isArray(projects)) {
    return { kind: 'unknown', detail: 'the shell snapshot carried no projects array' };
  }
  // t3code compares normalised paths, and so does this. `/var` and `/private/var`
  // are the same directory on macOS and a string compare calls them different, which
  // would report `none` for a project that exists — the answer that leads straight
  // back into the invariant this lookup exists to avoid.
  // The same canonicalisation the engine map keys on, not a second copy of the rule:
  // two spellings of one workspace here would answer `none` for a project that exists.
  const target = canonicalWorkspaceKey(workspaceRoot);
  const match = projects.find(
    (project) =>
      typeof project.workspaceRoot === 'string' && canonicalWorkspaceKey(project.workspaceRoot) === target,
  );
  if (!match || typeof match.id !== 'string') return { kind: 'none' };
  return { kind: 'found', projectId: match.id };
}

/**
 * Register the production thread engine and spawn factory if this workspace is
 * configured for thread-backed spawns.
 *
 * Returns what actually happened, so a caller can log it rather than infer it:
 * - `not-configured` — no server named; `chooseSpawnPath` keeps returning `pty`.
 * - `already-installed` — an engine is registered; nothing to do.
 * - `installed` — the factory is now registered and `chooseSpawnPath` can return `thread`.
 *
 * Throws when a server IS configured and cannot be reached. Falling back to PTY there
 * would spell "could not connect" the same way as "not configured".
 */
export async function ensureThreadBackendReady(
  workspaceRoot: string,
  options: { readonly upgradeTimeoutMs?: number } = {},
): Promise<'not-configured' | 'already-installed' | 'installed'> {
  const key = canonicalWorkspaceKey(workspaceRoot);
  // The engine is looked up for THE REQUESTED workspace. This read used to be
  // unkeyed, so in Tower — one process, every workspace — the first thread-configured
  // workspace to connect made every later one return `already-installed` and then use
  // its socket, its projectId and its journal.
  if (tryGetThreadEngine(workspaceRoot)) return 'already-installed';
  // Concurrent first deliveries for one workspace raced the registration: both saw no
  // engine, both connected, and the second overwrote the first — leaving an orphaned
  // socket and, worse, two projects racing `project.create` for the same root. One
  // in-flight initialisation per workspace, shared by everyone who asks for it.
  const inFlight = pendingInit.get(key);
  if (inFlight) return await inFlight;
  const started = initialiseThreadBackend(workspaceRoot, key, options);
  pendingInit.set(key, started);
  try {
    return await started;
  } finally {
    pendingInit.delete(key);
  }
}

/** One in-flight `ensureThreadBackendReady` per canonical workspace root. */
const pendingInit = new Map<string, Promise<'not-configured' | 'already-installed' | 'installed'>>();

/**
 * How long a workspace whose connect just failed is left alone.
 *
 * Tower's drain tick runs every 1.5 s. Without this, a workspace whose server is down
 * re-ran the whole connect on every tick — and that means a full bootstrap-token
 * exchange every 1.5 s, against a credential this module's own documentation says may
 * be one-time. The retry loop would spend the thing it needs to retry with.
 */
const FAILED_CONNECT_COOLDOWN_MS = 60_000;

/** When each workspace's last connect attempt failed, and why. */
const lastFailure = new Map<string, { at: number; message: string }>();

/**
 * What a caller that MUST NOT BLOCK can know about a workspace's thread backend.
 *
 * `ready` is the only one that means "deliver now". The rest are all "not yet", and they
 * are kept apart because they lead somewhere different: `connecting` will resolve on its
 * own, `cooling-down` will not until the window passes, and `not-configured` never will.
 */
export type ThreadBackendAvailability =
  | { readonly kind: 'ready' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'cooling-down'; readonly since: number; readonly message: string }
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'misconfigured'; readonly message: string };

/**
 * Is this workspace's engine ready, and if not, get one on the way — WITHOUT WAITING.
 *
 * WHY THIS EXISTS SEPARATELY FROM `ensureThreadBackendReady`.
 *
 * Tower's mailbox drainer awaits agents sequentially. Putting an `await
 * ensureThreadBackendReady(...)` on that path meant one workspace's connect — bounded, by
 * design, at 15 s and up to 30 s across a token exchange, a ticket and an upgrade — stalled
 * delivery for EVERY agent in EVERY workspace, including PTY-only ones that never opted
 * into threads. An opt-in feature is not opt-in if declining it still costs you the
 * delivery of your mail.
 *
 * So the tick never awaits a connect. It asks this, acts on the answer, and moves on; the
 * connect happens in the background and the next tick, 1.5 s later, finds it ready. The
 * row is held in the meantime, which is what held is for.
 *
 * The CLI keeps `ensureThreadBackendReady` and its await: one workspace, one process, and
 * a spawn that returns before its server is reachable would be lying.
 */
export function requestThreadBackend(
  workspaceRoot: string,
  now: number = Date.now(),
): ThreadBackendAvailability {
  const key = canonicalWorkspaceKey(workspaceRoot);
  if (tryGetThreadEngine(key)) return { kind: 'ready' };
  if (pendingInit.has(key)) return { kind: 'connecting' };

  const failure = lastFailure.get(key);
  if (failure && now - failure.at < FAILED_CONNECT_COOLDOWN_MS) {
    return { kind: 'cooling-down', since: failure.at, message: failure.message };
  }

  // Read the config synchronously — files, no network — so a workspace with no server
  // named costs the tick nothing and starts nothing.
  let config;
  try {
    config = readThreadBackendConfig(resolve(workspaceRoot));
  } catch (err) {
    // Half-configured is a mistake, not a decision to stay on PTY, and it is not a
    // connect failure either — no cooldown, because nothing was attempted.
    return { kind: 'misconfigured', message: err instanceof Error ? err.message : String(err) };
  }
  if (!config) return { kind: 'not-configured' };

  void ensureThreadBackendReady(workspaceRoot).then(
    () => {
      lastFailure.delete(key);
    },
    (err: unknown) => {
      lastFailure.set(key, {
        at: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      });
    },
  );
  return { kind: 'connecting' };
}

/** Forget every recorded connect failure. For a test's teardown, not for production. */
export function clearThreadBackendFailures(): void {
  lastFailure.clear();
}

async function initialiseThreadBackend(
  workspaceRoot: string,
  key: string,
  options: { readonly upgradeTimeoutMs?: number },
): Promise<'not-configured' | 'already-installed' | 'installed'> {
  const upgradeTimeoutMs = options.upgradeTimeoutMs ?? DEFAULT_SOCKET_UPGRADE_TIMEOUT_MS;
  const config = readThreadBackendConfig(resolve(workspaceRoot));
  if (!config) return 'not-configured';

  /**
   * Whether this socket has closed, and the engine it is behind once there is one.
   *
   * WHAT MAKES THE EVICTION CORRECT, rather than an assertion that it is.
   *
   * An earlier version of this said the close handler "can only fire after this
   * function has finished registering it". That was not true and, once written as a
   * guarantee, it stopped being checked. The socket is OPEN while the HTTP project
   * lookup below runs, so it can close in that window — and then `registered` was
   * still `undefined`, `tryGetThreadEngine(key)` was also `undefined`, the guard
   * compared `undefined === undefined`, evicted nothing, and initialisation went on to
   * register an engine backed by an already-closed socket. No further close would ever
   * fire, because it had already fired. That is the dead-engine bug this handler exists
   * to prevent, in a narrower window.
   *
   * So there are two facts, not one:
   *
   * - `closed` is monotonic and set the moment the socket goes, whether or not an
   *   engine exists yet. It is checked BEFORE and AFTER registration, so the window
   *   between the check and the write is closed by the second check rather than by an
   *   argument about ordering.
   * - `registered` is what this function put in the map. The handler evicts only when
   *   the map still holds THAT object, so a close arriving late cannot drop the engine
   *   a later reconnect installed.
   */
  let closed = false;
  let registered: ReturnType<typeof createPorchThreadEngine> | undefined;

  let connection;
  try {
    connection = await connectDispatcher(config, upgradeTimeoutMs, () => {
      closed = true;
      if (registered !== undefined && tryGetThreadEngine(key) === registered) {
        setThreadEngine(undefined, key);
        // Same socket, same eviction. Guarded by the ENGINE's identity rather
        // than the streamer's for the same reason the engine is: a close
        // arriving late must not drop what a later reconnect installed.
        setThreadStreamer(undefined, key);
      }
    });
  } catch (err) {
    // Four ways this fails, four sentences. They were previously two, and one of those two was
    // wrong for half the cases it covered. A caller who cannot tell "the network is down" from
    // "your token is spent" from "the server took the connection and went silent" is being told
    // something useless in a confident voice.
    const detail = err instanceof Error ? err.message : String(err);
    const preamble = `Thread-backed spawns are configured for ${config.workspaceRoot}`;
    const messages: Record<ConnectFailure, string> = {
      'client-missing':
        `${preamble}, but the @cluesmith/t3-client module could not be loaded (${detail}). Nothing was sent to `
        + `${config.serverUrl} — this is a local installation fault, not a statement about the server. The package `
        + `ships its dist/ as a build output: run the workspace build, or reinstall if this is a packaged install.`,
      'token-refused':
        `${preamble} and the t3code server at ${config.serverUrl} answered, but REFUSED the bootstrap token (${detail}). `
        + `The server is reachable — the credential is not usable. Most likely it is a pairing-issued one-time token that a `
        + `previous spawn already consumed: every afx invocation is a fresh process and exchanges the token again, so this `
        + `field needs a credential that survives repeated exchange (a desktop bootstrap seed, issued unbounded).`,
      'ticket-refused':
        `${preamble} and the t3code server at ${config.serverUrl} ACCEPTED the bootstrap token and then refused to issue a `
        + `WebSocket ticket (${detail}). The credential is fine — this is a failure one step later, at the ticket endpoint, `
        + `and it is not evidence that the token is spent.`,
      'never-completed':
        `${preamble} and the t3code server at ${config.serverUrl} accepted the connection and then never completed the `
        + `WebSocket upgrade within ${upgradeTimeoutMs}ms (${detail}). It answered at the TCP level, so it is `
        + `neither unreachable nor refusing — something is listening and not talking.`,
      unreachable:
        `${preamble} but the t3code server at ${config.serverUrl} could not be reached: ${detail}. Refusing to fall back to `
        + `the PTY path — an unreachable server is not the same as an unconfigured one.`,
    };
    throw new Error(messages[classifyConnectFailure(err)], { cause: err });
  }

  const { createProject } = await import('@cluesmith/porch-driver/thread');
  const journal = new DispatchJournal(join(config.workspaceRoot, '.codev', 'commands.jsonl'));
  const { dispatcher, streamer, accessToken } = connection;

  /**
   * Nothing owns this socket until an engine is registered on it.
   *
   * The upgrade timeout closes the socket it gave up on, but a connection that upgraded
   * SUCCESSFULLY and then failed here — the project lookup, or `project.create` — was
   * simply dropped: the reference went out of scope and the socket stayed open. The 60 s
   * cooldown then retries, and Tower accumulates one live connection per attempt, each
   * holding a descriptor and a server-side session.
   *
   * So every exit from here that is not "an engine now owns it" hangs up first. The
   * successful path deliberately does not: the engine holds the socket for its lifetime,
   * and its own `close` handler evicts it.
   */
  const abandonConnection = (): void => {
    connection.close();
  };

  const lookup = await activeProjectForWorkspace(
    config.serverUrl,
    accessToken,
    config.workspaceRoot,
    upgradeTimeoutMs,
  );
  let projectId: string;
  if (lookup.kind === 'found') {
    projectId = lookup.projectId;
  } else {
    try {
      projectId = await createProject(dispatcher, journal, {
        title: `codev:${config.workspaceRoot}`,
        workspaceRoot: config.workspaceRoot,
      });
    } catch (err) {
      // Either this process lost a race with another one, or the lookup could not
      // be performed and there was a project all along. Re-read once before giving
      // up, and if that still cannot answer, say which of the two happened rather
      // than reporting a server fault.
      const retry = await activeProjectForWorkspace(
        config.serverUrl,
        accessToken,
        config.workspaceRoot,
        upgradeTimeoutMs,
      );
      if (retry.kind === 'found') {
        projectId = retry.projectId;
      } else {
        abandonConnection();
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not resolve a t3code project for ${config.workspaceRoot}. Creating one failed (${detail}), `
          + (lookup.kind === 'unknown'
            ? `and the existing-project lookup could not be performed (${lookup.detail}), so whether one already `
              + `exists is unknown.`
            : `and no existing project for that workspace root was found, so this is not a duplicate.`),
          { cause: err },
        );
      }
    }
  }
  // Before. The socket was open across the project lookup above, so by here it may
  // already be gone — and registering then would install an engine nothing can revive.
  if (closed) {
    abandonConnection();
    throw closedDuringInit(config.serverUrl, config.workspaceRoot);
  }
  registered = createPorchThreadEngine({
    dispatcher,
    journal,
    tracker: new TurnTracker(),
    projectId,
    workspaceRoot: config.workspaceRoot,
    defaultHarness: config.defaultHarness,
    defaultModel: config.defaultModel,
  });
  setThreadEngine(registered, key);
  // Registered WITH the engine and evicted WITH it, because they are one socket:
  // a streamer outliving its engine would hand an observer a connection nothing
  // is keeping alive, and it would report "watching" while reading a dead wire.
  setThreadStreamer(streamer, key);
  // And after, because the close could have landed between the check above and this
  // write. The handler evicts when it can see `registered`; this covers the case where
  // it could not. Both are cheap, and only one of them has to be right.
  if (closed) {
    setThreadEngine(undefined, key);
    setThreadStreamer(undefined, key);
    registered = undefined;
    abandonConnection();
    throw closedDuringInit(config.serverUrl, config.workspaceRoot);
  }
  installThreadSpawnFactory(key);
  lastFailure.delete(key);
  return 'installed';
}

/** The socket went away between the handshake and registration. */
function closedDuringInit(serverUrl: string, workspaceRoot: string): Error {
  return new Error(
    `The t3code socket to ${serverUrl} closed while the thread backend for ${workspaceRoot} was still `
    + `initialising, so no engine was registered. Nothing is stale and nothing was half-installed — `
    + `the next call connects again. This is not "the server refused" and not "the server is `
    + `unreachable": it answered, and then went.`,
  );
}
