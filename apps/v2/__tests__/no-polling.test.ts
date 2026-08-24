import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.[cm]?tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe('no polling (scenario 9)', () => {
  it('has zero setInterval and one setTimeout at reconnectBackoff', () => {
    const files = walk(srcRoot);
    const intervalHits: string[] = [];
    const timeoutHits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/\bsetInterval\b/.test(text)) intervalHits.push(f);
      if (/\bsetTimeout\b/.test(text)) timeoutHits.push(f);
    }
    expect(intervalHits).toEqual([]);
    expect(timeoutHits).toHaveLength(1);
    expect(timeoutHits[0].endsWith(`${path.sep}stream.ts`)).toBe(true);
    const text = readFileSync(timeoutHits[0], 'utf8');
    expect(text).toMatch(/function reconnectBackoff\(/);
    expect(text).toMatch(/return setTimeout\(cb, ms\)/);
  });
});
