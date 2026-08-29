import { describe, expect, it, vi } from 'vitest';
import { THREAD_BACKED_UNSUPPORTED } from '../thread-runtime.js';

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

describe('Spec 146 Phase 9 — render gate refuses thread-backed agents', () => {
  it('resolveLiveSessionForAgent throws thread-backed, unsupported here', () => {
    expect(() => resolveLiveSessionForAgent('/ws', 'thread-builder'))
      .toThrow(THREAD_BACKED_UNSUPPORTED);
  });

  it('resolveLiveSessionForAgent does not throw for an agent with no threadId', () => {
    expect(resolveLiveSessionForAgent('/ws', 'pty-builder')).toBeNull();
  });
});
