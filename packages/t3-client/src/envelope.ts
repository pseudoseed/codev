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

export type ExitValue =
  | { readonly _tag: 'Success'; readonly value?: unknown }
  | {
      readonly _tag: 'Failure';
      readonly cause: {
        readonly _tag: 'Fail' | 'Die' | 'Interrupt';
        readonly error?: unknown;
        readonly defect?: unknown;
      };
    };

/** A server-side defect not attributable to one request. */
export interface DefectFrame {
  readonly _tag: 'Defect';
  readonly defect: unknown;
}

export interface PongFrame {
  readonly _tag: 'Pong';
}

export interface ClientEndFrame {
  readonly _tag: 'ClientEnd';
}

export type ServerFrame = ChunkFrame | ExitFrame | DefectFrame | PongFrame | ClientEndFrame;

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

const SERVER_TAGS = new Set(['Chunk', 'Exit', 'Defect', 'Pong', 'ClientEnd']);

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
    /** `Fail` for an expected domain error, `Die` for a defect. */
    readonly kind: string,
    /** The server's error payload, undecoded. */
    readonly cause: unknown,
  ) {
    super(
      `t3code RPC request ${String(requestId)} failed (${kind}): ` +
        JSON.stringify(cause).slice(0, 300),
    );
    this.name = 'RpcFailureError';
  }

  /**
   * The server error's `_tag`, when it has one.
   *
   * t3code's errors are `Schema.TaggedErrorClass`es, so the tag is the thing to
   * branch on. Returns null rather than a guess when the payload carries none.
   */
  get tag(): string | null {
    const error = this.cause as { _tag?: unknown } | null;
    return error && typeof error._tag === 'string' ? error._tag : null;
  }
}

/** The value of a successful exit, or throw with the failure's cause. */
export function exitValue(exit: ExitFrame): unknown {
  if (exit.exit._tag === 'Success') return exit.exit.value;
  const cause = exit.exit.cause;
  throw new RpcFailureError(exit.requestId, cause._tag, cause.error ?? cause.defect ?? cause);
}
