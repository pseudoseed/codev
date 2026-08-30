import { describe, expect, it, vi } from 'vitest';
import { approveGate, openHumanSession } from '../src/gate/approval.js';
import type { MachineConfig } from '../src/connection/machine.js';

const config: MachineConfig = {
  id: 'alpha',
  label: 'alpha',
  origin: '/m/alpha',
  workspacePath: '/Users/x/dev/codev',
  credential: 'cred.secret',
};

type Call = { url: string; headers: Record<string, string>; body: any };

/**
 * LONGEST MATCH WINS, and that is not a nicety.
 *
 * `/gates/approve` is a PREFIX of `/gates/approvals`, so a first-match router
 * served the synchronous stub to the asynchronous submit — and every test in this
 * file passed against a route it was not exercising. A helper that silently
 * answers the wrong route is the same defect as production code that does.
 *
 * It also serves GETs, which the poll uses and which carry no body.
 */
function router(
  routes: Record<string, { status: number; body: unknown } | Array<{ status: number; body: unknown }>>,
) {
  const calls: Call[] = [];
  const served: Record<string, number> = {};
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const key = Object.keys(routes)
      .filter((path) => url.includes(path))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ signal: 'NOT_FOUND' }), { status: 404 });
    const entry = routes[key];
    // An array is a SCRIPT: each call takes the next answer, and the last one
    // repeats. That is how a poll that must change its answer is driven without
    // the test controlling a clock.
    const route = Array.isArray(entry)
      ? entry[Math.min(served[key] ?? 0, entry.length - 1)]
      : entry;
    served[key] = (served[key] ?? 0) + 1;
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

/**
 * A CURRENT host that recognises the route and wires no operation store.
 *
 * This constant was called "the 501 an older host answers", and that label was
 * wrong in a way that hid a real defect: an older host has no such route and its
 * dispatcher answers 404 AGENT_ROUTE_NOT_FOUND. The fixture agreed with the code,
 * so the fallback tested here was never the fallback an older host would take.
 * `NO_ROUTE` below is that one.
 */
const NO_ASYNC = { '/gates/approvals': { status: 501, body: { signal: 'APPROVAL_OPERATIONS_NOT_AVAILABLE' } } };

/** What a host predating this route actually answers: its dispatcher's 404. */
const NO_ROUTE = { '/gates/approvals': { status: 404, body: { signal: 'AGENT_ROUTE_NOT_FOUND' } } };

describe('openHumanSession', () => {
  it('presents the pairing token alongside the machine credential', async () => {
    const { fetchImpl, calls } = router({
      '/human-sessions': { status: 201, body: { sessionId: 's1', presentation: 's1.secret', expiresAt: 'later' } },
    });
    const result = await openHumanSession(fetchImpl, config, 'tok-1');
    expect(result.ok).toBe(true);
    expect(calls[0].headers['x-codev-pairing-token']).toBe('tok-1');
    expect(calls[0].headers['x-codev-machine-credential']).toBe('cred.secret');
  });

  it('reports the server\'s own signal rather than a generic failure', async () => {
    const { fetchImpl } = router({
      '/human-sessions': { status: 401, body: { signal: 'PAIRING_TOKEN_EXPIRED', message: 'that token expired' } },
    });
    const result = await openHumanSession(fetchImpl, config, 'stale');
    expect(result).toMatchObject({ ok: false, signal: 'PAIRING_TOKEN_EXPIRED', message: 'that token expired' });
  });
});

describe('approveGate', () => {
  const session = { sessionId: 's1', presentation: 's1.secret', expiresAt: 'later' };

  it('issues, mints and spends, in that order, against the named gate', async () => {
    const { fetchImpl, calls } = router({
      ...NO_ASYNC,
      '/approval-capabilities': { status: 201, body: { capabilityId: 'cap-1', presentation: 'cap-1.s' } },
      '/approval-nonces': { status: 201, body: { nonce: 'n-1' } },
      '/gates/approve': {
        status: 200,
        body: { signal: 'GATE_APPROVED', machine: 'alpha', sessionId: 's1', approvedAt: '2026-08-30T01:00:00Z' },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'plan-approval' });
    expect(result).toMatchObject({ ok: true, machine: 'alpha', sessionId: 's1' });
    // FOUR CALLS, NOT THREE: the asynchronous route is tried first and this host
    // answers 501, so the synchronous one is used. That fallback is the documented
    // behaviour for a host with no operation store, and it is asserted here rather
    // than left as an implementation detail.
    expect(calls.map((call) => call.url.replace('/m/alpha/api/agent/v1', ''))).toEqual([
      '/approval-capabilities',
      '/approval-nonces',
      '/workspaces/L1VzZXJzL3gvZGV2L2NvZGV2/gates/approvals',
      '/workspaces/L1VzZXJzL3gvZGV2L2NvZGV2/gates/approve',
    ]);
    expect(calls[1].body).toMatchObject({ projectId: '146', gateName: 'plan-approval', capabilityId: 'cap-1' });
    expect(calls[3].body).toMatchObject({ capability: 'cap-1.s', nonce: 'n-1' });
    for (const call of calls) expect(call.headers['x-codev-human-session']).toBe('s1.secret');
  });

  /* A capability is bound to the host that verifies it, so the client never
     names a machine. A route that refuses one must surface its reason. */
  it('stops at the first refusal and names which step refused', async () => {
    const { fetchImpl, calls } = router({
      ...NO_ASYNC,
      '/approval-capabilities': {
        status: 400,
        body: { signal: 'APPROVAL_CAPABILITY_FOREIGN_MACHINE', message: 'not this host' },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal: 'APPROVAL_CAPABILITY_FOREIGN_MACHINE' });
    expect(calls).toHaveLength(1);
  });

  it('never reports a refused approval as approved', async () => {
    const { fetchImpl } = router({
      ...NO_ASYNC,
      '/approval-capabilities': { status: 201, body: { capabilityId: 'cap-1', presentation: 'cap-1.s' } },
      '/approval-nonces': { status: 201, body: { nonce: 'n-1' } },
      '/gates/approve': { status: 403, body: { signal: 'PHASE_CHECKS_FAILED', message: 'checks failed' } },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal: 'PHASE_CHECKS_FAILED', message: 'checks failed' });
  });

  it('treats a 200 with an unreadable body as a refusal it cannot confirm', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/approval-capabilities')) {
        return new Response('not json', { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result.ok).toBe(false);
  });
});

describe('a session that ended mid-ceremony', () => {
  const session = { sessionId: 's1', presentation: 's1.secret', expiresAt: 'later' };

  /*
   * Sessions idle out after 30 minutes, so this is the ordinary case, not the
   * exceptional one. Without the flag the caller kept a dead session and left an
   * Approve button that could only fail, escapable only by reloading the page.
   */
  it.each([
    ['HUMAN_SESSION_REQUIRED', 401],
    ['HUMAN_SESSION_REVOKED', 401],
    ['APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION', 403],
  ])('reports %s as a session that ended', async (signal, status) => {
    const { fetchImpl } = router({
      ...NO_ASYNC,
      '/approval-capabilities': { status, body: { signal, message: 'gone' } },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal, sessionEnded: true });
  });

  it('does not call an ordinary refusal a dead session', async () => {
    const { fetchImpl } = router({
      ...NO_ASYNC,
      '/approval-capabilities': { status: 201, body: { capabilityId: 'c', presentation: 'c.s' } },
      '/approval-nonces': { status: 201, body: { nonce: 'n' } },
      '/gates/approve': { status: 403, body: { signal: 'PHASE_CHECKS_FAILED', message: 'checks failed' } },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal: 'PHASE_CHECKS_FAILED', sessionEnded: false });
  });
});

describe('an approval that is recorded but does not travel', () => {
  const session = { sessionId: 's1', presentation: 's1.secret', expiresAt: 'later' };

  /*
   * The gate is approved and committed; only delivery to the remote failed.
   * Reporting that as a refusal tells a human their approval did not happen when
   * it did — and they approve again, chasing a state that already changed. This
   * is the defect class of the whole program aimed at the one action the client
   * exists to perform.
   */
  /*
   * THREE STAGES, THREE REMEDIES, AND NONE OF THEM MEANS UNAPPROVED.
   * `writeState` runs before `git add`, so a commit failure leaves the approved
   * gate on disk exactly as a push failure leaves it in a commit. Reporting
   * either as a refusal sends a human to approve again.
   */
  it.each([
    ['written-not-committed', 'the commit failed: pre-commit hook returned 1'],
    ['committed-not-pushed', 'the push failed: no upstream'],
    ['unknown', 'the approval is recorded in status.yaml, but this request then failed'],
  ])('reports %s as a success carrying a caveat', async (delivery, deliveryMessage) => {
    const { fetchImpl } = router({
      ...NO_ASYNC,
      '/approval-capabilities': { status: 201, body: { capabilityId: 'c', presentation: 'c.s' } },
      '/approval-nonces': { status: 201, body: { nonce: 'n' } },
      '/gates/approve': {
        status: 200,
        body: {
          signal: 'GATE_APPROVED',
          machine: 'alpha',
          sessionId: 's1',
          approvedAt: '2026-08-30T02:00:00Z',
          delivery,
          deliveryMessage,
        },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.delivery).toBe(delivery);
    expect(result.ok && result.deliveryMessage).toBe(deliveryMessage);
  });

  it('ignores a delivery stage it does not recognise rather than passing it through', async () => {
    const { fetchImpl } = router({
      ...NO_ASYNC,
      '/approval-capabilities': { status: 201, body: { capabilityId: 'c', presentation: 'c.s' } },
      '/approval-nonces': { status: 201, body: { nonce: 'n' } },
      '/gates/approve': {
        status: 200,
        body: {
          signal: 'GATE_APPROVED',
          machine: 'alpha',
          sessionId: 's1',
          approvedAt: '2026-08-30T02:00:00Z',
          delivery: 'teleported',
        },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.delivery).toBeUndefined();
  });

  it('carries no caveat on an ordinary approval', async () => {
    const { fetchImpl } = router({
      ...NO_ASYNC,
      '/approval-capabilities': { status: 201, body: { capabilityId: 'c', presentation: 'c.s' } },
      '/approval-nonces': { status: 201, body: { nonce: 'n' } },
      '/gates/approve': {
        status: 200,
        body: {
          signal: 'GATE_APPROVED',
          machine: 'alpha',
          sessionId: 's1',
          approvedAt: '2026-08-30T02:00:00Z',
        },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.delivery).toBeUndefined();
  });
});

/**
 * THE CLIENT MUST NOT MANUFACTURE THE EVIDENCE IT SHOWS A HUMAN.
 *
 * This used to treat any 200 as confirmation and fill the gaps from local state:
 * the timestamp from this browser's clock, the machine from the configured
 * label, the session from the one already in hand. An empty body rendered as
 * "approved on alpha at <now>, session s1" — every word of it invented here, at
 * the one moment the client has no business guessing.
 *
 * And an unreadable success is NOT a refusal: the gate may be approved, so
 * saying "no" would send a human to approve again. Three states, not two.
 */
describe('an approval the client cannot confirm', () => {
  const session = { sessionId: 's1', presentation: 's1.secret', expiresAt: 'later' };

  function upTo(approve: { status: number; body: unknown }) {
    return router({
      '/approval-capabilities': { status: 201, body: { capabilityId: 'c', presentation: 'c.s' } },
      ...NO_ASYNC,
      '/approval-nonces': { status: 201, body: { nonce: 'n' } },
      '/gates/approve': approve,
    });
  }

  it.each([
    ['an empty body', {}],
    ['no signal', { machine: 'alpha', sessionId: 's1', approvedAt: '2026-08-30T02:00:00Z' }],
    ['the wrong signal', { signal: 'SOMETHING_ELSE', machine: 'alpha', sessionId: 's1', approvedAt: 'x' }],
    ['no approvedAt', { signal: 'GATE_APPROVED', machine: 'alpha', sessionId: 's1' }],
    ['no machine', { signal: 'GATE_APPROVED', sessionId: 's1', approvedAt: 'x' }],
  ])('reports a 200 with %s as unconfirmed, not as approved', async (_name, body) => {
    const { fetchImpl } = upTo({ status: 200, body });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.unconfirmed).toBe(true);
    expect(result.ok === false && result.signal).toBe('GATE_APPROVAL_UNCONFIRMED');
    // It must not tell a human the approval failed, because it does not know that.
    expect(result.ok === false && result.message).toContain('unknown');
    expect(result.ok === false && result.message).toContain('before approving again');
  });

  it('does not invent a timestamp, a machine or a session from local state', async () => {
    const { fetchImpl } = upTo({ status: 200, body: {} });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('alpha');
    expect(rendered).not.toContain('s1');
  });

  /*
   * A MISSING SESSION ID IS NOT A MISSING ANSWER. An approval recorded before
   * session ids existed is a real approval whose approver is unknown, and the
   * client reports "unknown" rather than filling it with the session in hand.
   */
  it('accepts an approval with no recorded session, and does not invent one', async () => {
    const { fetchImpl } = upTo({
      status: 200,
      body: { signal: 'GATE_APPROVED', machine: 'alpha', approvedAt: '2026-08-30T02:00:00Z' },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.sessionId).toBeNull();
  });

  /*
   * ALREADY-APPROVED IS SOMEBODY ELSE'S ACT. Reporting it as this session's
   * approval would credit a person for something they did not do, at the one
   * place the product records who decided what.
   */
  it('reports an already-approved gate with the record that exists, not this request', async () => {
    const { fetchImpl } = upTo({
      status: 200,
      body: {
        signal: 'GATE_ALREADY_APPROVED',
        machine: 'someone-elses-host',
        sessionId: 'their-session',
        approvedAt: '2026-08-29T09:00:00Z',
        authority: 'operator at the keyboard',
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.alreadyApproved).toBe(true);
    expect(result.ok && result.machine).toBe('someone-elses-host');
    expect(result.ok && result.sessionId).toBe('their-session');
    expect(result.ok && result.approvedAt).toBe('2026-08-29T09:00:00Z');
    expect(result.ok && result.authority).toBe('operator at the keyboard');
    // Emphatically not the requesting session.
    expect(result.ok && result.sessionId).not.toBe(session.sessionId);
  });

  /* An actual refusal is still a refusal, and is NOT marked unconfirmed. */
  it('keeps a real refusal distinct from an unreadable success', async () => {
    const { fetchImpl } = upTo({
      status: 403,
      body: { signal: 'PHASE_CHECKS_REQUIRED', message: 'the checks would run' },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.unconfirmed).toBeFalsy();
    expect(result.ok === false && result.signal).toBe('PHASE_CHECKS_REQUIRED');
  });
});

/**
 * THE PATH AN ORDINARY PROJECT MUST TAKE.
 *
 * The synchronous route refuses any project whose phase declares checks, so
 * before this existed a human reaching a gate in this client was sent to the CLI.
 * These drive submit → poll → report against the routes that replace it.
 */
describe('approveGate, asynchronously', () => {
  const session = { sessionId: 's1', presentation: 's1.secret', expiresAt: 'later' };
  const credentials = {
    '/approval-capabilities': { status: 201, body: { capabilityId: 'cap-1', presentation: 'cap-1.s' } },
    '/approval-nonces': { status: 201, body: { nonce: 'n-1' } },
  };

  it('submits, polls until it settles, and reports the persisted record', async () => {
    const { fetchImpl, calls } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-1',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-1',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 200, body: { projectId: '146', gateName: 'pr', state: 'running', phase: 'review', checks: ['build', 'tests'] } },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'succeeded',
            record: {
              machine: 'alpha',
              sessionId: 's1',
              approvedAt: '2026-08-30T01:00:00Z',
              outcome: 'approved',
            },
          },
        },
      ],
    });
    const progress: unknown[] = [];
    const result = await approveGate(
      fetchImpl,
      config,
      session,
      { projectId: '146', gateName: 'pr' },
      (update) => progress.push(update),
    );

    expect(result).toMatchObject({
      ok: true, machine: 'alpha', sessionId: 's1', approvedAt: '2026-08-30T01:00:00Z',
    });
    // The submit is a POST with the four fields; the polls are GETs with none.
    expect(calls[2].body).toMatchObject({ projectId: '146', gateName: 'pr', capability: 'cap-1.s', nonce: 'n-1' });
    expect(calls[3].body).toBeUndefined();
    // What was reported while it ran is the SERVER's phase and checks.
    expect(progress).toEqual([
      { state: 'running', operationId: 'op-1', phase: 'review', checks: ['build', 'tests'] },
    ]);
  }, 20_000);

  it('reports a refusal with porch\'s own code, not a generic failure', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-2',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-2',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 200, body: { projectId: '146', gateName: 'pr', state: 'refused', code: 'PHASE_CHECKS_FAILED', message: 'the checks did not pass' } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({
      ok: false, signal: 'PHASE_CHECKS_FAILED', message: 'the checks did not pass',
    });
    expect((result as { unconfirmed?: boolean }).unconfirmed).toBeUndefined();
  }, 20_000);

  /*
   * AN INTERRUPTION IS NOT A REFUSAL. The host stopped while the work ran and the
   * gate may well be approved — the server has read `status.yaml` and its message
   * says which it found. Rendering this as "not approved" would send a human to
   * approve something already approved.
   */
  it('reports an interrupted approval as unconfirmed, carrying the server\'s reading', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-3',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-3',
            projectId: '146',
            gateName: 'pr',
          },
        },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'interrupted',
            gateAfterInterruption: 'approved',
            message: 'this host stopped while op-3 was running, and status.yaml now shows pr APPROVED.',
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true });
    expect((result as { message: string }).message).toContain('APPROVED');
  }, 20_000);

  it('reports a failure as a failure, with the reason the server gave', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-4',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-4',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 200, body: { projectId: '146', gateName: 'pr', state: 'failed', message: 'ENOSPC writing status.yaml' } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal: 'GATE_APPROVAL_FAILED' });
    expect((result as { unconfirmed?: boolean }).unconfirmed).toBeUndefined();
  }, 20_000);

  it('carries the delivery caveat through, as a success', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-5',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-5',
            projectId: '146',
            gateName: 'pr',
          },
        },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'succeeded',
            record: {
              machine: 'alpha',
              sessionId: 's1',
              approvedAt: '2026-08-30T01:00:00Z',
              delivery: 'committed-not-pushed',
              deliveryMessage: 'the push was refused',
            },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    // A SUCCESS WITH A CAVEAT. The gate is approved; something did not travel.
    expect(result).toMatchObject({ ok: true, delivery: 'committed-not-pushed' });
  }, 20_000);

  it('reports an already-approved gate as somebody else\'s act', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-6',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-6',
            projectId: '146',
            gateName: 'pr',
          },
        },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'succeeded',
            record: {
              machine: 'beta',
              sessionId: 'somebody-else',
              approvedAt: '2026-08-29T09:00:00Z',
              outcome: 'already-approved',
            },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: true, alreadyApproved: true, sessionId: 'somebody-else' });
  }, 20_000);

  it('reports a succeeded operation it cannot read as unconfirmed, never as approved', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-7',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-7',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 200, body: { projectId: '146', gateName: 'pr', state: 'succeeded', record: {} } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true, signal: 'GATE_APPROVAL_UNCONFIRMED' });
  }, 20_000);

  it('does not claim an outcome for a state it does not recognise', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-8',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-8',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 200, body: { projectId: '146', gateName: 'pr', state: 'hibernating' } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true });
    expect((result as { message: string }).message).toContain('hibernating');
    expect((result as { message: string }).message).toContain('op-8');
  }, 20_000);

  /*
   * A POLL THAT CANNOT READ THE STATE IS NOT A VERDICT ON THE GATE.
   *
   * This mapped every non-200 onto a plain refusal, rendered identically to a
   * failed approval — so the server's own 503, which exists to say "the store
   * could not be read", told a human their gate was not approved. The server
   * distinguished unreadable from unknown and the client collapsed them back.
   */
  it('retries past a 503 rather than calling it a refusal', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-10',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-10',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 503, body: { signal: 'APPROVAL_OPERATION_STORE_UNREADABLE' } },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'succeeded',
            record: { machine: 'alpha', sessionId: 's1', approvedAt: '2026-08-30T01:00:00Z' },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    // It recovered, and the approval is reported. A refusal here would have been
    // a wrong answer about a gate that was in fact approved.
    expect(result).toMatchObject({ ok: true, machine: 'alpha' });
  }, 20_000);

  it('retries past a thrown fetch rather than calling it a refusal', async () => {
    let polls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('/approval-capabilities')) {
        return new Response(JSON.stringify({ capabilityId: 'cap-1', presentation: 'cap-1.s' }), { status: 201 });
      }
      if (url.includes('/approval-nonces')) {
        return new Response(JSON.stringify({ nonce: 'n-1' }), { status: 201 });
      }
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          operationId: 'op-11',
          state: 'submitted',
          receipt: 'receipt-op-11',
          projectId: '146',
          gateName: 'pr',
        }), { status: 202 });
      }
      polls += 1;
      // The network drops once. Nothing has been learned about the gate.
      if (polls === 1) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({
        projectId: '146',
        gateName: 'pr',
        state: 'succeeded',
        record: { machine: 'alpha', sessionId: 's1', approvedAt: '2026-08-30T01:00:00Z' },
      }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: true, machine: 'alpha' });
    expect(polls).toBeGreaterThan(1);
  }, 20_000);

  /*
   * 403 IS THE ONE DEFINITE ANSWER a poll can get: this session may not read
   * this operation, and retrying will never change that. Retrying it would spin
   * for the whole deadline over a question already answered.
   */
  it('stops on a 403, because that answer will not change', async () => {
    const { fetchImpl, calls } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-12',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-12',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 403, body: { signal: 'APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION', message: 'another session' } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal: 'APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION' });
    // Two credential calls, one submit, one poll — it did not keep asking.
    expect(calls).toHaveLength(4);
  }, 20_000);

  /*
   * THE SAME RULE AS THE POLL, ONE CALL EARLIER. A submit that never completed
   * may well have reached the server and started an approval, so reporting "not
   * approved" would be a verdict nobody is entitled to.
   */
  it('reports a submit that never completed as unconfirmed, not as a refusal', async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('/approval-capabilities')) {
        return new Response(JSON.stringify({ capabilityId: 'cap-1', presentation: 'cap-1.s' }), { status: 201 });
      }
      if (url.includes('/approval-nonces')) {
        return new Response(JSON.stringify({ nonce: 'n-1' }), { status: 201 });
      }
      void init;
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;

    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true, signal: 'GATE_APPROVAL_UNCONFIRMED' });
    expect((result as { message: string }).message).toContain('may already be running');
  }, 20_000);

  /*
   * A 401 MID-POLL IS THE SESSION ENDING, and the synchronous path already
   * treats it that way. Retrying it to the deadline and reporting a bare
   * unconfirmed left the dead session in place, so the human kept an Approve
   * button they could only escape by reloading.
   */
  it('drops the session on a 401 instead of retrying for thirty minutes', async () => {
    const { fetchImpl, calls } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-13',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-13',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 401, body: { signal: 'HUMAN_SESSION_REQUIRED', message: 'that session is gone' } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, sessionEnded: true });
    // It stopped: two credential calls, one submit, one poll.
    expect(calls).toHaveLength(4);
  }, 20_000);

  /*
   * THE SAME RULE AS THE THROWN FETCH, one status class over. The server writes
   * the operation record BEFORE the 202, so a 5xx after that point leaves an
   * approval running while answering with a failure.
   */
  it('reports a 5xx on the submit as unconfirmed, because the operation may exist', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': { status: 503, body: { signal: 'AGENT_ROUTE_FAILED' } },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true, signal: 'GATE_APPROVAL_UNCONFIRMED' });
  }, 20_000);

  it('keeps a 400 on the submit a refusal, because that answer is definite', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': { status: 400, body: { signal: 'APPROVAL_REQUEST_MALFORMED', message: 'bad' } },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal: 'APPROVAL_REQUEST_MALFORMED' });
    expect((result as { unconfirmed?: boolean }).unconfirmed).toBeUndefined();
  }, 20_000);

  /*
   * A host that accepted an operation and then does not know it has answered
   * definitely — re-asking cannot change it, and spinning to the deadline left
   * the progress line on screen for thirty minutes over a settled question.
   */
  it('stops on a poll 404 rather than retrying for thirty minutes', async () => {
    const { fetchImpl, calls } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            operationId: 'op-14',
            state: 'submitted',
            // THE FULL CONTRACT. These fixtures omitted the receipt and the
            // identity fields, so nothing ever exercised the checks that read
            // them — the tests demonstrated the hole rather than the rule.
            receipt: 'receipt-op-14',
            projectId: '146',
            gateName: 'pr',
          },
        },
        { status: 404, body: { signal: 'APPROVAL_OPERATION_UNKNOWN' } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true });
    expect((result as { message: string }).message).toContain('op-14');
    expect(calls).toHaveLength(4);
  }, 20_000);

  /*
   * A CONFLICT IS NOT A REFUSAL OF THIS GATE, AND MUST NOT RENDER AS ONE.
   *
   * An approval for this project is RUNNING and may be about to succeed. This
   * used to return a plain refusal, which the panel paints in the same red as a
   * genuinely refused approval — telling the operator their gate was refused
   * about one that was still deciding.
   *
   * A 409 now means someone ELSE's run: this client cannot poll it, so it cannot
   * know the outcome, and `unconfirmed` is the band for exactly that.
   */
  it('reports another session\'s in-flight approval as unconfirmed, not refused', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': {
        status: 409,
        body: {
          signal: 'APPROVAL_ALREADY_IN_FLIGHT',
          message: 'operation op-9 is already running',
          operationId: 'op-9',
        },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true, signal: 'APPROVAL_ALREADY_IN_FLIGHT' });
    expect((result as { message: string }).message).toContain('op-9');
    // The words that would make it a refusal must not be there.
    expect((result as { message: string }).message).not.toMatch(/refus/i);
  }, 20_000);

  /*
   * THE LOST 202, WHICH IS THE CASE THAT PRODUCES ALL OF THIS.
   *
   * The submit is accepted and its response never arrives — a dropped
   * connection, a closed lid, a proxy timeout. The human clicks again. The host
   * recognises the submitter and hands back the operation it already started,
   * and this client polls THAT one to its real terminal outcome.
   *
   * Asserting the resume alone would not be enough: what makes it a recovery
   * rather than a claim of one is that the outcome the human is shown is the
   * ORIGINAL operation's, so the id is checked all the way through.
   */
  it('resumes the operation it already submitted after a lost response', async () => {
    const { fetchImpl, calls } = router({
      ...credentials,
      '/gates/approvals': [
        // The retry. The first submit's 202 never reached this client, so from
        // its point of view this is the first answer it has seen.
        {
          status: 202,
          body: {
            signal: 'APPROVAL_OPERATION_RESUMED',
            operationId: 'op-original',
            receipt: 'receipt-original',
            projectId: '146',
            gateName: 'pr',
            state: 'running',
            message: 'resuming it rather than starting a second run',
          },
        },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'succeeded',
            record: { outcome: 'approved', approvedAt: '2026-08-30T12:30:00Z', machine: 'laptop' },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });

    // THE ORIGINAL OPERATION'S OUTCOME, not a second run's.
    expect(result).toMatchObject({ ok: true });
    const polls = calls.filter((call) => call.url.includes('/gates/approvals/'));
    expect(polls.length).toBeGreaterThan(0);
    for (const poll of polls) {
      expect(poll.url).toContain('op-original');
      expect(poll.headers['x-codev-approval-receipt']).toBe('receipt-original');
    }
    // And no second submit was made — recovering must not run the checks twice.
    const submits = calls.filter((call) => call.url.endsWith('/gates/approvals'));
    expect(submits).toHaveLength(1);
  }, 20_000);

  /*
   * THE RECEIPT IS A BEARER SECRET AND MUST NOT BE IN THE URL.
   *
   * Tower logs `req.url` on a boot-window 503 and on EVERY authentication
   * failure — which is exactly when a client polling across a restart arrives —
   * and reverse proxies log query strings regardless of what we do. So the
   * assertion is the ABSENCE: no polled URL may contain it, however the request
   * is built. Asserting only that the header is present would pass with the query
   * parameter still there beside it.
   */
  it('carries the receipt in a header and never in the polled URL', async () => {
    const receipt = 'receipt-secret-9f2c';
    const { fetchImpl, calls } = router({
      ...credentials,
      '/gates/approvals': [
        { status: 202, body: { operationId: 'op-15', state: 'submitted', receipt, projectId: '146', gateName: 'pr' } },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'succeeded',
            record: { outcome: 'approved', approvedAt: '2026-08-30T12:00:00Z', machine: 'laptop' },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: true });

    const polls = calls.filter((call) => call.url.includes('/gates/approvals/'));
    expect(polls.length).toBeGreaterThan(0);
    for (const poll of polls) {
      expect(poll.url, 'the receipt is in the URL').not.toContain(receipt);
      expect(poll.url, 'a receipt query parameter is back').not.toContain('receipt=');
      expect(poll.headers['x-codev-approval-receipt']).toBe(receipt);
    }

    // Nor in the URL of ANY call — the submit's own URL included, since a future
    // convenience could put it there just as easily.
    for (const call of calls) expect(call.url).not.toContain(receipt);
  }, 20_000);

  /*
   * THE FALLBACK AN OLDER HOST ACTUALLY TAKES.
   *
   * The compatibility promised in this file's comments was reachable only via
   * 501, which is a CURRENT host with no operation store. A host predating the
   * route answers 404 AGENT_ROUTE_NOT_FOUND from its dispatcher — so an upgraded
   * client lost gate approval entirely against an older Tower, and the fixture
   * calling 501 "an older host" is why nothing said so.
   */
  it('falls back to the synchronous route against a host that has no such route', async () => {
    const { fetchImpl, calls } = router({
      ...NO_ROUTE,
      '/approval-capabilities': { status: 201, body: { capabilityId: 'cap-1', presentation: 'cap-1.s' } },
      '/approval-nonces': { status: 201, body: { nonce: 'n-1' } },
      '/gates/approve': {
        status: 200,
        body: {
          signal: 'GATE_APPROVED',
          machine: 'laptop',
          sessionId: 'session-1',
          approvedAt: '2026-08-30T13:00:00Z',
        },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: true });
    // It really used the synchronous route rather than reporting success from
    // the 404 it just received.
    expect(calls.some((call) => call.url.endsWith('/gates/approve'))).toBe(true);
  }, 20_000);

  /*
   * AND ONLY THAT 404. Other 404s from this route are real answers — an unknown
   * workspace, one this host does not serve — and treating them as "no async
   * route here" would run the synchronous path against a host that refused the
   * request outright.
   */
  it('does not treat an unknown workspace as a missing route', async () => {
    const { fetchImpl, calls } = router({
      ...credentials,
      '/gates/approvals': { status: 404, body: { signal: 'WORKSPACE_NOT_REGISTERED' } },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false });
    expect(calls.some((call) => call.url.endsWith('/gates/approve')),
      'the synchronous route was used for a workspace this host does not serve').toBe(false);
  }, 20_000);

  /*
   * AN OPERATION FOR ANOTHER GATE CANNOT SETTLE THIS ONE, IN EITHER DIRECTION.
   *
   * The host restricts recovery to the same workspace, project and gate. This
   * client checks anyway: the outcome of an approval is not a place to trust one
   * implementation, and the failure it guards against is the worst shape there
   * is — a false thing reported as true, attributed to the wrong object.
   */
  it('will not report this gate approved from another gate\'s record', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: {
            signal: 'APPROVAL_OPERATION_RESUMED',
            operationId: 'op-other',
            receipt: 'receipt-other',
            projectId: '146',
            // ANOTHER GATE of the same project — what project-wide single-flight
            // makes reachable.
            gateName: 'plan-approval',
            state: 'running',
          },
        },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'plan-approval',
            state: 'succeeded',
            record: { outcome: 'approved', approvedAt: '2026-08-30T13:00:00Z', machine: 'laptop' },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });

    // NOT ok. A succeeded record for plan-approval says nothing about pr.
    expect(result).toMatchObject({ ok: false, unconfirmed: true });
    expect((result as { message: string }).message).toContain('plan-approval');
  }, 20_000);

  /*
   * AND THE SAME CHECK ON THE POLL, because the record read is the record
   * reported: a host could answer the submit correctly and the poll wrongly.
   */
  it('will not settle this gate from a poll body naming another', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        { status: 202, body: { operationId: 'op-1', receipt: 'r-1', projectId: '146', gateName: 'pr' } },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'plan-approval',
            state: 'succeeded',
            record: { outcome: 'approved', approvedAt: '2026-08-30T13:00:00Z', machine: 'laptop' },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true });
    expect((result as { message: string }).message).toContain('plan-approval');
  }, 20_000);

  /*
   * AN ABSENT FIELD IS NOT AGREEMENT.
   *
   * The identity check read "reject if present and different", so a 202 or a
   * poll that simply OMITTED the project and gate passed — and the fixtures in
   * this file omitted them, so the tests demonstrated the hole rather than the
   * rule.
   *
   * That is this project's own defect inverted. Everywhere else it removed
   * "I could not tell" being spelled as "no"; here a body that says nothing
   * about which gate it describes was read as saying it describes this one.
   */
  it.each([
    ['project id', { operationId: 'op-20', state: 'submitted', receipt: 'r-20', gateName: 'pr' }],
    ['gate name', { operationId: 'op-20', state: 'submitted', receipt: 'r-20', projectId: '146' }],
    ['both', { operationId: 'op-20', state: 'submitted', receipt: 'r-20' }],
  ])('will not act on a 202 that omits the %s', async (_what, body) => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        { status: 202, body },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'succeeded',
            record: { outcome: 'approved', approvedAt: '2026-08-30T14:00:00Z', machine: 'laptop' },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result, 'an unidentified operation settled this gate')
      .toMatchObject({ ok: false, unconfirmed: true });
  }, 20_000);

  /*
   * AND THE SAME ON THE POLL, since the record read is the record reported.
   */
  it.each([
    ['project id', { gateName: 'pr' }],
    ['gate name', { projectId: '146' }],
    ['both', {}],
  ])('will not settle from a poll body that omits the %s', async (_what, identity) => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        {
          status: 202,
          body: { operationId: 'op-21', state: 'submitted', receipt: 'r-21', projectId: '146', gateName: 'pr' },
        },
        {
          status: 200,
          body: {
            ...identity,
            state: 'succeeded',
            record: { outcome: 'approved', approvedAt: '2026-08-30T14:00:00Z', machine: 'laptop' },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result, 'an unidentified record settled this gate')
      .toMatchObject({ ok: false, unconfirmed: true });
  }, 20_000);

  /*
   * A 202 WITHOUT A RECEIPT IS NOT A DURABLE OPERATION.
   *
   * It was accepted and then polled on the memory-backed session alone, which
   * works right up until the host restarts — the one case the receipt exists
   * for. The contract always returns one, so its absence is not an older host to
   * accommodate; it is something wrong with this answer.
   */
  it('will not proceed on a 202 that carries no receipt', async () => {
    const { fetchImpl, calls } = router({
      ...credentials,
      '/gates/approvals': [
        { status: 202, body: { operationId: 'op-22', state: 'submitted', projectId: '146', gateName: 'pr' } },
        {
          status: 200,
          body: {
            projectId: '146',
            gateName: 'pr',
            state: 'succeeded',
            record: { outcome: 'approved', approvedAt: '2026-08-30T14:00:00Z', machine: 'laptop' },
          },
        },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true });
    expect((result as { message: string }).message).toContain('op-22');
    // UNCONFIRMED, NOT REFUSED: the approval may well be running. What is lost
    // is this client's ability to follow it across a restart.
    expect((result as { message: string }).message).toContain('may be running');
    // And it did not poll on a footing it cannot recover from.
    expect(calls.filter((call) => call.url.includes('/gates/approvals/'))).toHaveLength(0);
  }, 20_000);
});
