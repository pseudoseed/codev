import { describe, expect, it } from 'vitest';
import { loadMachines } from '../src/config.js';

const VALID = {
  id: 'a', label: 'a', origin: 'http://127.0.0.1:4100', workspacePath: '/w', credential: 'i.s',
};

function respond(body: unknown, status = 200): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;
}

describe('loadMachines', () => {
  it('reads a list of machines', async () => {
    const result = await loadMachines(respond([VALID, { ...VALID, id: 'b' }]));
    expect(result.ok && result.machines).toHaveLength(2);
  });

  it('drops and counts a machine it cannot use', async () => {
    const result = await loadMachines(respond([VALID, { id: 'b' }]));
    expect(result.ok && result.machines).toHaveLength(1);
    expect(result.ok && result.dropped).toBe(1);
  });

  it('does not report an unreadable configuration as an empty one', async () => {
    const failed = await loadMachines(respond({}, 500));
    expect(failed.ok).toBe(false);
    const empty = await loadMachines(respond([]));
    expect(empty.ok && empty.machines).toEqual([]);
  });
});
