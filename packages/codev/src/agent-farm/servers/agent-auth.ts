/**
 * Authentication and transport posture for the codev-agent surface
 * (Spec 146 Phase 7).
 *
 * ## Which boundary each mechanism is
 *
 * The spec's premise: the server executes arbitrary agent shell in worktrees, so
 * reaching it is equivalent to shell access. Three mechanisms sit in front of
 * that, and they are not interchangeable — each is named with what it actually
 * guarantees, because the failure this phase was warned about is inheriting a
 * boundary rather than establishing one.
 *
 * - **Loopback binding is a REACHABILITY boundary, not an authorization
 *   boundary.** It decides which network interfaces can carry a packet here. It
 *   says nothing about who sent one: over loopback TCP the peer process is not
 *   attributable — `remoteAddress` is `127.0.0.1` for a builder, an architect and
 *   a browser alike, and there is no peer-credential mechanism for TCP on macOS.
 *   No check in this file treats "it arrived on loopback" as permission.
 * - **The machine credential is an AUTHENTICATION boundary against a remote
 *   peer, and against nothing local.** A remote peer cannot read `~/.agent-farm`;
 *   a same-uid local process can read everything this process can. What it adds
 *   beyond Tower's shared local key is per-machine revocation: one key for every
 *   client cannot express "revoke the iPad, keep the laptop".
 * - **Origin rules are a BROWSER boundary.** They stop a page the operator
 *   happens to visit from driving this service with the credentials the browser
 *   will attach. They are worth nothing against a non-browser caller, which is
 *   why they are never the only check.
 *
 * ## Why the route table exists
 *
 * The deliverable is that "a route added without auth fails a test that
 * enumerates the router rather than checking a list by hand". A hand-kept list of
 * routes-and-their-auth is a claim; the dispatcher is the fact. So the table below
 * IS the dispatcher: `agent-routes.ts` resolves every request through
 * {@link matchAgentRoute} and cannot serve a path the table does not name. The
 * enumerating test then drives a real request at every entry, and a separate
 * check reads the dispatcher's source for route literals the table has missed.
 */

import type http from 'node:http';
import { isAllowedOrigin } from '../utils/server-utils.js';
import { MACHINE_SIGNAL, type MachineCredentialStore } from '../lib/machine-credentials.js';
import { PAIRING_SIGNAL } from '../lib/pairing.js';

export const AGENT_ROUTE_PREFIX = '/api/agent/v1';
/** Phase 6's browser session. Elevation for approvals, on top of a machine credential. */
export const HUMAN_SESSION_HEADER = 'x-codev-human-session';
/** The paired machine's credential, `<credentialId>.<secret>`. */
export const MACHINE_CREDENTIAL_HEADER = 'x-codev-machine-credential';
/**
 * The pairing token, on the one route that has no credential yet. A header, not a
 * query parameter and not argv: a URL lands in access logs and a command line
 * lands in `ps` output and shell history.
 */
export const PAIRING_TOKEN_HEADER = 'x-codev-pairing-token';
/**
 * The approval receipt, handed back once at submit and presented to read that
 * operation's outcome after a restart has destroyed the submitting session.
 *
 * A HEADER FOR THE SAME REASON AS EVERY OTHER CREDENTIAL HERE, and this one was
 * a query parameter first — which crossed the rule written three lines above it.
 * URLs are logged: Tower logs `req.url` during the boot window, and again on
 * every authentication failure, which is exactly when a client polling across a
 * restart arrives. Reverse proxies log query strings as a matter of course, so
 * the exposure was never bounded by our own logging either.
 *
 * `spec-236-receipt-not-in-url.test.ts` asserts the absence: no poll URL and no
 * log line may contain a receipt. Assert the absence, because the query string is
 * the convenient place to put it and convenience is what put it there.
 */
export const APPROVAL_RECEIPT_HEADER = 'x-codev-approval-receipt';

export const TRANSPORT_SIGNAL = {
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  INSECURE_NON_LOOPBACK_BIND_REFUSED: 'INSECURE_NON_LOOPBACK_BIND_REFUSED',
  BIND_LOOPBACK_ONLY: 'BIND_LOOPBACK_ONLY',
  BIND_EXPOSED_TLS_DECLARED: 'BIND_EXPOSED_TLS_DECLARED',
} as const;

export type TransportSignal = (typeof TRANSPORT_SIGNAL)[keyof typeof TRANSPORT_SIGNAL];

/**
 * What a route requires.
 *
 * `human-session` INCLUDES `machine-credential`: elevation never replaces the
 * machine's identity, so revoking a machine fails its approval routes closed too.
 */
export type AgentAuthMode =
  | 'pairing-token'
  | 'machine-credential'
  | 'machine-credential-and-pairing-token'
  | 'human-session';

export interface AgentRoute {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Exact pathname, for routes without parameters. */
  readonly pathname?: string;
  /** Pattern, for routes with a path parameter. Anchored. */
  readonly pattern?: RegExp;
  /**
   * A concrete pathname this route matches. The enumerating test drives a real
   * request at it, so it is not documentation — an entry whose probe does not
   * match its own route fails a test.
   */
  readonly probe: string;
  readonly authentication: AgentAuthMode;
  /** Why this route needs what it needs. For an operator reading the table. */
  readonly rationale: string;
}

/**
 * Every codev-agent route, with its authentication mode.
 *
 * NO ROUTE IS PUBLIC. There is no allowlist here and there is deliberately no
 * mode for one: gate content, worktree paths and the protocol tree are not public
 * reads, and a liveness probe that leaked "which workspaces exist" would be. The
 * pairing route is the only bootstrap, and it still requires a token.
 */
export const AGENT_ROUTES: readonly AgentRoute[] = [
  {
    id: 'pairing-redeem',
    method: 'POST',
    pathname: `${AGENT_ROUTE_PREFIX}/pairing/redeem`,
    probe: `${AGENT_ROUTE_PREFIX}/pairing/redeem`,
    authentication: 'pairing-token',
    rationale:
      'the bootstrap: a machine with no credential exchanges an out-of-band token for one. '
      + 'Single-use and minutes-long, because it is the one secret a human retypes.',
  },
  {
    id: 'human-session-issue',
    method: 'POST',
    pathname: `${AGENT_ROUTE_PREFIX}/human-sessions`,
    probe: `${AGENT_ROUTE_PREFIX}/human-sessions`,
    authentication: 'machine-credential-and-pairing-token',
    rationale:
      'Spec 146 Phase 11: the route by which a client becomes a paired session. '
      + 'Phase 6 built the session and phase 7 the table; neither wired a caller, so until '
      + 'this existed no client could ever hold one and criterion 9b was unreachable. '
      + 'Costs a fresh single-use token on top of the machine credential, which makes each '
      + 'session a distinct recorded act. It does NOT establish human presence: minting a '
      + 'token needs only write access to the pairing store, which every same-uid agent has.',
  },
  {
    id: 'gate-approve',
    method: 'POST',
    pattern: /^\/api\/agent\/v1\/workspaces\/([^/]+)\/gates\/approve$/,
    probe: `${AGENT_ROUTE_PREFIX}/workspaces/probe/gates/approve`,
    authentication: 'human-session',
    rationale:
      'Spec 146 Phase 11: spends a capability and a nonce by invoking porch. porch reads '
      + 'both from its environment, so only a server-side caller can present them — which '
      + 'is why the capability phase 6 issued had no way to be used until this route.',
  },
  {
    id: 'approval-submit',
    method: 'POST',
    pattern: /^\/api\/agent\/v1\/workspaces\/([^/]+)\/gates\/approvals$/,
    probe: `${AGENT_ROUTE_PREFIX}/workspaces/probe/gates/approvals`,
    authentication: 'human-session',
    rationale:
      'Spec 236: the ASYNCHRONOUS half of gate approval. `gate-approve` refuses any project '
      + 'whose phase declares checks, because an HTTP request will not hold a connection open '
      + 'for a repository\'s test suite — and a timeout is not the fix, since a client that '
      + 'gives up does not stop porch. This submits and returns an operation id. Same '
      + 'authentication as the synchronous route: it spends the same capability and nonce.',
  },
  {
    id: 'approval-operation',
    method: 'GET',
    pattern: /^\/api\/agent\/v1\/workspaces\/([^/]+)\/gates\/approvals\/([^/]+)$/,
    probe: `${AGENT_ROUTE_PREFIX}/workspaces/probe/gates/approvals/probe`,
    authentication: 'machine-credential',
    rationale:
      'reports one submitted approval. `machine-credential`, NOT `human-session`, and the '
      + 'difference is the whole of criterion 10: sessions live in memory, so the restart that '
      + 'resolves an approval to `interrupted` destroys the session that submitted it. Under '
      + '`human-session` the client was refused 401 at AUTHENTICATION — before the handler could '
      + 'look at anything — so the durable record whose only purpose is surviving that restart '
      + 'was unreadable by the client that needed it. A real restart test drives that path. '
      + 'The content is still not public: the handler requires the submitting session OR the '
      + 'unguessable receipt handed back at submit, presented from the machine that submitted it, '
      + 'and it refuses an operation belonging to another workspace.',
  },
  {
    id: 'session-probe',
    method: 'GET',
    pathname: `${AGENT_ROUTE_PREFIX}/session`,
    probe: `${AGENT_ROUTE_PREFIX}/session`,
    authentication: 'machine-credential',
    rationale:
      'reports whether a human session is live. Needs the machine credential but not the '
      + 'session itself, because its answer is what a client asks BEFORE it has one.',
  },
  {
    id: 'workspace-state',
    method: 'GET',
    pattern: /^\/api\/agent\/v1\/workspaces\/([^/]+)\/state$/,
    probe: `${AGENT_ROUTE_PREFIX}/workspaces/probe/state`,
    authentication: 'machine-credential',
    rationale: 'protocol state carries gate content and worktree paths; not a public read.',
  },
  {
    id: 'workspace-stream',
    method: 'GET',
    pattern: /^\/api\/agent\/v1\/workspaces\/([^/]+)\/stream$/,
    probe: `${AGENT_ROUTE_PREFIX}/workspaces/probe/stream`,
    authentication: 'machine-credential',
    rationale:
      'the same content as workspace-state, continuously. A stream left unauthenticated '
      + 'is the same leak with a longer lifetime.',
  },
  {
    id: 'approval-capability-issue',
    method: 'POST',
    pathname: `${AGENT_ROUTE_PREFIX}/approval-capabilities`,
    probe: `${AGENT_ROUTE_PREFIX}/approval-capabilities`,
    authentication: 'human-session',
    rationale: 'issuing an approval capability is the act a human gate exists to require.',
  },
  {
    id: 'approval-nonce-mint',
    method: 'POST',
    pathname: `${AGENT_ROUTE_PREFIX}/approval-nonces`,
    probe: `${AGENT_ROUTE_PREFIX}/approval-nonces`,
    authentication: 'human-session',
    rationale: 'a nonce is minted against the requesting session\'s own capability.',
  },
  {
    id: 'approval-capability-revoke-machine',
    method: 'DELETE',
    pattern: /^\/api\/agent\/v1\/approval-capabilities\/machine\/([^/]+)$/,
    probe: `${AGENT_ROUTE_PREFIX}/approval-capabilities/machine/probe`,
    authentication: 'human-session',
    rationale:
      'revocation is privileged HERE, over HTTP: an agent that could revoke could deny a human '
      + 'their gate. Spec 236 added `afx pair revoke`, which writes the store directly and needs '
      + 'no session — so this is not the only path, and the reason is recorded rather than left '
      + 'contradicting the command: over the API the operator who wanted to withdraw access was '
      + 'the one who could not, because human-session includes machine-credential. A same-uid '
      + 'agent could already write these stores, so the CLI makes that denial convenient rather '
      + 'than possible. See 146-approval-threat-model.md, "Who can revoke".',
  },
  {
    id: 'machine-credential-revoke',
    method: 'DELETE',
    pattern: /^\/api\/agent\/v1\/machines\/([^/]+)$/,
    probe: `${AGENT_ROUTE_PREFIX}/machines/probe`,
    authentication: 'human-session',
    rationale:
      'success criterion 15: revoking one machine fails that subtree closed and leaves the '
      + 'others working. Privileged for the same reason as approval revocation — and, like it, '
      + 'no longer the only path: `afx pair revoke` writes both stores directly, because an '
      + 'operator holding nothing must still be able to withdraw access. The trade is recorded '
      + 'in 146-approval-threat-model.md rather than left as two documents disagreeing.',
  },
];

/** Resolve a request to its route, or null when the table does not name it. */
export function matchAgentRoute(method: string | undefined, pathname: string): AgentRoute | null {
  for (const route of AGENT_ROUTES) {
    if (route.method !== (method ?? 'GET')) continue;
    if (route.pathname !== undefined && route.pathname === pathname) return route;
    if (route.pattern?.test(pathname)) return route;
  }
  return null;
}

/** Read one header as a string, or undefined. */
function header(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Origin rule for the HTTP surface.
 *
 * A request with NO `Origin` is not a browser request, and refusing it would
 * break every non-browser client while stopping no attack — the credential is the
 * control there. A request WITH a disallowed `Origin` is a page the operator
 * visited trying to drive this service, and that is exactly what to refuse. This
 * is why the check is "present and disallowed", not "not allowed".
 */
export function isAgentOriginAllowed(originHeader: string | undefined): boolean {
  if (originHeader === undefined || originHeader.length === 0) return true;
  return isAllowedOrigin(originHeader);
}

/**
 * Origin rule for the WebSocket upgrade.
 *
 * A WebSocket that ignores `Origin` is reachable from any page the browser
 * visits — `ws://` is not subject to the same-origin policy and sends no
 * preflight, so the browser will happily open it and attach whatever the page
 * asks. That is the specific hole that makes CSRF relevant to a localhost
 * service.
 *
 * Same shape as the HTTP rule, and for the same reason: the Node `ws` clients in
 * this repo send no `Origin`, and their control is the key checked separately.
 * This function only ever REFUSES; it can never admit an upgrade that the key
 * check would have rejected.
 */
export function isUpgradeOriginAllowed(req: http.IncomingMessage): boolean {
  return isAgentOriginAllowed(header(req, 'origin'));
}

export interface HumanSessionRecognizer {
  recognize(presentation: string | undefined): {
    readonly paired: boolean;
    readonly sessionId?: string;
    /** What the token that paired this session claimed. Recorded, not verified. */
    readonly authority?: string;
    readonly reason?: string;
  };
}

export interface AgentAuthContext {
  readonly machineCredentials: MachineCredentialStore;
  readonly humanSessions: HumanSessionRecognizer;
}

export type AgentAuthOutcome =
  | {
      readonly allowed: true;
      readonly route: AgentRoute;
      /** Present for every mode except pairing, which has no machine yet. */
      readonly machine?: string;
      readonly humanSessionId?: string;
      /**
       * What the token that paired that session claimed as its authority.
       *
       * Carried, never interpreted. This host cannot verify a human was present
       * — a same-uid process can mint its own pairing token — so an approval
       * records the claim it was made under.
       */
      readonly humanSessionAuthority?: string;
    }
  | {
      readonly allowed: false;
      readonly route: AgentRoute;
      readonly status: number;
      readonly signal: string;
      readonly message: string;
      readonly reason?: string;
    };

/**
 * Authenticate one request against its route's mode.
 *
 * Order is origin, then machine, then human session. Origin first because a
 * cross-origin page should be refused before it learns anything from a
 * credential check's answer; machine before session because the session is
 * elevation on top of the machine, not an alternative to it.
 */
export function authenticateAgentRequest(
  req: http.IncomingMessage,
  route: AgentRoute,
  context: AgentAuthContext,
): AgentAuthOutcome {
  if (!isAgentOriginAllowed(header(req, 'origin'))) {
    return {
      allowed: false,
      route,
      status: 403,
      signal: TRANSPORT_SIGNAL.ORIGIN_NOT_ALLOWED,
      message: 'the request Origin is not on this host\'s allowlist',
    };
  }

  // A MODE THAT NEEDS BOTH, AND WHAT IT DOES AND DOES NOT BUY.
  //
  // Session issuance does not rest on the machine credential alone: that
  // credential is a file, so a machine's credential leaking would otherwise also
  // mean unlimited sessions. Requiring a fresh single-use token as well binds
  // each session to one deliberate pairing act and makes sessions countable.
  //
  // IT DOES NOT ESTABLISH HUMAN PRESENCE, and an earlier version of this comment
  // claimed it did. Minting a token requires only write access to the pairing
  // store, which every agent on this host has, so a builder can mint one and
  // redeem it here. What the token buys is that the mint is a distinct, recorded
  // act carrying a stated `authority` — provenance, not proof.
  //
  // The machine credential is still required alongside it, so a revoked machine
  // cannot open a session even holding a live token.
  if (route.authentication === 'machine-credential-and-pairing-token') {
    const machine = context.machineCredentials.verify(header(req, MACHINE_CREDENTIAL_HEADER));
    if (!machine.authorized) {
      return {
        allowed: false,
        route,
        status: machine.code === MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED ? 403 : 401,
        signal: machine.code,
        message: machine.message,
      };
    }
    const token = header(req, PAIRING_TOKEN_HEADER);
    if (token === undefined || token.length === 0) {
      return {
        allowed: false,
        route,
        status: 401,
        signal: PAIRING_SIGNAL.PAIRING_TOKEN_REQUIRED,
        message: `no pairing token presented; send it in ${PAIRING_TOKEN_HEADER}`,
      };
    }
    // Spent in the handler, which knows what it is being spent on.
    return { allowed: true, route, machine: machine.machine };
  }

  if (route.authentication === 'pairing-token') {
    // Presence only. Redemption consumes the token exactly once and needs the
    // machine name from the body, so it belongs to the handler — authenticating
    // here would spend the token before anyone knows what it is being spent on.
    const token = header(req, PAIRING_TOKEN_HEADER);
    if (token === undefined || token.length === 0) {
      return {
        allowed: false,
        route,
        status: 401,
        signal: PAIRING_SIGNAL.PAIRING_TOKEN_REQUIRED,
        message: `no pairing token presented; send it in ${PAIRING_TOKEN_HEADER}`,
      };
    }
    return { allowed: true, route };
  }

  const machine = context.machineCredentials.verify(header(req, MACHINE_CREDENTIAL_HEADER));
  if (!machine.authorized) {
    return {
      allowed: false,
      route,
      // REVOKED is 403, not 401: "your access was withdrawn" is a different
      // instruction from "authenticate", and a client that retries a revoked
      // credential forever is a client that was told the wrong thing.
      status: machine.code === MACHINE_SIGNAL.MACHINE_CREDENTIAL_REVOKED ? 403 : 401,
      signal: machine.code,
      message: machine.message,
    };
  }

  if (route.authentication === 'machine-credential') {
    return { allowed: true, route, machine: machine.machine };
  }

  const recognition = context.humanSessions.recognize(header(req, HUMAN_SESSION_HEADER));
  if (!recognition.paired) {
    return {
      allowed: false,
      route,
      status: 401,
      signal: recognition.reason === 'REVOKED' ? 'HUMAN_SESSION_REVOKED' : 'HUMAN_SESSION_REQUIRED',
      message: 'this route requires a paired client session',
      reason: recognition.reason,
    };
  }
  return {
    allowed: true,
    route,
    machine: machine.machine,
    humanSessionId: recognition.sessionId,
    humanSessionAuthority: recognition.authority,
  };
}

/** Hosts that reach only this machine. `0.0.0.0` and any interface literal do not. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface BindDecision {
  readonly allowed: boolean;
  readonly code: TransportSignal;
  readonly message: string;
  readonly exposed: boolean;
}

/**
 * Decide whether Tower may bind where it has been told to.
 *
 * WHAT THIS ENFORCES, precisely: not that the transport is encrypted — a process
 * cannot see the proxy in front of it, and claiming otherwise would be exactly the
 * unfounded-guarantee this phase was told to avoid. What it enforces is that
 * exposing an interface without TLS in front is IMPOSSIBLE TO DO SILENTLY. An
 * operator who exposes Tower must declare that a TLS terminator fronts it; an
 * operator who sets `BRIDGE_MODE=1` and thinks no further gets a startup failure
 * naming the variable, not a warning in a log they will not read.
 *
 * This is a deliberate behaviour change from the previous warn-and-continue,
 * recorded in the plan's phase 7 deliverables and in the remote-access runbook.
 *
 * WHAT IT STILL DOES NOT DO, because a reviewer read the deliverable strictly and
 * was right to: a declared bind is still a plain-HTTP listener on that interface,
 * so a peer that can route to it reaches it directly and the terminator is not in
 * the path. No in-process check can change that — only not binding there can. The
 * runbook's primary recipe is therefore a LOOPBACK bind with the terminator on
 * the same host (`tailscale serve --https=443 http://127.0.0.1:4100`), which is
 * the configuration that actually satisfies "all remote transport is HTTPS/WSS".
 * This escape hatch is for a terminator on a different host, and the allowed
 * decision's message says the residual out loud rather than reading as approval.
 */
export function decideBindPolicy(input: {
  readonly host: string;
  readonly tlsDeclaration?: string;
}): BindDecision {
  const host = input.host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) {
    return {
      allowed: true,
      exposed: false,
      code: TRANSPORT_SIGNAL.BIND_LOOPBACK_ONLY,
      message: `bound to ${input.host}; reachable only from this machine`,
    };
  }
  if (input.tlsDeclaration?.trim() === 'terminated') {
    return {
      allowed: true,
      exposed: true,
      code: TRANSPORT_SIGNAL.BIND_EXPOSED_TLS_DECLARED,
      message:
        `bound to ${input.host} with CODEV_BRIDGE_TLS=terminated. This host cannot verify that `
        + 'claim — it is the operator\'s declaration that a TLS terminator fronts this bind. '
        + 'THE RESIDUAL, stated because a declaration is not a control: this listener still '
        + `speaks plain HTTP, so anything that can route to ${input.host}:<port> reaches it `
        + 'directly, bypassing the terminator. The configuration that actually makes all '
        + 'remote transport HTTPS/WSS is a LOOPBACK bind with the terminator on this host; '
        + 'this path exists only for a terminator that cannot reach 127.0.0.1.',
    };
  }
  return {
    allowed: false,
    exposed: true,
    code: TRANSPORT_SIGNAL.INSECURE_NON_LOOPBACK_BIND_REFUSED,
    message:
      `refusing to bind to ${input.host} in cleartext. Reaching this service is equivalent to `
      + 'shell access in every worktree it serves, so a plaintext non-loopback bind is refused '
      + 'rather than warned about. Put a TLS terminator in front (tailscale serve --https=443, '
      + 'or a reverse proxy) and set CODEV_BRIDGE_TLS=terminated to declare it. See '
      + 'codev/resources/146-remote-access-runbook.md.',
  };
}
