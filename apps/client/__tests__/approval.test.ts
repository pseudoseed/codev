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

function router(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    const key = Object.keys(routes).find((path) => url.includes(path));
    const route = key ? routes[key] : { status: 404, body: { signal: 'NOT_FOUND' } };
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

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
      '/approval-capabilities': { status: 201, body: { capabilityId: 'cap-1', presentation: 'cap-1.s' } },
      '/approval-nonces': { status: 201, body: { nonce: 'n-1' } },
      '/gates/approve': {
        status: 200,
        body: { signal: 'GATE_APPROVED', machine: 'alpha', sessionId: 's1', approvedAt: '2026-08-30T01:00:00Z' },
      },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'plan-approval' });
    expect(result).toMatchObject({ ok: true, machine: 'alpha', sessionId: 's1' });
    expect(calls.map((call) => call.url.replace('/m/alpha/api/agent/v1', ''))).toEqual([
      '/approval-capabilities',
      '/approval-nonces',
      '/workspaces/L1VzZXJzL3gvZGV2L2NvZGV2/gates/approve',
    ]);
    expect(calls[1].body).toMatchObject({ projectId: '146', gateName: 'plan-approval', capabilityId: 'cap-1' });
    expect(calls[2].body).toMatchObject({ capability: 'cap-1.s', nonce: 'n-1' });
    for (const call of calls) expect(call.headers['x-codev-human-session']).toBe('s1.secret');
  });

  /* A capability is bound to the host that verifies it, so the client never
     names a machine. A route that refuses one must surface its reason. */
  it('stops at the first refusal and names which step refused', async () => {
    const { fetchImpl, calls } = router({
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
      '/approval-capabilities': { status, body: { signal, message: 'gone' } },
    });
    const result = await approveGate(fetchImpl, config, session, { projectId: '146', gateName: 'pr' });
    expect(result).toMatchObject({ ok: false, signal, sessionEnded: true });
  });

  it('does not call an ordinary refusal a dead session', async () => {
    const { fetchImpl } = router({
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
