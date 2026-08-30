/**
 * Issue #219 — thread delivery from a process that did not create the thread.
 *
 * `makeDeliveryPorts().writeMessage` used to be:
 *
 *     try { await deliverThreadTurn(...); return true } catch { return false }
 *
 * Tower is a separate, long-lived process and registers no engine, so
 * `deliverThreadTurn` threw there for every thread-backed row and that `catch`
 * turned it into a held message with no explanation. A workspace that configured
 * threads traded a working Tower architect for one that could never receive mail.
 *
 * Two things are asserted here. First that the happy path now WORKS from a process
 * with no engine — it registers one and adopts the thread. Second that the four ways
 * it fails no longer leave through the same silence: the held-reason vocabulary is
 * fixed at three values by a CHECK constraint on the mailbox table, so all four still
 * hold the row, but each names itself in the log, because "Tower has no engine" is a
 * bug in this repo and "the server refused the turn" is not.
 *
 * The live counterpart is `spec-146-phase-9-live-architect-thread.test.ts`, which
 * runs this same port in a real child process against a real server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureThreadBackendReady = vi.fn();
const deliverThreadTurn = vi.fn();
const attach = vi.fn();
const getThreadEngine = vi.fn();

vi.mock('../thread-backend.js', () => ({
  ensureThreadBackendReady: (...args: unknown[]) => ensureThreadBackendReady(...args),
}));

vi.mock('../thread-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../thread-runtime.js')>();
  return {
    ...actual,
    deliverThreadTurn: (...args: unknown[]) => deliverThreadTurn(...args),
    getThreadEngine: (...args: unknown[]) => getThreadEngine(...args),
  };
});

const { makeDeliveryPorts } = await import('../servers/mailbox-wiring.js');
const { threadDeliverySession } = await import('../servers/mailbox-delivery.js');

const CONTEXT = {
  workspaceRoot: '/ws',
  worktreePath: '/ws',
  branch: '',
  agent: 'architect-main',
};

function deliver(session: ReturnType<typeof threadDeliverySession>) {
  const logs: string[] = [];
  const ports = makeDeliveryPorts((level, message) => {
    if (level !== 'INFO') logs.push(`${level}: ${message}`);
  });
  return { logs, run: () => ports.writeMessage(session, 'hello', false) };
}

describe('thread delivery registers an engine and adopts the thread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getThreadEngine.mockReturnValue({ attach });
    attach.mockResolvedValue({});
    deliverThreadTurn.mockResolvedValue(undefined);
    ensureThreadBackendReady.mockResolvedValue('installed');
  });

  it('delivers from a process holding no engine, and says nothing while doing it', async () => {
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(true);

    // Both, in this order. Without the first, Tower has no engine; without the
    // second, the engine has never heard of the thread.
    expect(ensureThreadBackendReady).toHaveBeenCalledWith('/ws');
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thr-1', worktreePath: '/ws', branch: '', builderId: 'architect-main' }),
    );
    // For THIS workspace. Tower serves every workspace in `global.db` from one process.
    expect(getThreadEngine).toHaveBeenCalledWith('/ws');
    expect(deliverThreadTurn).toHaveBeenCalledWith('thr-1', 'hello', '/ws');
    // A success that logs a failure sentence is the shape this replaced.
    expect(logs).toEqual([]);
  });

  it('a thread-backed row in an unconfigured workspace names the contradiction', async () => {
    ensureThreadBackendReady.mockResolvedValue('not-configured');
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(false);

    expect(logs.join('\n')).toContain('names no t3code server');
    expect(deliverThreadTurn).not.toHaveBeenCalled();
  });

  it('an unreachable server is not spelled like a refused turn', async () => {
    ensureThreadBackendReady.mockRejectedValue(new Error('ECONNREFUSED'));
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(false);

    expect(logs.join('\n')).toContain('could not register a thread engine in this process');
    expect(logs.join('\n')).not.toContain('refused the turn');
    expect(attach).not.toHaveBeenCalled();
  });

  it('a thread this process cannot adopt is not reported as a missing thread', async () => {
    attach.mockRejectedValue(new Error('no mapping for harness'));
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(false);

    expect(logs.join('\n')).toContain('could not adopt the thread in this process');
    expect(logs.join('\n')).toContain('not evidence that the thread is gone');
    expect(deliverThreadTurn).not.toHaveBeenCalled();
  });

  it('a refused turn says the thread WAS reached', async () => {
    deliverThreadTurn.mockRejectedValue(new Error('turn rejected'));
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(false);

    expect(logs.join('\n')).toContain('the server refused the turn');
  });

  /**
   * `--no-enter` means "put this in the composer and leave it for a human". A thread has
   * no composer: `thread.turn.start` IS the submit. The flag was received here and
   * discarded, so a gate notification sent with `--no-enter` — the deliberate form, the
   * one that exists so a human decides — executed itself on a thread-backed agent.
   *
   * A message that does not arrive is the failure this project spent two days on. A
   * message that arrives and runs itself is the worse half of it.
   */
  it('refuses a --no-enter message instead of silently submitting it', async () => {
    const logs: string[] = [];
    const ports = makeDeliveryPorts((level, message) => {
      if (level !== 'INFO') logs.push(`${level}: ${message}`);
    });

    await expect(ports.writeMessage(threadDeliverySession('thr-1', CONTEXT), 'gate reached', true))
      .resolves.toBe(false);

    // Not delivered, and not by accident of some earlier failure: nothing was even
    // attempted, so there is no path by which the turn could have started.
    expect(deliverThreadTurn).not.toHaveBeenCalled();
    expect(ensureThreadBackendReady).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('refusing a --no-enter message');
    expect(logs.join('\n')).toContain('has no composer');
  });

  it('an ordinary message is unaffected by that refusal', async () => {
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));
    await expect(run()).resolves.toBe(true);
    expect(deliverThreadTurn).toHaveBeenCalledWith('thr-1', 'hello', '/ws');
    expect(logs).toEqual([]);
  });

  it('a session with no context names a wiring fault rather than blaming the server', async () => {
    const { logs, run } = deliver(threadDeliverySession('thr-1'));

    await expect(run()).resolves.toBe(false);

    expect(logs.join('\n')).toContain('carries no thread context');
    expect(ensureThreadBackendReady).not.toHaveBeenCalled();
  });

  /**
   * Four failures, four sentences, and the point is that they differ. Four tests
   * each asserting their own string would not prove that — this compares them.
   */
  it('no two failure states share a message', async () => {
    const messages: string[] = [];

    ensureThreadBackendReady.mockResolvedValue('not-configured');
    let d = deliver(threadDeliverySession('thr-1', CONTEXT));
    await d.run();
    messages.push(d.logs.join());

    ensureThreadBackendReady.mockRejectedValue(new Error('ECONNREFUSED'));
    d = deliver(threadDeliverySession('thr-1', CONTEXT));
    await d.run();
    messages.push(d.logs.join());

    ensureThreadBackendReady.mockResolvedValue('installed');
    attach.mockRejectedValue(new Error('nope'));
    d = deliver(threadDeliverySession('thr-1', CONTEXT));
    await d.run();
    messages.push(d.logs.join());

    attach.mockResolvedValue({});
    deliverThreadTurn.mockRejectedValue(new Error('nope'));
    d = deliver(threadDeliverySession('thr-1', CONTEXT));
    await d.run();
    messages.push(d.logs.join());

    expect(messages).toHaveLength(4);
    expect(new Set(messages).size).toBe(4);
    for (const message of messages) expect(message).not.toBe('');
  });
});
