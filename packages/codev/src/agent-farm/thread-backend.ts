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
import { statSync } from 'node:fs';
import { DispatchJournal } from '@cluesmith/porch-driver/commands';
import { TurnTracker } from '@cluesmith/porch-driver/turn';
import { createPorchThreadEngine } from './porch-thread-engine.js';
import { createThreadSubscriptionPool, type ThreadSubscriber } from './thread-subscriptions.js';
import {
  canonicalWorkspaceKey,
  getThreadEngine,
  installThreadSpawnFactory,
  setThreadEngine,
  setThreadStreamer,
  tryGetThreadEngine,
  type ThreadEngine,
  type ThreadStream,
} from './thread-runtime.js';
import { logger } from './utils/logger.js';
import { configLayerPaths, loadConfig } from '../lib/config.js';

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
  streamer: { stream: (m: string, p: unknown, onValue: (v: unknown) => void) => ThreadStream };
  /**
   * The same read side again, shaped for `ResumingSubscription` (issue #241).
   *
   * A THIRD view of one socket rather than a second connection, for the reason
   * `streamer` gives: opening another would spend the bootstrap token, which is
   * one-time when it was pairing-issued.
   *
   * It is separate from `streamer` because the two want different things.
   * `streamer` returns a `ThreadStream` — a handle with `cancel`, for a display
   * subscriber that opens one long stream and never resumes. `ResumingSubscription`
   * wants the raw promise plus the request id, because it opens a NEW stream on every
   * attempt and each attempt's `close` must cancel its own.
   */
  subscriber: ThreadSubscriber;
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
    // A hang-up WE asked for is not a warning. `closeThreadBackend` marks the workspace
    // first, so the deliberate close on a one-shot command's exit stops reporting itself as
    // a server that went away — which is a different event, and the one this line is for.
    if (!isHangingUp(config.workspaceRoot)) {
      logger.warn(`t3code socket to ${config.serverUrl} closed; dropping the engine for ${config.workspaceRoot}`);
    }
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
      /*
       * The request id is captured as it is minted so `cancel` can name THIS
       * stream. `T3Client.cancel` has always been public; `stream` minted its id
       * privately, so a long-lived subscription had no way to be stopped and the
       * only interrupt that could fire was the idle timeout's.
       *
       * `cancel` is idempotent and safe before the id arrives (it cannot, in
       * practice — `onRequestId` fires synchronously inside `stream` — but a
       * guard costs nothing and an ordering assumption written as a guarantee is
       * how this repository has been bitten before).
       */
      stream: (method: string, payload: unknown, onValue: (value: unknown) => void): ThreadStream => {
        let requestId: number | undefined;
        let cancelled = false;
        const done = client.stream(method, payload, (value) => {
          if (!cancelled) onValue(value);
        }, undefined, (id) => { requestId = id; });
        return {
          done,
          cancel: () => {
            if (cancelled) return;
            cancelled = true;
            if (requestId === undefined) return;
            try {
              client.cancel(requestId);
            } catch {
              /* the socket is already gone; there is nothing to interrupt through */
            }
          },
        };
      },
    },
    subscriber: {
      stream: (
        method: string,
        payload: unknown,
        onValue: (value: unknown) => void,
        timeoutMs?: number,
        onRequestId?: (id: number) => void,
      ) => client.stream(method, payload, onValue, timeoutMs, onRequestId),
      cancel: (requestId: number) => client.cancel(requestId),
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
    // Through the client, not a second hand-built request (issue #227 item 4).
    //
    // This was a bare `fetch` with its own `authorization: Bearer` header and its own base
    // URL normalisation, one import away from the module that owns every other request to
    // this server. One request is a small duplication and it still had a consequence: it
    // skipped `assertTransportSafe`, so it was the one call here willing to put a bearer
    // token on a plaintext connection to a non-loopback host.
    //
    // Still bounded, for the same reason the WebSocket upgrade is. A server that accepts
    // the connection and never answers left this await unsettled forever, and it sits
    // between a completed handshake and a registered engine — so the whole of
    // `ensureThreadBackendReady` hung, having reported nothing. An unbounded wait is not
    // "slow"; it never ends.
    const auth = await import('@cluesmith/t3-client/auth');
    const response = await auth.authorizedGet(serverUrl, '/api/orchestration/shell', accessToken, {
      timeoutMs,
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

/**
 * The last "this workspace has no usable thread config" answer, and what it was
 * computed from.
 *
 * ## Why a cache at all
 *
 * Tower sweeps every KNOWN workspace every 5s, and asks this function per
 * workspace. `ready`, `connecting` and `cooling-down` all answer from memory
 * before any file is touched — but `not-configured` and `misconfigured` are the
 * verdicts that require the read, and they are the verdicts of every workspace
 * that never opted in. So the workspaces that use nothing were paying a full
 * five-layer `loadConfig` — four reads, four deep merges, the validators — on
 * Tower's event loop, twelve times a minute each, scaling with how many
 * workspaces have ever been registered rather than with how many are in use.
 *
 * ## Why a signature and not a TTL
 *
 * A TTL makes an operator who has just written their t3 config wait it out, and
 * picking the number trades that wait against the saving. A signature has no such
 * dial: the moment a layer file changes, appears or disappears, the cached answer
 * is discarded and the real read happens on that very pass.
 *
 * Cost per pass drops to `existsSync` on the project layers plus one `statSync`
 * each — no reads, no parses, no merges, no validation.
 *
 * KNOWN LIMIT, stated rather than papered over: two different contents with the
 * same size AND the same mtime read as unchanged. Every mtime-based cache carries
 * this, and the alternative is the read it exists to avoid.
 */
interface CachedNegative {
  readonly verdict: ThreadBackendAvailability;
  readonly signature: string;
}
const negativeConfig = new Map<string, CachedNegative>();

/**
 * A cheap fingerprint of everything `readThreadBackendConfig` consults.
 *
 * The env vars are in it because they are checked FIRST and short-circuit the
 * files: a token exported into Tower's environment must not be masked by an
 * answer computed before it existed.
 */
function configSignature(workspaceRoot: string): string {
  const parts = [
    `env:${process.env.CODEV_T3_URL ?? ''}\u0000${process.env.CODEV_T3_TOKEN ?? ''}`,
  ];
  for (const path of configLayerPaths(workspaceRoot)) {
    const stat = statSync(path, { throwIfNoEntry: false });
    // The PATH is part of it, so a layer appearing or disappearing changes the
    // signature even when nothing that already existed was touched.
    parts.push(`${path}:${stat ? `${stat.mtimeMs}:${stat.size}` : 'absent'}`);
  }
  return parts.join('\n');
}

/** Forget every cached negative verdict. For a test's teardown, not for production. */
export function clearThreadBackendConfigCache(): void {
  negativeConfig.clear();
}

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
  //
  // Unless nothing it reads has changed since the last negative answer, in which
  // case the answer is reused and the read is skipped. Only the NEGATIVE verdicts
  // are cached: `connecting` below has a side effect, and `ready` /
  // `cooling-down` never reach here.
  /*
   * INSIDE THE TRY, AND THAT IS THE WHOLE POINT OF THIS FUNCTION.
   *
   * `requestThreadBackend` is documented and relied on as NEVER THROWING — it is
   * the synchronous, always-answers contract Tower's drain tick is built on. The
   * first version of this cache computed the signature above the try, and
   * `configLayerPaths` reaches `resolveProjectConfigPath`, which throws on a
   * legacy `af-config.json`. The caller that catches leaves the workspace at
   * `connecting` forever and the caller that does not catch takes the throw: an
   * "I could not tell" rendered as a state, with no error anywhere.
   *
   * A signature that cannot be computed is a reason to READ, never a reason to
   * throw — so it degrades to an uncacheable answer and the read below decides.
   */
  let signature: string | null;
  try {
    signature = configSignature(workspaceRoot);
  } catch {
    signature = null;
  }
  if (signature !== null) {
    const remembered = negativeConfig.get(key);
    if (remembered && remembered.signature === signature) return remembered.verdict;
  }

  /** Cache only when the signature is known; otherwise nothing could invalidate it. */
  const remember = (verdict: ThreadBackendAvailability): ThreadBackendAvailability => {
    if (signature !== null) negativeConfig.set(key, { verdict, signature });
    return verdict;
  };

  let config;
  try {
    config = readThreadBackendConfig(resolve(workspaceRoot));
  } catch (err) {
    // Half-configured is a mistake, not a decision to stay on PTY, and it is not a
    // connect failure either — no cooldown, because nothing was attempted.
    return remember({
      kind: 'misconfigured', message: err instanceof Error ? err.message : String(err),
    });
  }
  if (!config) return remember({ kind: 'not-configured' });
  // Configured after all: drop any negative so a later failure is recomputed
  // rather than answered from a verdict this pass just disproved.
  negativeConfig.delete(key);

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
  negativeConfig.clear();
}

async function initialiseThreadBackend(
  workspaceRoot: string,
  key: string,
  options: { readonly upgradeTimeoutMs?: number },
): Promise<'not-configured' | 'already-installed' | 'installed'> {
  const upgradeTimeoutMs = options.upgradeTimeoutMs ?? DEFAULT_SOCKET_UPGRADE_TIMEOUT_MS;
  const config = readThreadBackendConfig(resolve(workspaceRoot));
  if (!config) return 'not-configured';
  // Connecting again ends any deliberate hang-up: from here a close is the server's doing
  // and must be reported.
  deliberate.delete(key);

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
  /**
   * The subscriptions the engine drives (issue #241), stopped with the socket.
   *
   * Set as soon as it is built rather than with the engine, because it is built
   * BEFORE the engine — the engine takes it as an option — and a close landing in
   * that window would otherwise leave every `ResumingSubscription` retrying against
   * a socket that is gone. `stopAll` is idempotent, so stopping it here and again on
   * an abandon path costs nothing.
   */
  let pool: ReturnType<typeof createThreadSubscriptionPool> | undefined;

  let connection;
  try {
    connection = await connectDispatcher(config, upgradeTimeoutMs, () => {
      closed = true;
      // Unconditional, and not guarded by the engine's identity the way the two
      // registry entries are. The pool is not in a registry a later reconnect can
      // overwrite — it is owned by THIS socket, so when this socket goes there is
      // nothing left for its subscriptions to run against, whatever else has since
      // been installed.
      pool?.stopAll();
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
  const { dispatcher, streamer, subscriber, accessToken } = connection;

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
    // The pool first. Closing the socket out from under a running
    // `ResumingSubscription` leaves it retrying, and its retry loop opens a stream on
    // a client whose socket is shut — noise on every abandon path, forever.
    pool?.stopAll();
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
  const tracker = new TurnTracker();
  /**
   * Built before the engine, because the engine holds it.
   *
   * `observe` closes over `registered` rather than over the tracker directly: the
   * engine routes a value to the `DriverThread` whose `aggregateId` it carries, which
   * is what fills that thread's event log so `runTurn` can read the assistant text it
   * produced. Feeding the tracker alone would settle turns and leave every one of
   * them wordless.
   *
   * The `?? tracker` fallback covers exactly the window between this line and the
   * `createPorchThreadEngine` call below. It cannot deliver events to a thread — no
   * engine exists to route them — but it keeps `lastSequence` moving, which is what a
   * waiter registered a moment later reads as its `startSequence`.
   */
  pool = createThreadSubscriptionPool({
    subscriber,
    workspaceRoot: config.workspaceRoot,
    observe: (value) => {
      if (registered) registered.observe(value);
      else tracker.observe(value);
    },
    log: (level, message) => {
      if (level === 'ERROR') logger.error(message);
      else if (level === 'WARN') logger.warn(message);
      else logger.info(message);
    },
  });
  registered = createPorchThreadEngine({
    dispatcher,
    journal,
    tracker,
    projectId,
    workspaceRoot: config.workspaceRoot,
    defaultHarness: config.defaultHarness,
    defaultModel: config.defaultModel,
    subscriptions: pool,
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
  // Remembered so a one-shot command can hang up when it is done — see
  // `closeThreadBackend`. Registered alongside the engine and dropped with it.
  //
  // `abandonConnection`, NOT `connection.close`. Since #241 this socket also owns a
  // subscription pool, and `abandonConnection` stops it BEFORE closing — for the reason
  // stated there: closing the socket out from under a running `ResumingSubscription`
  // leaves it retrying, and its retry loop opens a stream on a client whose socket is
  // shut. A deliberate hang-up is the same situation as an abandon and takes the same
  // order. Closing the raw socket instead left the pool to be stopped by the socket's
  // `close` EVENT, which is asynchronous — so a caller that hangs up and keeps running
  // had a live pool against a dead socket in between.
  hangUp.set(key, abandonConnection);
  lastFailure.delete(key);
  return 'installed';
}

/**
 * A per-workspace socket closer, for callers that finish and want to exit.
 *
 * Recorded only on the successful path: every other exit from `initialiseThreadBackend`
 * hangs up before it returns, so there is nothing left to close.
 */
const hangUp = new Map<string, () => void>();

/**
 * Hang up this workspace's t3code connection and drop what was registered on it.
 *
 * WHY A ONE-SHOT COMMAND NEEDS THIS. An open WebSocket is a live handle, so Node's event
 * loop does not drain while it exists. Tower wants exactly that — it holds its connection
 * for as long as it runs. `afx interrupt` and `afx cleanup` do not: they do their work and
 * are expected to exit.
 *
 * Measured, not predicted. The first live run of `afx interrupt` against a real server
 * printed `Interrupt sent to thread <id>` and then never returned; the harness killed it at
 * its timeout and it exited 143. The interrupt had ALREADY landed — so the command was
 * simultaneously working and, from any operator's point of view, hung. That is the exact
 * gap between "the call site is spelled right" and "the command works" that item 2 is about,
 * and only running it could have shown it.
 *
 * Idempotent, and a no-op for a workspace that never connected: a command that took the PTY
 * path must be able to call it without asking whether it needs to.
 *
 * WHAT IT TEARS DOWN, since #241 gave the socket a subscription pool: the registered engine,
 * the streamer, and — through `abandonConnection` — the pool, in that order, before the
 * socket goes. A pool outliving its socket is the dead-engine bug one layer out: every
 * `ResumingSubscription` in it keeps retrying against a client that is shut.
 */
export function closeThreadBackend(workspaceRoot: string): void {
  const key = canonicalWorkspaceKey(workspaceRoot);
  const close = hangUp.get(key);
  hangUp.delete(key);
  // Dropped whether or not there was a socket to close: leaving an engine registered on a
  // connection nobody holds is the dead-engine state this module works to avoid.
  setThreadEngine(undefined, key);
  setThreadStreamer(undefined, key);
  if (!close) return;
  deliberate.add(key);
  close();
}

/**
 * Workspaces whose socket is closing because we asked it to.
 *
 * CLEARED ON THE NEXT CONNECT, not on a timer. The socket's `close` event is asynchronous,
 * and a `setTimeout(..., 0)` fired BEFORE it — so the flag was gone by the time the handler
 * read it and the spurious warning came out anyway, which is how this comment came to be
 * written twice. A workspace stops "hanging up" when it connects again; that is the event
 * that actually ends the state, so it is the one that clears it.
 */
const deliberate = new Set<string>();

function isHangingUp(workspaceRoot: string): boolean {
  return deliberate.has(canonicalWorkspaceKey(workspaceRoot));
}

/**
 * Make a thread this process did not create reachable from this process (issue #227 item 2).
 *
 * `afx interrupt` and `afx cleanup` are fresh processes. Nothing has registered an engine in
 * them, so `getThreadEngine` threw — and since #221 it threw about the right workspace, with
 * a message that named the limitation. Honest, and still not working.
 *
 * The delivery path in `mailbox-wiring.ts` already showed the shape, because Tower is a
 * fresh process for exactly the same reason: register the backend HERE, `attach` the thread
 * from the row that recorded it, then act. This is that shape, in one place, so a third
 * command does not get a third copy of it.
 *
 * The worktree and branch are NOT derivable from a thread id, which is why they are
 * parameters: the caller holds the row. An architect's worktree is the workspace root and
 * its branch is `''` — the shape `createArchitectThread` writes.
 *
 * `ensureThreadBackendReady` throws when a server IS configured and cannot be reached, and
 * returns `not-configured` when none is named. The second is a contradiction for a
 * thread-backed row, and `getThreadEngine` is what says so — it is left to say it rather
 * than pre-empted here, because its message already distinguishes the two causes.
 */
export async function adoptThreadInThisProcess(input: {
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly builderId: string;
  readonly harnessName?: string;
  readonly model?: string;
}): Promise<ThreadEngine> {
  await ensureThreadBackendReady(input.workspaceRoot);
  const engine = getThreadEngine(input.workspaceRoot);
  await engine.attach({
    threadId: input.threadId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    builderId: input.builderId,
    harnessName: input.harnessName,
    model: input.model,
  });
  return engine;
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
