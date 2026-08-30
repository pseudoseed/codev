import { describe, expect, it, vi } from 'vitest';
import { isThreadDeliverySession } from '../servers/mailbox-delivery.js';

vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    getBuilder: (id: string) => (
      id.startsWith('thread-') ? { id, threadId: 'thr-1', terminalId: undefined } : null
    ),
    getArchitectByName: () => null,
  };
});

/** Terminal ids per agent, so a test can put a live PTY beside a thread id. */
const terminals = new Map<string, string>();
const ptySessions = new Map<string, { writable: boolean }>();

vi.mock('../servers/tower-terminals.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceTerminals: () => new Map([
      ['/ws', { builders: terminals, architects: new Map(), shells: new Map() }],
    ]),
    getTerminalManager: () => ({
      getSession: (id: string) => ptySessions.get(id) ?? null,
    }),
  };
});

const { resolveLiveSessionForAgent } = await import('../servers/mailbox-wiring.js');

describe('Spec 146 Phase 9 — resolveLiveSessionForAgent returns a thread transport', () => {
  it('resolveLiveSessionForAgent returns a thread delivery session for a thread-backed builder', () => {
    const session = resolveLiveSessionForAgent('/ws', 'thread-builder');
    expect(session).not.toBeNull();
    expect(isThreadDeliverySession(session!)).toBe(true);
    expect(session!.threadId).toBe('thr-1');
  });

  it('resolveLiveSessionForAgent returns null for an agent with no threadId and no PTY', () => {
    expect(resolveLiveSessionForAgent('/ws', 'pty-builder')).toBeNull();
  });
});

/**
 * Issue #219 round 6. The thread branch won unconditionally, so a STALE `thread_id` on a
 * row silently shadowed a live PTY: the agent was there, and its mail went to a thread
 * that no longer served it. Low probability, completely silent — the combination this
 * project keeps paying for.
 *
 * The two identities are mutually exclusive by construction (`assertExclusiveIdentity`),
 * so both being present is a contradiction in the state, not a preference to express.
 */
describe('a stale thread id does not silently shadow a live PTY', () => {
  it('delivers to the PTY, and says the state is contradictory', () => {
    terminals.set('thread-and-pty', 'term-1');
    ptySessions.set('term-1', { writable: true });
    const logs: string[] = [];
    try {
      const session = resolveLiveSessionForAgent('/ws', 'thread-and-pty', (level, message) =>
        logs.push(`${level}: ${message}`));

      expect(session).not.toBeNull();
      expect(isThreadDeliverySession(session!)).toBe(false);
      // Not resolved in silence: one of the two identities is wrong, and an operator has
      // to be able to find out which.
      expect(logs.join('\n')).toContain('BOTH a thread id');
      expect(logs.join('\n')).toContain('mutually exclusive');
    } finally {
      terminals.clear();
      ptySessions.clear();
    }
  });

  it('a thread id with no live PTY still resolves to the thread, and says nothing', () => {
    // The control. Without it the rule above would hold just as well if the thread path
    // had been broken outright.
    const logs: string[] = [];
    const session = resolveLiveSessionForAgent('/ws', 'thread-builder', (level, message) =>
      logs.push(`${level}: ${message}`));

    expect(isThreadDeliverySession(session!)).toBe(true);
    expect(logs).toEqual([]);
  });

  it('a PTY entry whose session is not writable is not a live PTY', () => {
    terminals.set('thread-and-dead-pty', 'term-dead');
    ptySessions.set('term-dead', { writable: false });
    const logs: string[] = [];
    try {
      const session = resolveLiveSessionForAgent('/ws', 'thread-and-dead-pty', (level, message) =>
        logs.push(`${level}: ${message}`));

      // A torn-down PTY is not evidence of anything, so it must not displace the thread.
      expect(isThreadDeliverySession(session!)).toBe(true);
      expect(logs).toEqual([]);
    } finally {
      terminals.clear();
      ptySessions.clear();
    }
  });
});
