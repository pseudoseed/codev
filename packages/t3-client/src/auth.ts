/**
 * Spec 146, Phase 2 — authenticating against a self-hosted t3code server.
 *
 * EVERY ENDPOINT AND TOKEN TYPE HERE IS COPIED FROM THE PROVEN SPIKE, NOT DERIVED.
 *
 * In Phase 1 I invented `/api/auth/token` with an RFC-standard
 * `subject_token_type` because it looked like what an OAuth server would do, and
 * got a 404. The working flow was already committed, in
 * `codev/experiments/146-t3code-porch-proof/`. t3code uses `POST /oauth/token`,
 * form-encoded, with its own
 * `urn:t3:params:oauth:token-type:environment-bootstrap`, then
 * `POST /api/auth/websocket-ticket`.
 *
 * If these stop working, read that experiment again before changing them.
 *
 * SECURITY, from the spec's constraints:
 *  - the bootstrap token is single-use with a bounded TTL
 *  - it is never written to a repository, a log, or a shell history file — this
 *    module never persists it and never logs it, and callers must not either
 *  - transport is the caller's choice, but a non-loopback host without TLS is
 *    refused here rather than warned about
 */

export interface AccessToken {
  readonly access_token: string;
  readonly token_type: string;
  /** Space-separated scopes the server actually granted, which may be fewer than requested. */
  readonly scope: string;
  readonly expires_in?: number;
}

export interface WebSocketTicket {
  readonly ticket: string;
  readonly expires_in?: number;
}

/**
 * The scopes Codev needs.
 *
 * `orchestration:operate` covers every dispatchable command, which the spec notes
 * is exactly why a t3code session cannot be used to prove a human is present —
 * see the approval capability in Phase 6. Requesting it here is about talking to
 * the server, and grants nothing about gates.
 */
export const CODEV_SCOPES = [
  'orchestration:read',
  'orchestration:operate',
  'terminal:operate',
  'review:write',
  'relay:read',
] as const;

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    body: string,
  ) {
    // The body may echo the token back. Truncate hard and never log the request.
    super(`t3code auth failed at ${endpoint}: ${status} ${body.slice(0, 200)}`);
    this.name = 'AuthError';
  }
}

/**
 * Refuse a non-loopback base URL without TLS.
 *
 * The spec: "All remote transport is HTTPS/WSS. Loopback-only binding is the
 * default; exposing an interface is an explicit action." A warning would let this
 * pass in the one case it matters, so it throws.
 */
export function assertTransportSafe(baseUrl: string): void {
  const url = new URL(baseUrl);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (!loopback && url.protocol !== 'https:') {
    throw new Error(
      `Refusing to authenticate to ${url.origin} over ${url.protocol}. ` +
        `Non-loopback transport must be HTTPS — a bootstrap token on a plaintext ` +
        `connection is a token on the wire.`,
    );
  }
}

/**
 * Exchange a single-use bootstrap token for a scoped access token.
 *
 * The bootstrap token is consumed by this call. It exists in memory for the
 * duration and is never returned, persisted or logged.
 */
export async function exchangeBootstrapToken(
  baseUrl: string,
  bootstrapToken: string,
  options: { readonly clientLabel?: string; readonly timeoutMs?: number } = {},
): Promise<AccessToken> {
  assertTransportSafe(baseUrl);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: bootstrapToken,
    subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: CODEV_SCOPES.join(' '),
    client_label: options.clientLabel ?? 'codev',
    client_device_type: 'bot',
  });

  const endpoint = `${baseUrl.replace(/\/$/, '')}/oauth/token`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });

  if (!response.ok) throw new AuthError(response.status, '/oauth/token', await response.text());
  return (await response.json()) as AccessToken;
}

/** Issue a short-lived ticket for the WebSocket upgrade. */
export async function issueWebSocketTicket(
  baseUrl: string,
  accessToken: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<WebSocketTicket> {
  assertTransportSafe(baseUrl);

  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/auth/websocket-ticket`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });

  if (!response.ok) {
    throw new AuthError(response.status, '/api/auth/websocket-ticket', await response.text());
  }
  return (await response.json()) as WebSocketTicket;
}

/**
 * A GET against a t3code HTTP endpoint, carrying an access token.
 *
 * WHY THIS IS IN THE CLIENT (issue #227 item 4). Codev had one bare `fetch` with a
 * hand-built `authorization: Bearer` header, in `thread-backend.ts`, sitting next to the
 * module that owns every other request to this server. It worked, and it is one request —
 * but the knowledge of how this server is addressed then lived in two places, and only one
 * of them was kept honest by the rest of the auth flow.
 *
 * Concretely, the copy skipped `assertTransportSafe`: it would have sent a bearer token
 * over plaintext to a non-loopback host, which every other call here refuses. That is what
 * a second addressing path costs, and it was already being paid.
 *
 * RETURNS THE RESPONSE, not parsed JSON. The one caller distinguishes "the server answered
 * no" from "the request could not be made" from "the answer was not the shape expected",
 * and collapsing a non-2xx into a throw here would spell the first like the second.
 */
export async function authorizedGet(
  baseUrl: string,
  path: string,
  accessToken: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<Response> {
  assertTransportSafe(baseUrl);
  // The signal covers the body read as well as the headers, so a response that starts and
  // stalls is bounded too. Unbounded is not "slow": the await never settles.
  return fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
}

/**
 * The WebSocket URL for a ticket.
 *
 * `ws:` is only produced for loopback; anything else gets `wss:`, matching
 * `assertTransportSafe`.
 */
export function webSocketUrl(baseUrl: string, ticket: string): string {
  assertTransportSafe(baseUrl);
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = `?wsTicket=${encodeURIComponent(ticket)}`;
  return url.toString();
}

/**
 * Report which requested scopes the server withheld.
 *
 * Returns the missing ones rather than a boolean: "the grant was narrower than
 * asked" and "which parts were withheld" are different facts, and a caller that
 * only learns the first cannot act on it.
 */
export function missingScopes(granted: string): string[] {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return CODEV_SCOPES.filter((scope) => !have.has(scope));
}
