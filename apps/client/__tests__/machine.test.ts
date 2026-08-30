import { describe, expect, it, vi } from 'vitest';
import { connectMachine, encodeWorkspacePath, streamUrl, type MachineConfig, type MachineState } from '../src/connection/machine.js';

const config: MachineConfig = {
  id: 'alpha',
  label: 'alpha',
  origin: 'http://127.0.0.1:4100',
  workspacePath: '/Users/x/dev/codev',
  credential: 'cred-id.secret',
  towerKey: 'k'.repeat(64),
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
  it('presents the machine credential and the tower key', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-codev-machine-credential']).toBe('cred-id.secret');
      expect(headers['codev-tower-key']).toBe('k'.repeat(64));
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
