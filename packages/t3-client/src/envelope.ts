/**
 * Spec 146, Phase 2 — the t3code RPC wire envelope.
 *
 * t3code serves its RPC over `RpcSerialization.layerJson` (`apps/server/src/ws.ts`).
 * Under that layer the wire is **one JSON object per WebSocket frame**, and the
 * envelope is about ten tagged shapes. The domain schemas are not in the envelope:
 * it carries a `tag` naming the method and an opaque `payload`, which is why the
 * Phase 1 spike drove a real server with `Schema.Unknown` payloads and why
 * `tools/t3-server/smoke.mjs` dispatched a real command as plain JSON with no
 * Effect at all.
 *
 * That is the whole reason this file can exist. Reference for every shape below:
 * `effect-smol/packages/effect/src/unstable/rpc/RpcMessage.ts:61-155`.
 *
 * Zero dependencies, by design — this package must run in a browser and in Node,
 * and the envelope is small enough that vendoring a library for it would cost more
 * than it saves.
 */

// ---------------------------------------------------------------- client -> server

/** A method call. `id` correlates every later frame back to this request. */
export interface RequestFrame {
  readonly _tag: 'Request';
  readonly id: string | number;
  /** The method name, e.g. `orchestration.dispatchCommand`. */
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly sampled?: boolean;
}

/**
 * Acknowledgement of a received `Chunk`.
 *
 * **This is a protocol obligation, not an optimisation.** The server enables
 * ack-based backpressure (`RpcServer.ts`, `supportsAck`), so a client that
 * receives chunks without acking stalls its own stream once the server's buffer
 * fills — and it stalls *silently*, which is the failure mode this project has
 * spent a whole phase learning to distrust.
 */
export interface AckFrame {
  readonly _tag: 'Ack';
  readonly requestId: string | number;
}

/** Cancel an in-flight request. */
export interface InterruptFrame {
  readonly _tag: 'Interrupt';
  readonly requestId: string | number;
}

/** No more input for this connection. */
export interface EofFrame {
  readonly _tag: 'Eof';
}

/** Liveness probe; answered with `Pong`. */
export interface PingFrame {
  readonly _tag: 'Ping';
}

export type ClientFrame = RequestFrame | AckFrame | InterruptFrame | EofFrame | PingFrame;

// ---------------------------------------------------------------- server -> client

/** One or more streamed values for a request. Must be acked. */
export interface ChunkFrame {
  readonly _tag: 'Chunk';
  readonly requestId: string | number;
  readonly values: ReadonlyArray<unknown>;
}

/** Terminal result for a request: success or failure. */
export interface ExitFrame {
  readonly _tag: 'Exit';
  readonly requestId: string | number;
  readonly exit: ExitValue;
}

/**
 * One entry in a failure cause.
 *
 * `Fail` is an expected domain error, `Die` a defect, `Interrupt` a cancellation.
 */
export type CauseEntry =
  | { readonly _tag: 'Fail'; readonly error: unknown }
  | { readonly _tag: 'Die'; readonly defect: unknown }
  | { readonly _tag: 'Interrupt'; readonly fiberId: number | undefined };

/**
 * `cause` is an **array**, and this was wrong here until review caught it.
 *
 * `ExitEncoded` in `RpcMessage.ts:257-275` declares
 * `cause: ReadonlyArray<{Fail} | {Die} | {Interrupt}>`. An Effect cause is a
 * tree — parallel failures and interrupts travel together — so a single object
 * cannot represent it. The first version of this file typed it as one object and
 * read `cause._tag`, which on an array is `undefined`: every failure would have
 * come back with no kind and no tag, and the whole point of naming the error was
 * to let Phase 3 branch on which failure it was.
 */
export type ExitValue =
  | { readonly _tag: 'Success'; readonly value?: unknown }
  | { readonly _tag: 'Failure'; readonly cause: ReadonlyArray<CauseEntry> };

/** A server-side defect not attributable to one request. */
export interface DefectFrame {
  readonly _tag: 'Defect';
  readonly defect: unknown;
}

export interface PongFrame {
  readonly _tag: 'Pong';
}

/**
 * The server reporting a protocol error against every in-flight request.
 *
 * In `FromServerEncoded` (`RpcMessage.ts:192-197`) and previously missing here,
 * so the decoder rejected it as an unknown tag — turning a message that says
 * "your protocol is wrong" into "this connection is unreadable". Both are bad
 * news, but they are different bad news and only one of them names the cause.
 */
export interface ClientProtocolErrorFrame {
  readonly _tag: 'ClientProtocolError';
  readonly error: unknown;
}

/**
 * `ClientEnd` is deliberately absent.
 *
 * It exists in `FromServer` (`RpcMessage.ts:180-184`), the *decoded* union, but
 * not in `FromServerEncoded` — it never arrives on the wire. Accepting it was
 * harmless in the sense that it never appeared, and harmful in the sense that
 * the file claimed to have been validated against `RpcMessage.ts` while listing
 * a shape that union does not contain.
 */
export type ServerFrame =
  | ChunkFrame
  | ExitFrame
  | DefectFrame
  | PongFrame
  | ClientProtocolErrorFrame;

// ---------------------------------------------------------------- errors

/**
 * A frame that could not be understood.
 *
 * Thrown, never returned as a benign value. An unparseable frame and a frame
 * carrying no data must not be spelled the same way: the first means the
 * connection is saying something we cannot read, the second is ordinary.
 */
export class MalformedFrameError extends Error {
  constructor(
    readonly raw: string,
    readonly reason: string,
  ) {
    super(
      `Malformed t3code RPC frame (${reason}): ${raw.slice(0, 200)}${raw.length > 200 ? '…' : ''}`,
    );
    this.name = 'MalformedFrameError';
  }
}

// ---------------------------------------------------------------- encode / decode

// Exactly `FromServerEncoded` (`RpcMessage.ts:192-197`). Not `FromServer`, which
// is the decoded union and contains `ClientEnd` — a shape that never reaches a
// socket.
const SERVER_TAGS = new Set(['Chunk', 'Exit', 'Defect', 'Pong', 'ClientProtocolError']);

/** Serialise one client frame for the wire. One JSON object per frame. */
export function encodeFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

/** Build a request frame. `headers` defaults to empty, which the server requires to be present. */
export function request(
  id: string | number,
  tag: string,
  payload: unknown,
  headers: ReadonlyArray<readonly [string, string]> = [],
): RequestFrame {
  return { _tag: 'Request', id, tag, payload, headers };
}

export const ack = (requestId: string | number): AckFrame => ({ _tag: 'Ack', requestId });
export const interrupt = (requestId: string | number): InterruptFrame => ({
  _tag: 'Interrupt',
  requestId,
});
export const eof = (): EofFrame => ({ _tag: 'Eof' });
export const ping = (): PingFrame => ({ _tag: 'Ping' });

/**
 * Parse one WebSocket message into server frames.
 *
 * Returns an array because a single message may carry a batch — the spike
 * observed both a bare object and an array of them, so handling only one shape
 * would drop frames on a connection that looked healthy.
 *
 * Throws `MalformedFrameError` rather than returning `[]` for anything it cannot
 * read. An empty array means "this message contained no frames", which is a
 * different fact from "this message was unreadable".
 */
export function decodeFrames(raw: string): ServerFrame[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new MalformedFrameError(raw, `not JSON: ${(error as Error).message}`);
  }

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.map((candidate) => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new MalformedFrameError(raw, 'frame is not an object');
    }
    const tag = (candidate as { _tag?: unknown })._tag;
    if (typeof tag !== 'string') {
      throw new MalformedFrameError(raw, 'frame has no string _tag');
    }
    if (!SERVER_TAGS.has(tag)) {
      // An unknown tag is NOT ignored. The server speaking a shape we do not know
      // means our envelope model is out of date, and silently skipping it would
      // present a degraded connection as a working one.
      throw new MalformedFrameError(raw, `unknown server frame tag "${tag}"`);
    }
    return candidate as ServerFrame;
  });
}

/** Did this exit succeed? */
export function isSuccess(exit: ExitFrame): boolean {
  return exit.exit._tag === 'Success';
}

/**
 * A request the server answered with a failure exit.
 *
 * Named, and carrying the decoded error rather than only a rendered string,
 * because callers have to branch on WHICH failure. Phase 3's crash recovery is
 * the concrete case: replaying a `commandId` against a different aggregate
 * raises `OrchestrationCommandIdConflictError`
 * (`apps/server/src/orchestration/Errors.ts:56`), and "the server refused this
 * as a duplicate" needs a different response from "the request failed". An
 * earlier version threw a plain `Error` with the payload stringified into the
 * message, which made that distinction reachable only by matching on text.
 */
export class RpcFailureError extends Error {
  constructor(
    readonly requestId: string | number,
    /** Every entry in the cause, in the order the server sent them. */
    readonly cause: ReadonlyArray<CauseEntry>,
  ) {
    super(
      `t3code RPC request ${String(requestId)} failed ` +
        `(${cause.map((entry) => entry._tag).join(', ') || 'empty cause'}): ` +
        JSON.stringify(cause).slice(0, 300),
    );
    this.name = 'RpcFailureError';
  }

  /**
   * The first `Fail` entry's error, which is the domain error a caller branches
   * on. Null when the cause carries none — a pure `Die` or `Interrupt`.
   *
   * "First `Fail`" rather than "the cause", because a cause is a tree and may
   * hold several. A caller needing all of them reads `cause`.
   */
  get error(): unknown {
    const failure = this.cause.find((entry) => entry._tag === 'Fail');
    return failure ? (failure as { error: unknown }).error : null;
  }

  /**
   * The domain error's `_tag`, when it has one.
   *
   * t3code's errors are `Schema.TaggedErrorClass`es, so the tag is the thing to
   * branch on. Returns null rather than a guess when there is none.
   */
  get tag(): string | null {
    const error = this.error as { _tag?: unknown } | null;
    return error && typeof error === 'object' && typeof error._tag === 'string' ? error._tag : null;
  }

  /** True when the request was cancelled rather than failed. */
  get interrupted(): boolean {
    return this.cause.some((entry) => entry._tag === 'Interrupt');
  }

  /** True when the cause carries a defect — a bug, not an expected error. */
  get died(): boolean {
    return this.cause.some((entry) => entry._tag === 'Die');
  }
}

/** The value of a successful exit, or throw with the failure's cause. */
export function exitValue(exit: ExitFrame): unknown {
  if (exit.exit._tag === 'Success') return exit.exit.value;
  throw new RpcFailureError(exit.requestId, exit.exit.cause);
}
