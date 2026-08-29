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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DispatchJournal } from '@cluesmith/porch-driver/commands';
import { TurnTracker } from '@cluesmith/porch-driver/turn';
import { createPorchThreadEngine } from './porch-thread-engine.js';
import { installThreadSpawnFactory, setThreadEngine, tryGetThreadEngine } from './thread-runtime.js';

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

  const configPath = join(workspaceRoot, '.codev', 'config.json');
  if (!existsSync(configPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read thread backend configuration: ${configPath} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  const threads = (parsed as { threads?: Record<string, unknown> } | null)?.threads;
  if (!threads) return null;

  const serverUrl = typeof threads.serverUrl === 'string' ? threads.serverUrl.trim() : '';
  const bootstrapToken = typeof threads.bootstrapToken === 'string' ? threads.bootstrapToken.trim() : '';
  if (!serverUrl && !bootstrapToken) return null;
  if (!serverUrl || !bootstrapToken) {
    // Half-configured is a mistake, not a decision to stay on PTY.
    throw new Error(
      `Incomplete "threads" block in ${configPath}: both serverUrl and bootstrapToken are required (got serverUrl=${serverUrl ? 'set' : 'missing'}, bootstrapToken=${bootstrapToken ? 'set' : 'missing'})`,
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

/**
 * Did the server answer and refuse the credential, rather than being unreachable?
 *
 * `AuthError` is what `@cluesmith/t3-client/auth` throws when an auth endpoint returns a
 * non-2xx — which means the server was reached, parsed the request, and said no. Matched by
 * `name` rather than by `instanceof` because the class is loaded through a dynamic import and
 * a second module instance would defeat the identity check.
 */
function isCredentialRefusal(err: unknown): boolean {
  return err instanceof Error && err.name === 'AuthError';
}

/** Open an authenticated t3code WebSocket and wrap it as a porch-driver dispatcher. */
async function connectDispatcher(config: ThreadBackendConfig): Promise<{ call: (m: string, p: unknown) => Promise<unknown> }> {
  const { T3Client } = await import('@cluesmith/t3-client/client');
  const auth = await import('@cluesmith/t3-client/auth');
  const access = await auth.exchangeBootstrapToken(config.serverUrl, config.bootstrapToken, {
    clientLabel: 'codev-afx',
  });
  const ticket = await auth.issueWebSocketTicket(config.serverUrl, access.access_token);
  const WebSocketCtor = await webSocketCtor();
  const socket = new WebSocketCtor(auth.webSocketUrl(config.serverUrl, ticket.ticket));
  await new Promise<void>((res, rej) => {
    socket.addEventListener('open', () => res(), { once: true });
    socket.addEventListener('error', () => rej(new Error(`t3code socket error connecting to ${config.serverUrl}`)), { once: true });
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
  return { call: (method: string, payload: unknown) => client.call(method, payload) };
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
): Promise<'not-configured' | 'already-installed' | 'installed'> {
  if (tryGetThreadEngine()) return 'already-installed';
  const config = readThreadBackendConfig(resolve(workspaceRoot));
  if (!config) return 'not-configured';

  let dispatcher;
  try {
    dispatcher = await connectDispatcher(config);
  } catch (err) {
    // A server that answered and REFUSED the credential is not a server that could not be
    // reached, and the single most likely refusal here has a specific cause worth naming: a
    // pairing-issued bootstrap token is one-time, and every `afx` process exchanges again.
    // Reporting that as "could not be reached" would send the reader to check the network.
    if (isCredentialRefusal(err)) {
      throw new Error(
        `Thread-backed spawns are configured for ${config.workspaceRoot} and the t3code server at ${config.serverUrl} answered, but REFUSED the bootstrap token (${err instanceof Error ? err.message : String(err)}). The server is reachable — the credential is not usable. Most likely it is a pairing-issued one-time token that a previous spawn already consumed: every afx invocation is a fresh process and exchanges the token again, so this field needs a credential that survives repeated exchange (a desktop bootstrap seed, issued unbounded).`,
        { cause: err },
      );
    }
    throw new Error(
      `Thread-backed spawns are configured for ${config.workspaceRoot} but the t3code server at ${config.serverUrl} could not be reached: ${err instanceof Error ? err.message : String(err)}. Refusing to fall back to the PTY path — an unreachable server is not the same as an unconfigured one.`,
      { cause: err },
    );
  }

  const { createProject } = await import('@cluesmith/porch-driver/thread');
  const journal = new DispatchJournal(join(config.workspaceRoot, '.codev', 'commands.jsonl'));
  const projectId = await createProject(dispatcher, journal, {
    title: `codev:${config.workspaceRoot}`,
    workspaceRoot: config.workspaceRoot,
  });
  setThreadEngine(createPorchThreadEngine({
    dispatcher,
    journal,
    tracker: new TurnTracker(),
    projectId,
    workspaceRoot: config.workspaceRoot,
    defaultHarness: config.defaultHarness,
    defaultModel: config.defaultModel,
  }));
  installThreadSpawnFactory();
  return 'installed';
}
