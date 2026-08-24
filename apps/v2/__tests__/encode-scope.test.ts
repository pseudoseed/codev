import { describe, it, expect } from 'vitest';
import { encodeScope } from '../src/lib/encode-scope.js';

describe('encodeScope (scenario 18)', () => {
  it('joins per-path encodings with a literal comma', () => {
    const got = encodeScope(['/a,b', '/c']);
    expect(got).toBe(`${encodeURIComponent('/a,b')},${encodeURIComponent('/c')}`);
    expect(got).not.toBe(encodeURIComponent(['/a,b', '/c'].join(',')));
    expect(got).toBe('%2Fa%2Cb,%2Fc');
    expect(encodeURIComponent(['/a,b', '/c'].join(','))).toBe('%2Fa%2Cb%2C%2Fc');
  });

  it('round-trips through parseScope split-then-decode', () => {
    const paths = ['/tmp/ws-a', '/tmp/ws-b'];
    const encoded = encodeScope(paths);
    const decoded = encoded.split(',').map((p) => decodeURIComponent(p));
    expect(decoded).toEqual(paths);
    const wrong = encodeURIComponent(paths.join(','));
    expect(wrong.split(',').map((p) => decodeURIComponent(p))).toEqual([paths.join(',')]);
  });
});
