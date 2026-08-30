import { machineHeaders, type MachineConfig } from '../connection/machine.js';

/**
 * The approval path, as a client walks it.
 *
 * Four requests, because four different things are established: that this
 * machine is paired, that a session was opened by a deliberate single-use mint,
 * that this session holds a capability, and that this particular gate is the one
 * being approved. Porch writes `status.yaml`; nothing here does.
 *
 * NONE OF THEM ESTABLISHES THAT A HUMAN IS PRESENT. Minting a pairing token
 * needs only write access to the pairing store, and every agent on this host
 * runs as the same user. See `codev/resources/146-approval-threat-model.md`;
 * what the chain carries instead is a stated `authority`, recorded and never
 * verified.
 */

export const HUMAN_SESSION_HEADER = 'x-codev-human-session';
export const PAIRING_TOKEN_HEADER = 'x-codev-pairing-token';
/** The approval receipt. A header, not a query parameter: URLs are logged. */
export const APPROVAL_RECEIPT_HEADER = 'x-codev-approval-receipt';

export interface HumanSession {
  readonly sessionId: string;
  /** Presented in `x-codev-human-session`. Never stored anywhere durable. */
  readonly presentation: string;
  readonly expiresAt: string;
}

export type ApprovalOutcome =
  | {
    readonly ok: true;
    readonly approvedAt: string;
    readonly machine: string;
    readonly sessionId: string | null;
    /**
     * True when the gate was ALREADY approved before this request.
     *
     * A definite, readable answer — not this session's approval. The fields
     * below describe whoever actually approved it, which may be someone else on
     * another machine, so the caller must not present it as "you approved this".
     */
    readonly alreadyApproved?: boolean;
    /** What the pairing token behind the approving capability claimed. */
    readonly authority?: string;
    /**
     * How far the approval travelled, when it did not travel all the way.
     *
     * A success with a caveat, never a failure: telling a human their approval
     * did not happen when it did sends them to approve again, chasing a state
     * that already changed. The three stages need different remedies —
     * `written-not-committed` wants the commit investigated,
     * `committed-not-pushed` wants a push, `unknown` wants a look at what the
     * server said — and none of them means the gate is unapproved.
     */
    readonly delivery?: 'written-not-committed' | 'committed-not-pushed' | 'unknown';
    readonly deliveryMessage?: string;
  }
  | {
    readonly ok: false;
    readonly signal: string;
    readonly message: string;
    /**
     * The server answered, and this client could not tell what happened.
     *
     * NOT the same as a refusal. An unreadable 200 may well mean the gate WAS
     * approved, so telling a human it failed would send them to approve again —
     * the same defect as reporting a push failure as a refusal, at the same
     * point in the product. The caller must render this as "check", never as
     * "no".
     */
    readonly unconfirmed?: boolean;
    /**
     * True when the session this was attempted with is gone — expired, idled
     * out, or revoked. The caller drops it, so the panel offers a pairing token
     * again instead of a dead Approve button the human can only escape by
     * reloading the page.
     */
    readonly sessionEnded?: boolean;
  };

interface Json {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function send(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Json> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    body: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>,
  };
}

function text(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** Signals that mean "this session is over", as distinct from "this was refused". */
const SESSION_ENDED = new Set([
  'HUMAN_SESSION_REQUIRED',
  'HUMAN_SESSION_REVOKED',
  'APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION',
]);

function refusal(result: Json, fallback: string): {
  ok: false;
  signal: string;
  message: string;
  sessionEnded: boolean;
} {
  const signal = text(result.body, 'signal') ?? `HTTP_${result.status}`;
  return {
    ok: false,
    signal,
    message: text(result.body, 'message') ?? fallback,
    // A 401 on any step of this path means the session went away mid-ceremony;
    // sessions idle out after 30 minutes, so this is ordinary, not exceptional.
    sessionEnded: SESSION_ENDED.has(signal) || result.status === 401,
  };
}

function api(config: MachineConfig, path: string): string {
  return `${config.origin}/api/agent/v1${path}`;
}

/**
 * Exchange a pairing token for a paired client session.
 *
 * The token makes each session a distinct, single-use, recorded act, and binds
 * it to one ceremony. It does NOT make "a human is present" a fact: minting one
 * needs only write access to the pairing store, which every agent on this host
 * has. The machine credential is required alongside it so a revoked machine
 * cannot open a session — that part is a real control.
 */
export async function openHumanSession(
  fetchImpl: typeof globalThis.fetch,
  config: MachineConfig,
  pairingToken: string,
): Promise<{ ok: true; session: HumanSession } | { ok: false; signal: string; message: string }> {
  const result = await send(fetchImpl, api(config, '/human-sessions'), {
    ...machineHeaders(config),
    [PAIRING_TOKEN_HEADER]: pairingToken,
  }, {});
  const presentation = text(result.body, 'presentation');
  const sessionId = text(result.body, 'sessionId');
  if (result.status !== 201 || !presentation || !sessionId) {
    return refusal(result, 'the server did not issue a human session');
  }
  return {
    ok: true,
    session: { sessionId, presentation, expiresAt: text(result.body, 'expiresAt') ?? '' },
  };
}

/**
 * Issue a capability, mint a nonce for one gate, and spend both.
 *
 * The three are one act from the human's point of view and are kept together for
 * that reason. A capability outlives one approval, but re-issuing per approval
 * is cheap and keeps nothing long-lived in the page.
 */
export async function approveGate(
  fetchImpl: typeof globalThis.fetch,
  config: MachineConfig,
  session: HumanSession,
  gate: { readonly projectId: string; readonly gateName: string },
  /**
   * Called with what the server says while the work runs.
   *
   * OPTIONAL BUT NOT DECORATIVE. Phase checks take minutes, and a button that
   * says "Approving…" for four minutes with nothing behind it is indistinguishable
   * from one that is stuck. What is reported is the server's own phase and check
   * names, never a guess made here.
   */
  onProgress?: (progress: ApprovalProgress) => void,
): Promise<ApprovalOutcome> {
  const authed = { ...machineHeaders(config), [HUMAN_SESSION_HEADER]: session.presentation };

  const issued = await send(fetchImpl, api(config, '/approval-capabilities'), authed, {
    principalKind: 'human-client',
  });
  const capability = text(issued.body, 'presentation');
  const capabilityId = text(issued.body, 'capabilityId');
  if (issued.status !== 201 || !capability || !capabilityId) {
    return refusal(issued, 'the server did not issue an approval capability');
  }

  const minted = await send(fetchImpl, api(config, '/approval-nonces'), authed, {
    projectId: gate.projectId,
    gateName: gate.gateName,
    capabilityId,
  });
  const nonce = text(minted.body, 'nonce');
  if (minted.status !== 201 || !nonce) {
    return refusal(minted, 'the server did not mint an approval nonce');
  }

  const workspace = encodeURIComponent(encodeWorkspace(config.workspacePath));

  /*
   * THE ASYNCHRONOUS ROUTE FIRST, because it is the only one that works on an
   * ordinary project.
   *
   * The synchronous route refuses any project whose phase declares checks — an
   * HTTP request will not hold a connection open for a repository's test suite —
   * so before this existed a human reaching a gate in this client was sent to the
   * CLI. The submit returns at once and the work is polled.
   *
   * A HOST THAT DOES NOT OFFER IT ANSWERS 501, and then the synchronous route is
   * used. Falling back is right rather than merely kind: the older path still
   * approves everything it ever could, so a host that has not been upgraded loses
   * nothing it had. Nothing in this repository wires such a host any more — the
   * agent-host tool gained an operation store in the same change — so this is for
   * a host running an older build, which is exactly when a client must not assume.
   */
  /*
   * A SUBMIT THAT NEVER COMPLETED IS NOT A REFUSAL EITHER.
   *
   * The poll learned this rule; the submit had not. A thrown `fetch` here
   * reached the panel's own catch, which carries no `unconfirmed`, so a request
   * that may well have reached the server and started an approval rendered as
   * "not approved" — the same defect as the poll's, one call earlier.
   *
   * There is no way to know from here whether the server received it, and that
   * is precisely what `unconfirmed` is for.
   */
  let submitted: Json;
  try {
    submitted = await send(fetchImpl, api(config, `/workspaces/${workspace}/gates/approvals`), authed, {
      projectId: gate.projectId,
      gateName: gate.gateName,
      capability,
      nonce,
    });
  } catch (error) {
    return {
      ok: false,
      unconfirmed: true,
      signal: 'GATE_APPROVAL_UNCONFIRMED',
      message:
        `the request to approve ${gate.gateName} did not complete (${(error as Error).message}), so `
        + 'whether this host received it is unknown. It may already be running — check before '
        + 'approving again.',
    };
  }
  if (submitted.status !== 501) {
    return await pollApproval(fetchImpl, config, authed, workspace, submitted, gate, onProgress);
  }

  const approved = await send(fetchImpl, api(config, `/workspaces/${workspace}/gates/approve`), authed, {
    projectId: gate.projectId,
    gateName: gate.gateName,
    capability,
    nonce,
  });
  if (approved.status !== 200) {
    return refusal(approved, 'the gate was not approved');
  }

  /*
   * EVERY PIECE OF EVIDENCE COMES FROM THE SERVER OR THE ANSWER IS NOT A YES.
   *
   * This used to treat any 200 as confirmation and fill the gaps from local
   * state: the timestamp from this browser's clock, the machine from the
   * configured label, the session from the one already in hand. So an empty
   * body — or a proxy's own 200 — rendered as "approved on alpha at <now>,
   * session s1", every word of it manufactured here. That is the client telling
   * a human their approval landed at the one moment it has no business
   * guessing, and it is the honest-degradation principle broken at the most
   * consequential point in the product.
   *
   * An unreadable success is reported as UNCONFIRMED rather than as a failure,
   * because the gate may well be approved. "I could not tell" is not "no", and
   * this is precisely where confusing them costs a duplicate approval.
   */
  const signal = text(approved.body, 'signal');
  const approvedAt = text(approved.body, 'approvedAt');
  const machine = text(approved.body, 'machine');
  // NULLABLE ON PURPOSE. An approval recorded before session ids existed is a
  // real approval with an unknown approver, and reporting "unknown" is right
  // where inventing this session's id would be a lie.
  const sessionId = text(approved.body, 'sessionId') ?? null;
  const alreadyApproved = signal === 'GATE_ALREADY_APPROVED';
  if ((signal !== 'GATE_APPROVED' && !alreadyApproved) || !approvedAt || !machine) {
    return {
      ok: false,
      unconfirmed: true,
      signal: 'GATE_APPROVAL_UNCONFIRMED',
      message:
        'the server answered 200 but not with a result this client can read, so whether the '
        + 'gate was approved is unknown. Check status.yaml before approving again.',
    };
  }

  const rawDelivery = text(approved.body, 'delivery');
  const delivery = rawDelivery === 'written-not-committed'
    || rawDelivery === 'committed-not-pushed'
    || rawDelivery === 'unknown'
    ? rawDelivery
    : undefined;
  const deliveryMessage = text(approved.body, 'deliveryMessage');
  const authority = text(approved.body, 'authority');
  return {
    ok: true,
    approvedAt,
    machine,
    sessionId,
    ...(alreadyApproved ? { alreadyApproved: true } : {}),
    ...(authority ? { authority } : {}),
    ...(delivery ? { delivery, ...(deliveryMessage ? { deliveryMessage } : {}) } : {}),
  };
}

/** What the server says while an approval runs. Never invented by this client. */
export interface ApprovalProgress {
  readonly state: 'submitted' | 'running';
  readonly operationId: string;
  /** The phase the server says it is running in, when it has said. */
  readonly phase?: string;
  /** The check names the server says it will run. */
  readonly checks?: readonly string[];
}

/** How long between polls, and how long before this client stops waiting. */
const POLL_INTERVAL_MS = 1_000;
const POLL_LIMIT_MS = 30 * 60_000;

const TERMINAL_STATES = new Set(['succeeded', 'refused', 'failed', 'interrupted']);

/**
 * Follow one submitted approval to its end.
 *
 * ## Why giving up is reported as UNCONFIRMED, never as a refusal
 *
 * This client stopping does not stop porch. If it gives up waiting, the approval
 * is still running and may well succeed — so reporting "not approved" would be
 * the very failure the asynchronous path exists to prevent, reintroduced in the
 * client. The bound exists so a tab does not poll forever; what it produces is
 * "I could not tell", with the operation id to look up.
 */
async function pollApproval(
  fetchImpl: typeof globalThis.fetch,
  config: MachineConfig,
  authed: Record<string, string>,
  workspace: string,
  submitted: Json,
  gate: { readonly projectId: string; readonly gateName: string },
  onProgress?: (progress: ApprovalProgress) => void,
): Promise<ApprovalOutcome> {
  /*
   * A 5xx ON THE SUBMIT MAY HAVE CREATED THE OPERATION.
   *
   * `handleApprovalSubmit` writes the record BEFORE it writes the 202, so a
   * server error after that point leaves an approval running and answers with a
   * failure. Reporting a refusal there is the same wrong verdict as the thrown
   * `fetch` beside it — which was fixed last round while this sibling was not.
   *
   * A 4xx is a definite answer about the request itself (malformed, unknown
   * workspace, wrong session, already in flight) and stays a refusal.
   */
  if (submitted.status >= 500) {
    return {
      ok: false,
      unconfirmed: true,
      signal: 'GATE_APPROVAL_UNCONFIRMED',
      message:
        `this host answered ${submitted.status} to the request to approve ${gate.gateName}. The `
        + 'operation is recorded before the response is written, so it may be running — check '
        + 'before approving again.',
    };
  }
  if (submitted.status === 409) {
    /*
     * A CONFLICT IS NOT A REFUSAL OF THIS GATE, AND THIS USED TO SAY IT WAS.
     *
     * The already-in-flight code means an approval for this project is RUNNING.
     * It may
     * be about to succeed. Rendering it as a refusal — the same red the panel
     * gives a genuinely refused approval — told the operator their gate was
     * refused about one that was still deciding, on the single action this
     * client exists to perform.
     *
     * The submitter's own retry no longer reaches here at all: the host answers
     * 202 and resumes it. What is left is a conflict raised against SOMEONE
     * ELSE's run, which this client cannot poll and must not claim to know the
     * outcome of. That is `unconfirmed` — the band already built for exactly
     * this, and the message names the operation so the human can look.
     */
    const running = text(submitted.body, 'operationId');
    return {
      ok: false,
      unconfirmed: true,
      signal: 'APPROVAL_ALREADY_IN_FLIGHT',
      message:
        `an approval for this project is already running${running ? ` as operation ${running}` : ''}`
        + ', started by another session. This gate may be approved by that run, so nothing here '
        + 'says it was not — wait for it, and check the gate before submitting again.',
    };
  }
  const operationId = text(submitted.body, 'operationId');
  if (submitted.status !== 202 || !operationId) {
    return refusal(submitted, 'the server did not accept the approval');
  }

  /*
   * THE RECEIPT IS CARRIED ON EVERY POLL, and it is what makes an interrupted
   * approval readable at all.
   *
   * Human sessions live in the host's memory, so the restart that resolves an
   * operation to `interrupted` destroys the session that submitted it. A poll
   * authorised on session identity alone would 403 forever on exactly the record
   * that state exists to deliver. The receipt, presented from the same machine,
   * is the second way in — so this client keeps polling across a host restart
   * instead of losing the answer it was waiting for.
   */
  const receipt = text(submitted.body, 'receipt');
  /*
   * IN A HEADER, NEVER IN THE URL. It is a bearer secret, and a URL is copied by
   * things that were not asked: Tower logs `req.url` during the boot window and
   * on every authentication failure — which is precisely when a client polling
   * across a restart arrives — and reverse proxies log query strings as a matter
   * of course. `agent-auth.ts` had already written this rule down for the pairing
   * token; the first draft of this line crossed it.
   */
  const polling = receipt ? { ...authed, [APPROVAL_RECEIPT_HEADER]: receipt } : authed;
  const url = api(config, `/workspaces/${workspace}/gates/approvals/${encodeURIComponent(operationId)}`);
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    /*
     * A POLL THAT CANNOT READ THE STATE SAYS NOTHING ABOUT THE APPROVAL.
     *
     * This mapped every non-200 — and a thrown `fetch` — onto a plain refusal,
     * which the panel renders identically to `state: 'failed'`. So a 503, which
     * is the server's own "the operation store could not be read", told a human
     * their gate was NOT approved. The server took care to distinguish unreadable
     * from unknown and the client collapsed the two back together.
     *
     * The timeout below already knows the rule — this client stopping does not
     * stop porch — and a transport failure is the same case arriving sooner. So
     * these are retried until the deadline and then reported as unconfirmed,
     * never as a refusal.
     */
    let polled: Json;
    try {
      const response = await fetchImpl(url, { headers: polling });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = {};
      }
      polled = {
        status: response.status,
        body: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>,
      };
    } catch {
      // The request never completed. Nothing has been learned about the gate.
      await new Promise((wait) => setTimeout(wait, POLL_INTERVAL_MS));
      continue;
    }

    /*
     * TWO DEFINITE ANSWERS, and only two. 403 says this session may not read this
     * operation; 401 says the session is gone — expired, idled out or revoked.
     * Neither changes by retrying, and the 401 matters more than it looks: the
     * synchronous path already treats it as `sessionEnded`, so retrying it here
     * for thirty minutes and then reporting a bare `unconfirmed` left the dead
     * session in place and the human with an Approve button they could only
     * escape by reloading. The two paths must agree about what a 401 means.
     *
     * Every other failure is "I could not read it", which is not a verdict on
     * the gate.
     */
    if (polled.status === 403 || polled.status === 401) {
      return refusal(polled, 'this session can no longer read that approval');
    }
    /*
     * 404 IS DEFINITE TOO, and re-asking cannot change it: this host does not
     * know the operation it accepted a moment ago. Spinning to the deadline over
     * that left the progress line on screen for thirty minutes for an answer
     * already given.
     *
     * Reported as UNCONFIRMED rather than refused, because the two facts are
     * both true and neither is a verdict on the gate: it WAS accepted, and the
     * host no longer knows it.
     */
    if (polled.status === 404) {
      return {
        ok: false,
        unconfirmed: true,
        signal: 'GATE_APPROVAL_UNCONFIRMED',
        message:
          `this host accepted approval ${operationId} and now does not know it. Whether the gate `
          + 'was approved is unknown; check before approving again.',
      };
    }
    if (polled.status !== 200) {
      await new Promise((wait) => setTimeout(wait, POLL_INTERVAL_MS));
      continue;
    }

    const state = text(polled.body, 'state');
    if (state && TERMINAL_STATES.has(state)) return terminalOutcome(polled, state, gate);
    if (state === 'submitted' || state === 'running') {
      onProgress?.({
        state,
        operationId,
        ...(text(polled.body, 'phase') ? { phase: text(polled.body, 'phase') } : {}),
        ...(Array.isArray(polled.body.checks)
          ? { checks: (polled.body.checks as unknown[]).filter((c): c is string => typeof c === 'string') }
          : {}),
      });
    } else {
      // A state this build does not know is not a reason to claim an outcome.
      return {
        ok: false,
        unconfirmed: true,
        signal: 'GATE_APPROVAL_UNCONFIRMED',
        message:
          `the server reported approval state "${String(state)}", which this client does not `
          + `recognise. Look up operation ${operationId} before approving again.`,
      };
    }
    await new Promise((wait) => setTimeout(wait, POLL_INTERVAL_MS));
  }

  return {
    ok: false,
    unconfirmed: true,
    signal: 'GATE_APPROVAL_UNCONFIRMED',
    message:
      `this client stopped waiting after ${Math.round(POLL_LIMIT_MS / 60_000)} minutes, but that `
      + `does not stop the approval — operation ${operationId} may still be running or may have `
      + 'succeeded. Look it up before approving again.',
  };
}

/** Turn a settled operation into the outcome a human reads. */
function terminalOutcome(
  polled: Json,
  state: string,
  gate: { readonly projectId: string; readonly gateName: string },
): ApprovalOutcome {
  if (state === 'refused') {
    return {
      ok: false,
      signal: text(polled.body, 'code') ?? 'GATE_APPROVAL_REFUSED',
      message: text(polled.body, 'message') ?? `${gate.gateName} was not approved`,
      sessionEnded: false,
    };
  }
  if (state === 'failed') {
    return {
      ok: false,
      signal: 'GATE_APPROVAL_FAILED',
      message: text(polled.body, 'message') ?? 'the approval failed and the server gave no reason',
      sessionEnded: false,
    };
  }
  if (state === 'interrupted') {
    /*
     * NOT A FAILURE. The host stopped while the work ran, and the gate may well
     * be approved — the server has read `status.yaml` and its message says which
     * it found. Reporting this as "not approved" would send a human to approve
     * something already approved, which is the whole reason this state exists.
     */
    return {
      ok: false,
      unconfirmed: true,
      signal: 'APPROVAL_OPERATION_INTERRUPTED',
      message: text(polled.body, 'message')
        ?? 'the host stopped while this approval was running; check status.yaml before retrying',
    };
  }

  const record = polled.body.record;
  const fields = (record && typeof record === 'object' ? record : {}) as Record<string, unknown>;
  const approvedAt = typeof fields.approvedAt === 'string' ? fields.approvedAt : undefined;
  const machine = typeof fields.machine === 'string' ? fields.machine : undefined;
  if (!approvedAt || !machine) {
    // The same rule as the synchronous path: a success this client cannot read
    // is UNCONFIRMED, never a refusal, because the gate may be approved.
    return {
      ok: false,
      unconfirmed: true,
      signal: 'GATE_APPROVAL_UNCONFIRMED',
      message:
        'the server reported the approval succeeded but not with a result this client can read, '
        + 'so whether the gate was approved is unknown. Check status.yaml before approving again.',
    };
  }

  const rawDelivery = typeof fields.delivery === 'string' ? fields.delivery : undefined;
  const delivery = rawDelivery === 'written-not-committed'
    || rawDelivery === 'committed-not-pushed'
    || rawDelivery === 'unknown'
    ? rawDelivery
    : undefined;
  return {
    ok: true,
    approvedAt,
    machine,
    sessionId: typeof fields.sessionId === 'string' ? fields.sessionId : null,
    ...(fields.outcome === 'already-approved' ? { alreadyApproved: true } : {}),
    ...(typeof fields.authority === 'string' ? { authority: fields.authority } : {}),
    ...(delivery
      ? {
        delivery,
        ...(typeof fields.deliveryMessage === 'string'
          ? { deliveryMessage: fields.deliveryMessage }
          : {}),
      }
      : {}),
  };
}

function encodeWorkspace(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
