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

describe('machine ids', () => {
  /*
   * The id keys connection state, the human session, React's reconciliation, the
   * approval lookup and the `/m/<id>/` path. Two entries sharing one do not
   * merely collide — a session opened against the first would be presented to
   * the second.
   */
  it('keeps the first of a duplicated id and counts the rest as dropped', async () => {
    const result = await loadMachines(respond([
      { ...VALID, id: 'alpha', origin: 'http://first' },
      { ...VALID, id: 'alpha', origin: 'http://second' },
    ]));
    expect(result.ok && result.machines).toHaveLength(1);
    expect(result.ok && result.machines[0].origin).toBe('http://first');
    expect(result.ok && result.dropped).toBe(1);
  });

  it.each([
    ['empty', ''],
    ['a path traversal', '../etc'],
    ['a slash', 'a/b'],
    ['whitespace', 'a b'],
    ['a leading dot', '.hidden'],
    ['too long', 'a'.repeat(65)],
  ])('rejects %s as an id', async (_name, id) => {
    const result = await loadMachines(respond([{ ...VALID, id }]));
    expect(result.ok && result.machines).toHaveLength(0);
    expect(result.ok && result.dropped).toBe(1);
  });

  it.each(['label', 'origin', 'workspacePath', 'credential'])('rejects an empty %s', async (field) => {
    const result = await loadMachines(respond([{ ...VALID, [field]: '' }]));
    expect(result.ok && result.machines).toHaveLength(0);
  });

  it('accepts the ids the dev tooling and pairing actually produce', async () => {
    for (const id of ['alpha', 'beta', 'dev-local', 'local', 'mac_mini.2', 'A1']) {
      const result = await loadMachines(respond([{ ...VALID, id }]));
      expect(result.ok && result.machines, id).toHaveLength(1);
    }
  });
});
