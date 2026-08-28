/**
 * Spec 146, Phase 2 — the t3code RPC client.
 *
 * Request/response and streaming over the envelope in `envelope.ts`. The socket
 * is injected rather than constructed here, so this file runs unchanged in a
 * browser, in Node, and in a test against a fake — the same reason
 * `@cluesmith/codev-sdk` takes its transport as an adapter (#1189).
 *
 * TWO PROPERTIES THE SPIKE DID NOT EXERCISE, AND THIS FILE OWES:
 *
 * 1. **Acks.** The server enables ack-based backpressure, so a client that
 *    consumes `Chunk` frames without acking stalls its own stream once the
 *    server's buffer fills — silently. Every chunk is acked here, before the
 *    values are handed to the consumer, so a slow consumer cannot deadlock the
 *    connection by taking a long time in a handler.
 *
 * 2. **Loud failure when the server is unreachable.** The spec: "With the server
 *    unreachable, a send fails loudly at the call site. It does not silently
 *    queue." There is no queue in this layer at all. Queueing belongs to Phase 4,
 *    where it is a deliberate, acknowledged, durable thing — not an accident of
 *    the transport.
 */

import {
  ack,
  decodeFrames,
  encodeFrame,
  exitValue,
  interrupt,
  request,
  type ChunkFrame,
  type ExitFrame,
  type ServerFrame,
} from './envelope.js';
import { checkPayload, type CheckOutcome } from './checked.js';

/**
 * The minimum a socket must do. Deliberately the shape of the standard
 * `WebSocket`, so a real one satisfies it without a wrapper.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'open' | 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  readonly readyState: number;
}

export class NotConnectedError extends Error {
  constructor(operation: string) {
    super(
      `Cannot ${operation}: the t3code socket is not open. ` +
        `This layer does not queue — a send against an unreachable server fails here, ` +
        `at the call site, rather than being held somewhere the caller cannot see.`,
    );
    this.name = 'NotConnectedError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly ms: number,
  ) {
    super(`t3code request ${method} produced no Exit within ${ms}ms`);
    this.name = 'RequestTimeoutError';
  }
}

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** Present for streaming calls. */
  onChunk?: (values: ReadonlyArray<unknown>) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

export interface T3ClientOptions {
  /** How long to wait for an `Exit` before giving up. Streams override per call. */
  readonly requestTimeoutMs?: number;
  /** Called for any frame not attributable to a request — `Defect`, `Pong`. */
  readonly onOutOfBand?: (frame: ServerFrame) => void;
  /**
   * Called when a frame cannot be parsed. Default rethrows, because an
   * unreadable connection presenting as a working one is the failure this whole
   * project is about.
   */
  readonly onMalformed?: (error: Error) => void;
  /**
   * Shape-check inbound payloads against the vendored contract. Default `true`.
   *
   * A failing payload rejects the call (or the stream), carrying the method tag
   * and the failing path. It is never coerced and never dropped. Passing is NOT
   * proof of contract validity — see `checked.ts`.
   */
  readonly checkPayloads?: boolean;
  /**
   * Called once per method the generated contract cannot check.
   *
   * A method with no generated schema is `unchecked`, which is not a pass. If
   * this is omitted the method is still recorded on `uncheckedMethods`, so the
   * fact survives somewhere a caller can read it rather than nowhere.
   */
  readonly onUnchecked?: (method: string, role: 'input' | 'output', reason: string) => void;
}

export class T3Client {
  #pending = new Map<string | number, Pending>();
  #nextId = 1;
  #closed = false;
  /** Methods whose payloads the vendored contract could not check, with the reason. */
  readonly uncheckedMethods = new Map<string, string>();

  constructor(
    private readonly socket: SocketLike,
    private readonly options: T3ClientOptions = {},
  ) {
    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => this.#onClose());
  }

  #onMessage(event: { data: unknown }): void {
    const raw = typeof event.data === 'string' ? event.data : String(event.data);
    let frames: ServerFrame[];
    try {
      frames = decodeFrames(raw);
    } catch (error) {
      if (this.options.onMalformed) {
        this.options.onMalformed(error as Error);
        return;
      }
      throw error;
    }
    for (const frame of frames) this.#dispatch(frame);
  }

  #dispatch(frame: ServerFrame): void {
    switch (frame._tag) {
      case 'Chunk': {
        const chunk = frame as ChunkFrame;
        // ACK FIRST, then deliver. Acking after the handler would let a slow
        // consumer throttle the connection into a stall that looks like the
        // server having nothing to say. The ack goes out even for a payload we
        // are about to reject: the frame WAS received, and withholding the ack
        // would stall the connection on top of the error rather than instead of
        // it.
        // The ack is best-effort by necessity: `#sendRaw` throws
        // `NotConnectedError` if the socket closed between the frame arriving and
        // this line, and we are inside the socket's message listener, where a
        // throw reaches no call site and takes the message loop with it. Same
        // hazard as the codegen errors in `#checkInbound`. A dropped socket
        // already fails every pending request via `#onClose`, so swallowing here
        // loses nothing: there is no one left to ack to.
        try {
          this.#sendRaw(ack(chunk.requestId));
        } catch {
          /* socket closed under us; #onClose has already failed the pending requests */
        }
        const pending = this.#pending.get(chunk.requestId);
        if (!pending) return;
        for (const value of chunk.values) {
          const failure = this.#checkInbound(pending.method, value);
          if (failure) {
            this.#pending.delete(chunk.requestId);
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(failure);
            return;
          }
        }
        pending.onChunk?.(chunk.values);
        return;
      }
      case 'Exit': {
        const exit = frame as ExitFrame;
        const pending = this.#pending.get(exit.requestId);
        if (!pending) return;
        this.#pending.delete(exit.requestId);
        if (pending.timer) clearTimeout(pending.timer);
        try {
          const value = exitValue(exit);
          // A streaming call's Exit carries no domain payload — the values came
          // through Chunk frames and were checked there. Checking `undefined`
          // against the output schema would fail every stream.
          const failure = pending.onChunk ? null : this.#checkInbound(pending.method, value);
          if (failure) {
            pending.reject(failure);
            return;
          }
          pending.resolve(value);
        } catch (error) {
          pending.reject(error as Error);
        }
        return;
      }
      default:
        this.options.onOutOfBand?.(frame);
    }
  }

  /**
   * Returns the error for a payload that failed its shape check, or null.
   *
   * `unchecked` is recorded rather than returned: it is not a failure, and it
   * must not be spelled like a pass either — it lands on `uncheckedMethods` and
   * on `onUnchecked` so it exists somewhere readable.
   */
  #checkInbound(method: string, value: unknown): Error | null {
    if (this.options.checkPayloads === false) return null;
    let outcome: CheckOutcome;
    try {
      outcome = checkPayload(method, 'output', value);
    } catch (error) {
      // UnresolvedRefError / UnsupportedKeywordError are defects in the generated
      // artifacts, not facts about this payload, so they are returned AS
      // THEMSELVES rather than wrapped in a PayloadShapeError — a caller must be
      // able to tell "our codegen is broken" from "the server sent something
      // wrong". They are returned rather than rethrown because this runs inside
      // the socket's message listener, where a throw reaches no call site and
      // takes the message loop with it instead of failing the request.
      return error as Error;
    }
    if (outcome.status === 'failed') return outcome.error;
    if (outcome.status === 'unchecked' && !this.uncheckedMethods.has(method)) {
      this.uncheckedMethods.set(method, outcome.reason);
      this.options.onUnchecked?.(method, 'output', outcome.reason);
    }
    return null;
  }

  #onClose(): void {
    this.#closed = true;
    // Every in-flight request fails loudly. Leaving them pending would hang the
    // caller on a connection that is already gone.
    const error = new NotConnectedError('complete in-flight requests');
    for (const [, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #sendRaw(frame: Parameters<typeof encodeFrame>[0]): void {
    if (this.#closed || this.socket.readyState !== OPEN) {
      throw new NotConnectedError(`send ${frame._tag}`);
    }
    this.socket.send(encodeFrame(frame));
  }

  /** Call a method and resolve with its success value. */
  async call(method: string, payload: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.#nextId++;
    const ms = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;

    return await new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject };
      pending.timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RequestTimeoutError(method, ms));
      }, ms);
      this.#pending.set(id, pending);

      try {
        this.#sendRaw(request(id, method, payload));
      } catch (error) {
        this.#pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error as Error);
      }
    });
  }

  /**
   * Call a streaming method, invoking `onValue` per streamed value.
   *
   * Resolves when the server sends `Exit`. Chunks are acked automatically; see
   * the note at the top of this file for why that is not optional.
   */
  async stream(
    method: string,
    payload: unknown,
    onValue: (value: unknown) => void,
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = this.#nextId++;
    const ms = timeoutMs ?? this.options.requestTimeoutMs ?? 300_000;

    return await new Promise<unknown>((resolve, reject) => {
      const pending: Pending = {
        method,
        resolve,
        reject,
        onChunk: (values) => {
          for (const value of values) onValue(value);
        },
      };
      pending.timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RequestTimeoutError(method, ms));
      }, ms);
      this.#pending.set(id, pending);

      try {
        this.#sendRaw(request(id, method, payload));
      } catch (error) {
        this.#pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error as Error);
      }
    });
  }

  /** Cancel an in-flight request by its id. */
  cancel(id: string | number): void {
    this.#sendRaw(interrupt(id));
  }

  /** How many requests are still awaiting an Exit. */
  get inFlight(): number {
    return this.#pending.size;
  }
}
