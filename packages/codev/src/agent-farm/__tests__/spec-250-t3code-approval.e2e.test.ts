/**
 * Spec 250, phase 10 — a gate approved FROM t3code, through the fork's own proxy.
 *
 * ## Why this drives two real servers and calls nothing directly
 *
 * `agent-approval-path.test.ts` proved the ceremony is reachable over HTTP from a
 * client holding nothing. This one adds the hop that phase 10 built: the fork's
 * server, running its real `apps/server` build, forwarding to `codev-agent` on a
 * path the browser never names an origin for.
 *
 * Every request here is one a page could make. The proxy is not imported, its
 * functions are not called, and its route table is not consulted — the test
 * reaches it the only way a browser can, so a route that is registered nowhere
 * fails it. That is the standing rule about asserting the CALL SITE: the phase's
 * unit tests can prove `forwardableHeaders` strips a header, and only this can
 * prove anything is wired to `forwardableHeaders`.
 *
 * ## What each half is
 *
 *   codev-agent   an in-process `agent-routes` host on a random port, with a real
 *                 workspace holding a real project at a pending gate. porch is the
 *                 only writer of `status.yaml`; nothing here writes it.
 *   t3code        the FORK's server, started by the harness on its own
 *                 interpreter, configured with an allowlist naming that port.
 *
 * ## Skips, never passes
 *
 * A missing fork checkout, a missing interpreter, a server that would not start —
 * each is "this run could not tell you anything". Reported as a skip with the
 * reason, because a green tick over an un-run ceremony is the worst answer
 * available.
 */

import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import {
  HUMAN_SESSION_HEADER,
  MACHINE_CREDENTIAL_HEADER,
  PAIRING_TOKEN_HEADER,
} from '../servers/agent-auth.js';
import {
  AGENT_MACHINE,
  MACHINE_MINT,
  SESSION_MINT,
  startAgentHost,
  type AgentHost,
} from '../../__tests__/e2e/spec-250-agent-host.js';
import { startForkServer, stopForkStack } from '../../__tests__/e2e/spec-250-fork-stack.js';

/** The env var the fork's server reads its codev-agent allowlist from. */
const ORIGINS_ENV = 'T3CODE_CODEV_AGENT_ORIGINS';
/** The proxy prefix, as the browser spells it. Same-origin: a path, never a URL. */
const PROXY_PREFIX = '/api/codev/agent';
const TARGET_ID = 'local';

const BUILDER_ID = 'spir-250';
const PROJECT_ID = '250';
const GATE_NAME = 'pr';

let agent: AgentHost | null = null;
let forkBase: string | null = null;
let accessToken: string | null = null;
let unavailable: string | null = null;
let previousOrigins: string | undefined;

beforeAll(async () => {
  agent = await startAgentHost({
    builders: [{ id: BUILDER_ID, threadId: 'thread-1', projectId: PROJECT_ID, gateName: GATE_NAME }],
  });
  // Configured BEFORE the fork server starts, and through its real environment:
  // the harness spawns it with `process.env`, which is the operator's own path
  // to this setting rather than a back door only a test can use.
  previousOrigins = process.env[ORIGINS_ENV];
  process.env[ORIGINS_ENV] = `${TARGET_ID}=${agent.origin}`;
  const started = await startForkServer();
  if (!started.available) {
    unavailable = started.reason;
    return;
  }
  forkBase = started.serverBase;
  accessToken = started.accessToken;
}, 180_000);

afterAll(() => {
  stopForkStack();
  agent?.stop();
  if (previousOrigins === undefined) delete process.env[ORIGINS_ENV];
  else process.env[ORIGINS_ENV] = previousOrigins;
});

/** A request the PAGE could make: a path on t3code's origin, plus its session. */
function proxied(path: string): string {
  return `${forkBase}${PROXY_PREFIX}/${TARGET_ID}${path}`;
}

function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...extra,
  };
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: browserHeaders(headers),
    body: JSON.stringify(body ?? {}),
    redirect: 'manual',
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/**
 * A RUN THAT COULD NOT HAPPEN MUST NOT REPORT GREEN.
 *
 * Review finding, and it is this file's own header turned against it. The first
 * version logged a warning and RETURNED, which vitest records as a **pass** — so
 * criterion 4 and the SSRF refusals reported success on a run where the fork
 * server never started and not one assertion executed. That is "I could not tell"
 * spelled as "yes", on the phase's own acceptance criterion, which is worse than
 * the failure it was trying to avoid.
 *
 * `ctx.skip` marks the test skipped and does not return, so the body below is
 * unreachable rather than merely unexecuted. The Playwright spec beside it
 * already did this with `test.skip`; the two now agree.
 */
function skipIfUnavailable(ctx: TestContext): void {
  if (unavailable === null) return;
  ctx.skip(`spec-250 t3code approval: ${unavailable}`);
}

function statusYaml(): any {
  return yaml.load(readFileSync(agent!.statusPathFor(BUILDER_ID), 'utf8'));
}

describe('spec 250 phase 10: approving a gate from t3code', () => {
  /**
   * CRITERION 4, end to end, over the proxy.
   *
   * Every step is a request to t3code's origin. The page never names
   * `codev-agent`; it names a configured id, and the server holds the origin.
   */
  it('walks the ceremony through the proxy and porch records who approved', async (ctx) => {
    skipIfUnavailable(ctx);

    // 1. PAIR. The one agent route reachable with no machine credential — and it
    //    still needs a token, so t3code's session bought entry to the proxy and
    //    nothing more.
    const machineToken = agent!.pairings.issue(MACHINE_MINT).token;
    const paired = await post(
      proxied('/api/agent/v1/pairing/redeem'),
      { [PAIRING_TOKEN_HEADER]: machineToken },
      { machine: 'ipad' },
    );
    expect(paired.status).toBe(201);
    const credential: string = paired.body.credential;
    expect(typeof credential).toBe('string');

    // 2. A MACHINE CREDENTIAL IS NOT A HUMAN SESSION. Refused, and refused
    //    differently from a caller with no credential at all — asserted below.
    const beforeSession = await fetch(proxied('/api/agent/v1/session'), {
      headers: browserHeaders({ [MACHINE_CREDENTIAL_HEADER]: credential }),
    });
    expect(beforeSession.status).toBe(401);

    // 3. OPEN A SESSION. A second, distinct single-use token.
    const sessionToken = agent!.pairings.issue(SESSION_MINT).token;
    const session = await post(
      proxied('/api/agent/v1/human-sessions'),
      { [MACHINE_CREDENTIAL_HEADER]: credential, [PAIRING_TOKEN_HEADER]: sessionToken },
      {},
    );
    expect(session.status).toBe(201);
    const presentation: string = session.body.presentation;

    const authed = {
      [MACHINE_CREDENTIAL_HEADER]: credential,
      [HUMAN_SESSION_HEADER]: presentation,
    };

    // 4. CAPABILITY, issued for the HOST that will verify it.
    const capability = await post(proxied('/api/agent/v1/approval-capabilities'), authed, {
      principalKind: 'human-client',
    });
    expect(capability.status).toBe(201);
    expect(capability.body.machine).toBe(AGENT_MACHINE);

    // 5. NONCE, bound to this one gate.
    const nonce = await post(proxied('/api/agent/v1/approval-nonces'), authed, {
      projectId: PROJECT_ID,
      gateName: GATE_NAME,
      capabilityId: capability.body.capabilityId,
    });
    expect(nonce.status).toBe(201);

    // 6. APPROVE. porch is the only writer.
    const approved = await post(
      proxied(`/api/agent/v1/workspaces/${agent!.encodedWorkspace}/gates/approve`),
      authed,
      {
        projectId: PROJECT_ID,
        gateName: GATE_NAME,
        capability: capability.body.presentation,
        nonce: nonce.body.nonce,
      },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.signal).toBe('GATE_APPROVED');

    // 7. THE THREE FIELDS CRITERION 4 NAMES, in the real status.yaml, written by
    //    porch. The response body carried them too — and the client reads them
    //    from there rather than from its own clock, which is what the unit test
    //    named "server-sourced" holds.
    const state = statusYaml();
    expect(state.gates[GATE_NAME].status).toBe('approved');
    expect(state.gates[GATE_NAME].approval.session_id).toBe(session.body.sessionId);
    expect(state.gates[GATE_NAME].approval.machine).toBe(AGENT_MACHINE);
    expect(typeof state.gates[GATE_NAME].approved_at).toBe('string');
    expect(Number.isNaN(Date.parse(state.gates[GATE_NAME].approval.approved_at))).toBe(false);
    // And the SERVER said the same three things, so a page that reports them is
    // reporting the record rather than reconstructing it.
    expect(typeof approved.body.approvedAt).toBe('string');
    expect(approved.body.machine).toBe(AGENT_MACHINE);
    expect(approved.body.sessionId).toBe(session.body.sessionId);
  }, 180_000);

  /**
   * THE TWO REFUSALS ARE NOT SPELLED THE SAME WAY.
   *
   * A caller with no machine credential and one with a credential but no human
   * session need different next actions — pair, versus open a session — and a
   * single refusal for both leaves a human with nowhere to go.
   */
  it('refuses a missing machine credential and a missing human session differently', async (ctx) => {
    skipIfUnavailable(ctx);

    const noCredential = await fetch(proxied('/api/agent/v1/session'), {
      headers: browserHeaders(),
    });
    expect(noCredential.status).toBe(401);
    const noCredentialBody = (await noCredential.json()) as { signal: string };
    expect(noCredentialBody.signal).toBe('MACHINE_CREDENTIAL_REQUIRED');

    const machineToken = agent!.pairings.issue(MACHINE_MINT).token;
    const paired = await post(
      proxied('/api/agent/v1/pairing/redeem'),
      { [PAIRING_TOKEN_HEADER]: machineToken },
      { machine: 'laptop' },
    );
    const noSession = await post(
      proxied('/api/agent/v1/approval-capabilities'),
      { [MACHINE_CREDENTIAL_HEADER]: paired.body.credential },
      { principalKind: 'human-client' },
    );
    expect(noSession.status).toBe(401);
    expect(noSession.body.signal).toBe('HUMAN_SESSION_REQUIRED');
    expect(noSession.body.signal).not.toBe(noCredentialBody.signal);
  }, 120_000);

  /**
   * `afx pair revoke <machine>` stops THAT browser and nothing else.
   *
   * Revoked mid-life, over the proxy, and a second machine paired afterwards
   * still reads — so this is a per-machine withdrawal rather than a lockout.
   */
  it('stops a revoked machine and leaves every other one working', async (ctx) => {
    skipIfUnavailable(ctx);

    const statePath = proxied(`/api/agent/v1/workspaces/${agent!.encodedWorkspace}/state`);

    const revokedToken = agent!.pairings.issue(MACHINE_MINT).token;
    const revokedPair = await post(
      proxied('/api/agent/v1/pairing/redeem'),
      { [PAIRING_TOKEN_HEADER]: revokedToken },
      { machine: 'doomed' },
    );
    const doomed: string = revokedPair.body.credential;

    const keptToken = agent!.pairings.issue(MACHINE_MINT).token;
    const keptPair = await post(
      proxied('/api/agent/v1/pairing/redeem'),
      { [PAIRING_TOKEN_HEADER]: keptToken },
      { machine: 'kept' },
    );
    const kept: string = keptPair.body.credential;

    const before = await fetch(statePath, {
      headers: browserHeaders({ [MACHINE_CREDENTIAL_HEADER]: doomed }),
    });
    expect(before.status).toBe(200);

    expect(agent!.machines.revoke('doomed')).toBe(true);

    const after = await fetch(statePath, {
      headers: browserHeaders({ [MACHINE_CREDENTIAL_HEADER]: doomed }),
    });
    expect(after.status).toBe(403);
    const afterBody = (await after.json()) as { signal: string };
    // Withdrawn, not unknown. "Never paired" would send an operator to pair
    // again over a decision someone deliberately made.
    expect(afterBody.signal).toBe('MACHINE_CREDENTIAL_REVOKED');

    const other = await fetch(statePath, {
      headers: browserHeaders({ [MACHINE_CREDENTIAL_HEADER]: kept }),
    });
    expect(other.status).toBe(200);
  }, 120_000);

  /**
   * SSRF. The browser names a configured id and never a host.
   *
   * Each of these is refused BY THE SERVER — the page declining to ask would be
   * no control at all, since the request under test is one a page can be made to
   * issue. A route-path allowlist does not constrain the host, which is why the
   * allowlist is over ORIGINS and the browser selects among them.
   */
  it('refuses a URL, an unconfigured target and an uncarried path, server-side', async (ctx) => {
    skipIfUnavailable(ctx);

    // A URL where a path belongs. Refused as a URL, not normalised into one.
    const asUrl = await fetch(
      `${forkBase}${PROXY_PREFIX}/${TARGET_ID}/http://169.254.169.254/latest/meta-data`,
      { headers: browserHeaders(), redirect: 'manual' },
    );
    expect(asUrl.status).toBe(400);
    expect(((await asUrl.json()) as { signal: string }).signal).toBe('CODEV_AGENT_PATH_ABSOLUTE');

    // A loopback address that is not the configured one, named as a target id.
    // There is no entry for it, so there is no origin to dial.
    const unconfigured = await fetch(
      `${forkBase}${PROXY_PREFIX}/http%3A%2F%2F127.0.0.1%3A9/api/agent/v1/session`,
      { headers: browserHeaders(), redirect: 'manual' },
    );
    expect(unconfigured.status).toBe(404);
    expect(((await unconfigured.json()) as { signal: string }).signal).toBe(
      'CODEV_AGENT_UNKNOWN_TARGET',
    );

    // A real agent route the table deliberately does not carry: the SSE stream,
    // which this proxy buffers and therefore must not pretend to serve.
    const stream = await fetch(
      proxied(`/api/agent/v1/workspaces/${agent!.encodedWorkspace}/stream`),
      { headers: browserHeaders(), redirect: 'manual' },
    );
    expect(stream.status).toBe(404);
    expect(((await stream.json()) as { signal: string }).signal).toBe('CODEV_AGENT_PATH_NOT_ALLOWED');

    // Revocation over HTTP is not carried either: a browser that could revoke
    // could deny a human their own gate. `afx pair revoke` is the operator path.
    const revoke = await fetch(proxied('/api/agent/v1/machines/ipad'), {
      method: 'DELETE',
      headers: browserHeaders(),
      redirect: 'manual',
    });
    expect(revoke.status).toBe(404);

    // And a path outside the agent prefix entirely.
    const elsewhere = await fetch(proxied('/api/orchestration/threads'), {
      headers: browserHeaders(),
      redirect: 'manual',
    });
    expect(elsewhere.status).toBe(404);
  }, 120_000);

  /**
   * THE PROXY BUFFERS, SO IT MUST BE BOUNDED.
   *
   * `HttpServerRequest.MaxBodySize` defaults to UNBOUNDED in Effect, and this
   * route reads the whole body before forwarding it — so without a cap one
   * authenticated caller makes the server hold an arbitrary amount in memory, on
   * the route whose whole purpose is to be reachable from a phone.
   *
   * Two paths, and both are driven: a body that DECLARES an oversize
   * `content-length` is refused before it is read, and a chunked body that
   * declares no length is caught by the cap on the read itself. Asserted here
   * rather than in a unit test because the bound lives in the route handler, and
   * a unit test of the pure functions cannot see whether anything applies it.
   */
  it('refuses an oversize body, declared or chunked, rather than buffering it', async (ctx) => {
    skipIfUnavailable(ctx);

    const oversize = 'x'.repeat(200_000);

    const declared = await fetch(proxied('/api/agent/v1/pairing/redeem'), {
      method: 'POST',
      headers: browserHeaders({ [PAIRING_TOKEN_HEADER]: 'unused' }),
      body: JSON.stringify({ machine: oversize }),
      redirect: 'manual',
    });
    expect(declared.status).toBe(413);
    expect(((await declared.json()) as { signal: string }).signal).toBe('CODEV_AGENT_BODY_TOO_LARGE');

    // Chunked: a ReadableStream body declares no content-length, so the early
    // check cannot see it and the cap on the read is what answers.
    const chunked = await fetch(proxied('/api/agent/v1/pairing/redeem'), {
      method: 'POST',
      headers: browserHeaders({ [PAIRING_TOKEN_HEADER]: 'unused' }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ machine: oversize })));
          controller.close();
        },
      }),
      // Node's fetch requires this for a stream body.
      duplex: 'half',
      redirect: 'manual',
    } as RequestInit & { duplex: 'half' });
    expect(chunked.status).toBe(413);
    expect(((await chunked.json()) as { signal: string }).signal).toBe('CODEV_AGENT_BODY_UNREAD');

    // And an ordinary body still goes through, so the cap is a bound rather than
    // a wall — without this the two above pass on a proxy that refuses every POST.
    const machineToken = agent!.pairings.issue(MACHINE_MINT).token;
    const ordinary = await post(
      proxied('/api/agent/v1/pairing/redeem'),
      { [PAIRING_TOKEN_HEADER]: machineToken },
      { machine: 'within-the-bound' },
    );
    expect(ordinary.status).toBe(201);
  }, 120_000);

  /**
   * t3code's own session does not travel to `codev-agent`.
   *
   * The request below carries a valid t3code bearer and NO machine credential.
   * If the proxy forwarded `authorization`, `codev-agent` would see a bearer it
   * does not understand — and, more to the point, another server would have
   * t3code's identity. The refusal proves the header did not arrive as anything
   * `codev-agent` could act on, and the header-level assertion lives in the
   * fork's own unit test.
   */
  it('does not hand t3code\'s session to codev-agent', async (ctx) => {
    skipIfUnavailable(ctx);
    const response = await fetch(proxied('/api/agent/v1/session'), { headers: browserHeaders() });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { signal: string }).signal).toBe(
      'MACHINE_CREDENTIAL_REQUIRED',
    );
  }, 60_000);

  /**
   * The proxy is not an open hop. Without t3code's own session it refuses before
   * anything is dialled — otherwise this server would forward to a loopback
   * service for anyone who can reach it.
   */
  it('refuses an unauthenticated caller before dialling anything', async (ctx) => {
    skipIfUnavailable(ctx);
    const response = await fetch(proxied('/api/agent/v1/session'), {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  }, 60_000);

  /** The targets route names ids and never origins. */
  it('publishes target ids without their origins', async (ctx) => {
    skipIfUnavailable(ctx);
    const response = await fetch(`${forkBase}/api/codev/agent-targets`, {
      headers: browserHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { targets: ReadonlyArray<Record<string, unknown>> };
    expect(body.targets).toEqual([{ id: TARGET_ID }]);
    expect(JSON.stringify(body)).not.toContain(String(agent!.port));
  }, 60_000);
});
