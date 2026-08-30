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

const requestThreadBackend = vi.fn();
const deliverThreadTurn = vi.fn();
const attach = vi.fn();
const getThreadEngine = vi.fn();

vi.mock('../thread-backend.js', () => ({
  requestThreadBackend: (...args: unknown[]) => requestThreadBackend(...args),
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
    requestThreadBackend.mockReturnValue({ kind: 'ready' });
  });

  it('delivers from a process holding no engine, and says nothing while doing it', async () => {
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(true);

    // Both, in this order. Without the first, Tower has no engine; without the
    // second, the engine has never heard of the thread.
    expect(requestThreadBackend).toHaveBeenCalledWith('/ws');
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
    requestThreadBackend.mockReturnValue({ kind: 'not-configured' });
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(false);

    expect(logs.join('\n')).toContain('names no t3code server');
    expect(deliverThreadTurn).not.toHaveBeenCalled();
  });

  /**
   * Round 5. Tower's drainer awaits agents sequentially, so awaiting a connect here
   * stalled delivery for every agent in every workspace — including PTY-only ones that
   * never opted into threads. The bound that makes the connect safe is exactly what makes
   * the stall long.
   *
   * `requestThreadBackend` is synchronous by construction, which is the fix: there is no
   * promise on this path to await. The assertion is that a not-ready workspace costs the
   * tick nothing and is not an alarm.
   */
  it('a connect in progress holds the row without waiting for it, and is not an error', async () => {
    requestThreadBackend.mockReturnValue({ kind: 'connecting' });
    const logs: string[] = [];
    const levels: string[] = [];
    const ports = makeDeliveryPorts((level, message) => {
      levels.push(level);
      logs.push(message);
    });

    const started = Date.now();
    await expect(ports.writeMessage(threadDeliverySession('thr-1', CONTEXT), 'hello', false))
      .resolves.toBe(false);

    expect(Date.now() - started).toBeLessThan(200);
    expect(logs.join('\n')).toContain('still connecting');
    // Ordinary, not a fault: an ERROR here would alarm on every tick of a normal startup.
    expect(levels).toEqual(['INFO']);
    expect(attach).not.toHaveBeenCalled();
  });

  it('a workspace in connect backoff says so, and says why it is not retrying', async () => {
    requestThreadBackend.mockReturnValue({
      kind: 'cooling-down',
      since: Date.now() - 5_000,
      message: 'could not be reached: ECONNREFUSED',
    });
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(false);

    expect(logs.join('\n')).toContain('ECONNREFUSED');
    expect(logs.join('\n')).toContain('bootstrap token that may be one-time');
    // Distinct from "still connecting": one resolves on its own, the other does not.
    expect(logs.join('\n')).not.toContain('still connecting');
    expect(attach).not.toHaveBeenCalled();
  });

  it('a half-configured workspace is a mistake, not a connect failure', async () => {
    requestThreadBackend.mockReturnValue({ kind: 'misconfigured', message: 'serverUrl=set, bootstrapToken=missing' });
    const { logs, run } = deliver(threadDeliverySession('thr-1', CONTEXT));

    await expect(run()).resolves.toBe(false);

    expect(logs.join('\n')).toContain('incomplete');
    expect(logs.join('\n')).toContain('nothing was attempted');
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
    expect(requestThreadBackend).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('refusing a --no-enter message');
    expect(logs.join('\n')).toContain('has no composer');
    // The comment and the log must agree with what the caller actually does, which is
    // to end the row rather than hold it.
    expect(logs.join('\n')).toContain('terminally rather than holding it');
    expect(logs.join('\n')).not.toContain('row stays held rather than being executed');
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
    expect(requestThreadBackend).not.toHaveBeenCalled();
  });

  /**
   * The failure sentences differ from each other. Tests each asserting their own string
   * would not prove that — this compares them.
   */
  it('no two not-delivered states share a message', async () => {
    const messages: string[] = [];
    const capture = async (arrange: () => void) => {
      vi.clearAllMocks();
      getThreadEngine.mockReturnValue({ attach });
      attach.mockResolvedValue({});
      deliverThreadTurn.mockResolvedValue(undefined);
      requestThreadBackend.mockReturnValue({ kind: 'ready' });
      arrange();
      // Every level, not only ERROR: `connecting` logs at INFO precisely because it is
      // ordinary, and it still has to be distinguishable from the rest.
      const lines: string[] = [];
      const ports = makeDeliveryPorts((_level, message) => lines.push(message));
      await ports.writeMessage(threadDeliverySession('thr-1', CONTEXT), 'hello', false);
      messages.push(lines.join());
    };

    await capture(() => requestThreadBackend.mockReturnValue({ kind: 'not-configured' }));
    await capture(() => requestThreadBackend.mockReturnValue({ kind: 'connecting' }));
    await capture(() =>
      requestThreadBackend.mockReturnValue({ kind: 'cooling-down', since: Date.now() - 1000, message: 'down' }));
    await capture(() =>
      requestThreadBackend.mockReturnValue({ kind: 'misconfigured', message: 'half' }));
    await capture(() => attach.mockRejectedValue(new Error('nope')));
    await capture(() => deliverThreadTurn.mockRejectedValue(new Error('nope')));

    expect(messages).toHaveLength(6);
    expect(new Set(messages).size).toBe(6);
    for (const message of messages) expect(message).not.toBe('');
  });
});
