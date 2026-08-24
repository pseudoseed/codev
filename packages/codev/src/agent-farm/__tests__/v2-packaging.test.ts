import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const codevRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

describe('v2 packaging (D14)', () => {
  it('npm pack includes v2-dist after copy-v2', () => {
    execSync('pnpm copy-v2', { cwd: codevRoot, stdio: 'pipe' });
    const output = execSync('npm pack --dry-run 2>&1', {
      cwd: codevRoot,
      encoding: 'utf-8',
    });
    expect(output).toContain('v2-dist/index.html');
    expect(output).toContain('v2-dist/assets/');
  }, 180_000);
});
