/**
 * Spec 146, Phase 2 — WebSocket lifecycle and reconnect.
 *
 * The socket itself is injected as a factory so this module runs in a browser, in
 * Node, and against a fake in tests without a wrapper per environment.
 *
 * WHAT RECONNECT DOES *NOT* DO HERE
 *
 * It does not replay anything. Reconnecting restores a transport; restoring a
 * *subscription* means resubscribing with `afterSequence` at the last **applied**
 * cursor, and deciding whether what came back was replayed, empty, or a gap.
 * That lives in `resume.ts`, because a socket that silently reconnects and
 * resumes reading looks identical to one that never dropped — and the events
 * between are exactly what the spec says must never be assumed continuous.
 *
 * So this module reports the drop and lets the caller decide. The reconnection is
 * automatic; the resumption is not.
 */

export interface ReconnectPolicy {
  /** Delay before attempt `n` (1-based). Return null to stop retrying. */
  delayMs(attempt: number): number | null;
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * Jitter is not decoration: without it, N builders dropped by one server restart
 * reconnect in lockstep and arrive as a thundering herd. The spec expects six
 * concurrent builders per workspace and more than one machine.
 */
export function exponentialBackoff(options: {
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly maxAttempts?: number;
  /** Injectable for deterministic tests. */
  readonly random?: () => number;
} = {}): ReconnectPolicy {
  const base = options.baseMs ?? 500;
  const max = options.maxMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? Infinity;
  const random = options.random ?? Math.random;

  return {
    delayMs(attempt) {
      if (attempt > maxAttempts) return null;
      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      return Math.floor(random() * ceiling);
    },
  };
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ManagedSocketEvents {
  /** A connection came up. `reconnected` distinguishes the first from the rest. */
  readonly onOpen?: (info: { readonly reconnected: boolean; readonly attempt: number }) => void;
  /**
   * The connection dropped.
   *
   * Fired BEFORE any reconnect attempt, so a caller can mark its subscriptions
   * stale. A caller that learns about the drop only after the socket is back has
   * no way to tell that its event stream has a hole in it.
   */
  readonly onDrop?: (info: { readonly willRetry: boolean; readonly attempt: number }) => void;
  /** Retries are exhausted or the policy said stop. Terminal. */
  readonly onGaveUp?: (info: { readonly attempts: number }) => void;
}

export interface SocketFactory {
  (url: string): {
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: never) => void): void;
    readonly readyState: number;
  };
}

/**
 * A socket that reconnects, and tells you when it did.
 *
 * The URL is produced per attempt rather than captured once, because a t3code
 * WebSocket ticket is short-lived: reusing the original URL after a long backoff
 * reconnects with an expired ticket and fails in a way that looks like the server
 * refusing us.
 */
export class ManagedSocket {
  #state: ConnectionState = 'closed';
  #attempt = 0;
  #everConnected = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly urlFor: () => string | Promise<string>,
    private readonly factory: SocketFactory,
    private readonly policy: ReconnectPolicy = exponentialBackoff(),
    private readonly events: ManagedSocketEvents = {},
  ) {}

  get state(): ConnectionState {
    return this.#state;
  }

  /** Stop reconnecting. Idempotent. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#state = 'closed';
  }

  /**
   * Connect, retrying per the policy. Resolves with the live socket on success.
   *
   * Rejects when the policy gives up — it does not resolve with a dead socket,
   * because a caller holding one cannot distinguish it from a working one.
   */
  async connect(): Promise<ReturnType<SocketFactory>> {
    this.#stopped = false;
    for (;;) {
      this.#attempt += 1;
      this.#state = this.#everConnected ? 'reconnecting' : 'connecting';

      try {
        const socket = await this.#openOnce();
        this.#state = 'open';
        const reconnected = this.#everConnected;
        this.#everConnected = true;
        const attempt = this.#attempt;
        this.#attempt = 0;
        this.events.onOpen?.({ reconnected, attempt });
        return socket;
      } catch {
        if (this.#stopped) throw new Error('ManagedSocket stopped while connecting');
        const delay = this.policy.delayMs(this.#attempt);
        this.events.onDrop?.({ willRetry: delay !== null, attempt: this.#attempt });
        if (delay === null) {
          this.#state = 'closed';
          this.events.onGaveUp?.({ attempts: this.#attempt });
          throw new Error(`ManagedSocket gave up after ${this.#attempt} attempt(s)`);
        }
        await new Promise<void>((resolve) => {
          this.#timer = setTimeout(resolve, delay);
        });
      }
    }
  }

  async #openOnce(): Promise<ReturnType<SocketFactory>> {
    // Re-derived per attempt: tickets expire, and a stale one fails as a refusal.
    const url = await this.urlFor();
    const socket = this.factory(url);

    return await new Promise((resolve, reject) => {
      let settled = false;
      socket.addEventListener('open', (() => {
        if (settled) return;
        settled = true;
        resolve(socket);
      }) as never);
      socket.addEventListener('error', ((event: unknown) => {
        if (settled) return;
        settled = true;
        reject(new Error(`socket error: ${String((event as { message?: string })?.message ?? 'unknown')}`));
      }) as never);
      socket.addEventListener('close', (() => {
        if (settled) return;
        settled = true;
        reject(new Error('socket closed before opening'));
      }) as never);
    });
  }
}
