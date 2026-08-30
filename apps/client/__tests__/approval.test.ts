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

/** The 501 an older host answers, so the synchronous route is used instead. */
const NO_ASYNC = { '/gates/approvals': { status: 501, body: { signal: 'APPROVAL_OPERATIONS_NOT_AVAILABLE' } } };

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
        { status: 202, body: { operationId: 'op-1', state: 'submitted' } },
        { status: 200, body: { state: 'running', phase: 'review', checks: ['build', 'tests'] } },
        {
          status: 200,
          body: {
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
        { status: 202, body: { operationId: 'op-2', state: 'submitted' } },
        { status: 200, body: { state: 'refused', code: 'PHASE_CHECKS_FAILED', message: 'the checks did not pass' } },
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
        { status: 202, body: { operationId: 'op-3', state: 'submitted' } },
        {
          status: 200,
          body: {
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
        { status: 202, body: { operationId: 'op-4', state: 'submitted' } },
        { status: 200, body: { state: 'failed', message: 'ENOSPC writing status.yaml' } },
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
        { status: 202, body: { operationId: 'op-5', state: 'submitted' } },
        {
          status: 200,
          body: {
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
        { status: 202, body: { operationId: 'op-6', state: 'submitted' } },
        {
          status: 200,
          body: {
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
        { status: 202, body: { operationId: 'op-7', state: 'submitted' } },
        { status: 200, body: { state: 'succeeded', record: {} } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, unconfirmed: true, signal: 'GATE_APPROVAL_UNCONFIRMED' });
  }, 20_000);

  it('does not claim an outcome for a state it does not recognise', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': [
        { status: 202, body: { operationId: 'op-8', state: 'submitted' } },
        { status: 200, body: { state: 'hibernating' } },
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
        { status: 202, body: { operationId: 'op-10', state: 'submitted' } },
        { status: 503, body: { signal: 'APPROVAL_OPERATION_STORE_UNREADABLE' } },
        {
          status: 200,
          body: {
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
        return new Response(JSON.stringify({ operationId: 'op-11', state: 'submitted' }), { status: 202 });
      }
      polls += 1;
      // The network drops once. Nothing has been learned about the gate.
      if (polls === 1) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({
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
        { status: 202, body: { operationId: 'op-12', state: 'submitted' } },
        { status: 403, body: { signal: 'APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION', message: 'another session' } },
      ],
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal: 'APPROVAL_ISSUANCE_REQUIRES_HUMAN_SESSION' });
    // Two credential calls, one submit, one poll — it did not keep asking.
    expect(calls).toHaveLength(4);
  }, 20_000);

  /*
   * A CONFLICT IS NOT A REFUSAL OF THIS GATE. An approval for this project is
   * already running and the server names it, so the human is told to wait rather
   * than to try again.
   */
  it('passes a 409 through with the server\'s words', async () => {
    const { fetchImpl } = router({
      ...credentials,
      '/gates/approvals': {
        status: 409,
        body: { signal: 'APPROVAL_ALREADY_IN_FLIGHT', message: 'operation op-9 is already running' },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal: 'APPROVAL_ALREADY_IN_FLIGHT' });
    expect((result as { message: string }).message).toContain('op-9');
  }, 20_000);
});
