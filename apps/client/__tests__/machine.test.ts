import { describe, expect, it, vi } from 'vitest';
import { connectMachine, encodeWorkspacePath, streamUrl, type MachineConfig, type MachineState } from '../src/connection/machine.js';

const config: MachineConfig = {
  id: 'alpha',
  label: 'alpha',
  origin: 'http://127.0.0.1:4100',
  workspacePath: '/Users/x/dev/codev',
  credential: 'cred-id.secret',
};

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const SNAPSHOT = {
  schemaVersion: 1,
  workspacePath: '/Users/x/dev/codev',
  generatedAt: '2026-08-29T12:00:00Z',
  protocol: { t3code: 'not-provided', architects: {}, builders: {}, identities: [], statuses: [], signals: [] },
};

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Collect states until the link settles, then stop it. */
async function drive(fetchImpl: typeof globalThis.fetch): Promise<MachineState[]> {
  const seen: MachineState[] = [];
  const link = connectMachine(config, {
    fetch: fetchImpl,
    now: () => '2026-08-29T12:00:01Z',
    onState: (state) => seen.push(state),
    backoffMs: [1],
    sleep: () => new Promise(() => {}),
  });
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1));
  link.stop();
  return seen;
}

describe('encodeWorkspacePath', () => {
  it('is base64url with no padding', () => {
    expect(encodeWorkspacePath('/Users/x')).toBe('L1VzZXJzL3g');
    expect(streamUrl(config)).toContain('/api/agent/v1/workspaces/');
    expect(streamUrl(config)).toMatch(/\/stream$/);
  });
});

describe('connectMachine', () => {
  /*
   * THE MACHINE CREDENTIAL AND NOTHING ELSE.
   *
   * An earlier version also sent Tower's shared `local-key`, which inverted the
   * point of the surface: that key cannot be revoked for one machine without
   * rotating it for all, so revoking a machine credential — criterion 15 —
   * would not have taken the access away, and an XSS would have held Tower-wide
   * privileges on every workspace on the host.
   */
  it('presents the machine credential, and no shared key', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-codev-machine-credential']).toBe('cred-id.secret');
      for (const name of Object.keys(headers)) {
        expect(name.toLowerCase()).not.toContain('tower');
      }
      return new Response(sseBody([frame('protocol-state', { snapshot: SNAPSHOT })]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    expect(seen.some((state) => state.status === 'live')).toBe(true);
  });

  it('stamps lastLiveAt on every snapshot', async () => {
    const fetchImpl = (async () =>
      new Response(sseBody([frame('protocol-state', { snapshot: SNAPSHOT })]), { status: 200 })
    ) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const live = seen.find((state) => state.status === 'live')!;
    expect(live.lastLiveAt).toBe('2026-08-29T12:00:01Z');
  });

  it('fails closed on 403 and does not retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.status).toBe('disconnected');
    expect(last.why).toBe('auth');
    expect(last.retrying).toBe(false);
  });

  it('fails closed when the credential is revoked mid-stream', async () => {
    const fetchImpl = (async () => new Response(sseBody([
      frame('protocol-state', { snapshot: SNAPSHOT }),
      frame('protocol-state-unauthorized', {
        type: 'STREAM_AUTHORIZATION_LOST',
        code: 'MACHINE_CREDENTIAL_REVOKED',
        message: 'that machine credential was revoked',
      }),
    ]), { status: 200 })) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.status).toBe('disconnected');
    expect(last.retrying).toBe(false);
    expect(last.message).toBe('that machine credential was revoked');
    // The subtree it already had is retained, and dated.
    expect(last.snapshot).not.toBeNull();
    expect(last.lastLiveAt).toBe('2026-08-29T12:00:01Z');
  });

  it('reports an unreachable server as disconnected, not as empty', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.status).toBe('disconnected');
    expect(last.why).toBe('transport');
    expect(last.snapshot).toBeNull();
    expect(last.message).toContain('ECONNREFUSED');
  });

  it('refuses a payload it cannot validate rather than rendering it', async () => {
    const fetchImpl = (async () => new Response(
      sseBody([frame('protocol-state', { snapshot: { schemaVersion: 2 } })]),
      { status: 200 },
    )) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.status).toBe('disconnected');
    expect(last.why).toBe('protocol');
  });
});

describe('silence', () => {
  it('calls a stream that says nothing disconnected rather than leaving it LIVE', async () => {
    // A body that opens, delivers one snapshot, and then never speaks again —
    // the shape a proxied connection takes when the server behind it dies.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame('protocol-state', { snapshot: SNAPSHOT })));
      },
    });
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { void body.cancel().catch(() => {}); });
      return new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const seen: MachineState[] = [];
    const link = connectMachine(config, {
      fetch: fetchImpl,
      now: () => '2026-08-29T12:00:01Z',
      onState: (state) => seen.push(state),
      backoffMs: [50_000],
      silenceMs: 20,
      sleep: () => new Promise(() => {}),
    });
    await vi.waitFor(() => expect(seen.some((s) => s.status === 'disconnected')).toBe(true), { timeout: 2000 });
    link.stop();
    const last = seen[seen.length - 1];
    expect(last.why).toBe('transport');
    expect(last.message).toContain('said nothing');
    // The tree it had is retained and dated, not blanked.
    expect(last.snapshot).not.toBeNull();
    expect(last.lastLiveAt).toBe('2026-08-29T12:00:01Z');
  });

  it('treats a heartbeat comment as proof of life', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(frame('protocol-state', { snapshot: SNAPSHOT })));
        for (let i = 0; i < 6; i += 1) {
          await new Promise((r) => setTimeout(r, 10));
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;
    const seen: MachineState[] = [];
    const link = connectMachine(config, {
      fetch: fetchImpl,
      onState: (state) => seen.push(state),
      backoffMs: [50_000],
      silenceMs: 40,
      sleep: () => new Promise(() => {}),
    });
    await new Promise((r) => setTimeout(r, 90));
    link.stop();
    expect(seen.some((s) => s.status === 'disconnected')).toBe(false);
    expect(seen[seen.length - 1].status).toBe('live');
  });
});

describe('a revoked credential is not a generic disconnect', () => {
  it('names revocation when the server refuses at the handshake', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({
        signal: 'MACHINE_CREDENTIAL_REVOKED',
        message: 'credential cred-1 was revoked at 2026-08-30T01:00:00Z',
      }),
      { status: 403 },
    )) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.why).toBe('revoked');
    expect(last.signal).toBe('MACHINE_CREDENTIAL_REVOKED');
    expect(last.retrying).toBe(false);
    expect(last.message).toContain('revoked');
  });

  it('names revocation when it happens mid-stream', async () => {
    const fetchImpl = (async () => new Response(sseBody([
      frame('protocol-state', { snapshot: SNAPSHOT }),
      frame('protocol-state-unauthorized', {
        type: 'STREAM_AUTHORIZATION_LOST',
        code: 'MACHINE_CREDENTIAL_REVOKED',
        message: 'that machine credential was revoked',
      }),
    ]), { status: 200 })) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.why).toBe('revoked');
    expect(last.signal).toBe('MACHINE_CREDENTIAL_REVOKED');
    expect(last.retrying).toBe(false);
  });

  /*
   * "I could not read the credential store" must not be spelled as "you were
   * revoked": one sends an operator to reissue, the other to look at a disk.
   */
  it('does not call an unreadable credential store a revocation', async () => {
    const fetchImpl = (async () => new Response(sseBody([
      frame('protocol-state-unauthorized', {
        type: 'STREAM_AUTHORIZATION_LOST',
        code: 'MACHINE_STORE_UNREADABLE',
        message: 'credential could not be re-checked',
      }),
    ]), { status: 200 })) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.why).not.toBe('revoked');
    expect(last.signal).toBe('MACHINE_STORE_UNREADABLE');
  });

  it('does not call an unauthenticated machine revoked', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ signal: 'MACHINE_CREDENTIAL_UNKNOWN', message: 'no such credential here' }),
      { status: 401 },
    )) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    expect(seen[seen.length - 1].why).toBe('auth');
    expect(seen[seen.length - 1].signal).toBe('MACHINE_CREDENTIAL_UNKNOWN');
  });
});

describe('a credential the host could not check', () => {
  /*
   * The host reached NO VERDICT. Failing the subtree closed over that states
   * something nobody established, and it stays failed after the condition
   * clears — the same defect as calling it revoked, with a longer tail.
   */
  it('keeps retrying an unreadable credential store and says it could not verify', async () => {
    const fetchImpl = (async () => new Response(sseBody([
      frame('protocol-state', { snapshot: SNAPSHOT }),
      frame('protocol-state-unauthorized', {
        type: 'STREAM_AUTHORIZATION_LOST',
        code: 'MACHINE_STORE_UNREADABLE',
        message: 'credential could not be re-checked',
      }),
    ]), { status: 200 })) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.why).toBe('indeterminate');
    expect(last.signal).toBe('MACHINE_STORE_UNREADABLE');
    expect(last.retrying).toBe(true);
  });

  it('keeps retrying a locked store presented at the handshake', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ signal: 'MACHINE_STORE_LOCKED', message: 'the store is locked' }),
      { status: 503 },
    )) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    expect(seen[seen.length - 1].retrying).toBe(true);
  });

  it('still refuses an unknown credential permanently', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ signal: 'MACHINE_CREDENTIAL_UNKNOWN', message: 'no such credential here' }),
      { status: 401 },
    )) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    expect(seen[seen.length - 1].why).toBe('auth');
    expect(seen[seen.length - 1].retrying).toBe(false);
  });
});

describe('a server that says it could not read some state', () => {
  /*
   * THE STREAM STAYS OPEN, SO NOTHING ELSE WOULD EVER CATCH THIS. Heartbeats
   * keep the silence deadline from firing, so a persistent read failure showed
   * an old tree under a LIVE badge indefinitely — the exact property the
   * disconnected state gets right, one branch over.
   */
  it('stops calling the tree live once the server reports a read failure', async () => {
    const fetchImpl = (async () => new Response(sseBody([
      frame('protocol-state', { snapshot: SNAPSHOT }),
      frame('protocol-state-error', {
        type: 'STATE_STREAM_WATCH_FAILED',
        signal: { code: 'STATUS_UNREADABLE', message: 'status.yaml cannot be read: EACCES' },
        code: 'STATUS_UNREADABLE',
        message: 'status.yaml cannot be read: EACCES',
      }),
      ': heartbeat\n\n',
    ]), { status: 200 })) as unknown as typeof globalThis.fetch;

    const seen: MachineState[] = [];
    const link = connectMachine(config, {
      fetch: fetchImpl,
      now: () => '2026-08-29T12:00:01Z',
      onState: (state) => seen.push(state),
      backoffMs: [50_000],
      sleep: () => new Promise(() => {}),
    });
    await vi.waitFor(() => expect(seen.some((s) => s.status === 'degraded')).toBe(true));
    link.stop();

    const degraded = seen.find((s) => s.status === 'degraded')!;
    expect(degraded.message).toContain('EACCES');
    expect(degraded.signal).toBe('STATUS_UNREADABLE');
    // The tree is retained and dated, and the date is NOT advanced past the last
    // complete snapshot.
    expect(degraded.snapshot).not.toBeNull();
    expect(degraded.lastLiveAt).toBe('2026-08-29T12:00:01Z');
  });

  it('returns to live when a good snapshot arrives after the failure', async () => {
    const fetchImpl = (async () => new Response(sseBody([
      frame('protocol-state', { snapshot: SNAPSHOT }),
      frame('protocol-state-error', { code: 'STATUS_UNREADABLE', message: 'transient' }),
      frame('protocol-state', { snapshot: SNAPSHOT }),
    ]), { status: 200 })) as unknown as typeof globalThis.fetch;

    const seen: MachineState[] = [];
    const link = connectMachine(config, {
      fetch: fetchImpl,
      onState: (state) => seen.push(state),
      backoffMs: [50_000],
      sleep: () => new Promise(() => {}),
    });
    await vi.waitFor(() => {
      const degradedAt = seen.findIndex((s) => s.status === 'degraded');
      expect(degradedAt).toBeGreaterThanOrEqual(0);
      expect(seen.slice(degradedAt).some((s) => s.status === 'live')).toBe(true);
    });
    link.stop();
    // The recovery clears the reason, rather than leaving a stale explanation
    // sitting under a LIVE badge.
    const degradedAt = seen.findIndex((state) => state.status === 'degraded');
    const recovered = seen.slice(degradedAt).find((state) => state.status === 'live')!;
    expect(recovered.message).toBeNull();
    expect(recovered.signal).toBeNull();
  });
});

describe('reconnect backoff', () => {
  /*
   * THE RESET WAS UNREACHABLE. It tested `state.status === 'live'` after
   * `openOnce` returned, and `openOnce` always sets the status to `disconnected`
   * before returning — so the delay only ever grew, and a machine that blipped a
   * few times over an afternoon waited the maximum before every reconnect.
   */
  /*
   * THE FIRST VERSION OF THIS TEST AGREED WITH THE BUG. It asserted
   * `[1, 2, 4, 1, 2]` while its comment said the progressing attempt resets —
   * and 4 is exactly the penalty earned by the two failures BEFORE it, served
   * out after the reset. The expectation encoded the defect and the prose
   * described the fix, which is worse than no test, because it makes the next
   * reader confident.
   *
   * A connection that worked and dropped waits the FIRST step. The ladder grows
   * only across consecutive failures.
   */
  it('waits the first step after an attempt that received a snapshot', async () => {
    const delays: number[] = [];
    let attemptNo = 0;
    // Attempts 1 and 2 fail outright; 3 delivers a snapshot then ends; 4 and 5
    // fail again.
    const fetchImpl = (async () => {
      attemptNo += 1;
      if (attemptNo === 3) {
        return new Response(sseBody([frame('protocol-state', { snapshot: SNAPSHOT })]), { status: 200 });
      }
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const link = connectMachine(config, {
      fetch: fetchImpl,
      onState: () => {},
      backoffMs: [1, 2, 4, 8],
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length >= 5) await new Promise(() => {});
      },
    });
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(5));
    link.stop();

    // fail, fail → steps 1 and 2. Progress → back to the first step, 1, NOT the
    // 4 the earlier failures had earned. Then fail, fail → 1, 2 again.
    expect(delays.slice(0, 5)).toEqual([1, 2, 1, 1, 2]);
  });

  it('climbs the ladder across consecutive failures and stops at the cap', async () => {
    const delays: number[] = [];
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch;
    const link = connectMachine(config, {
      fetch: fetchImpl,
      onState: () => {},
      backoffMs: [1, 2, 4, 8],
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length >= 5) await new Promise(() => {});
      },
    });
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(5));
    link.stop();
    expect(delays.slice(0, 5)).toEqual([1, 2, 4, 8, 8]);
  });
});

describe('an older server', () => {
  /*
   * A server that predates the session-state field wants UPGRADING; a corrupt
   * payload wants investigating. Rendering both as "this client does not
   * understand" sends the operator to the wrong place.
   */
  it('is told apart from a corrupt payload, and says which', async () => {
    const older = JSON.parse(JSON.stringify(SNAPSHOT)) as Record<string, unknown>;
    delete (older.protocol as Record<string, unknown>).t3code;
    const fetchImpl = (async () => new Response(
      sseBody([frame('protocol-state', { snapshot: older })]),
      { status: 200 },
    )) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    const last = seen[seen.length - 1];
    expect(last.why).toBe('protocol');
    expect(last.signal).toBe('SNAPSHOT_SCHEMA_OLDER');
    expect(last.message).toContain('Upgrade');
  });

  it('still calls a corrupt payload unreadable', async () => {
    const fetchImpl = (async () => new Response(
      sseBody([frame('protocol-state', { snapshot: { schemaVersion: 2 } })]),
      { status: 200 },
    )) as unknown as typeof globalThis.fetch;
    const seen = await drive(fetchImpl);
    expect(seen[seen.length - 1].signal).toBe('SNAPSHOT_UNREADABLE');
    expect(seen[seen.length - 1].message).toContain('does not understand');
  });
});
