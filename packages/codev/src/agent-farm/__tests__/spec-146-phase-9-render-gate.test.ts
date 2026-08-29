import { describe, expect, it, vi } from 'vitest';
import { isThreadDeliverySession } from '../servers/mailbox-delivery.js';

vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    getBuilder: (id: string) => (
      id === 'thread-builder' ? { id, threadId: 'thr-1', terminalId: undefined } : null
    ),
    getArchitectByName: () => null,
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
