import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const codevRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

describe('v2 packaging (D14)', () => {
  it('npm pack includes v2-dist after copy-v2', () => {
    execSync('pnpm copy-v2', {
      cwd: codevRoot,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const output = execSync('npm pack --dry-run 2>&1', {
      cwd: codevRoot,
      encoding: 'utf-8',
    });
    expect(output).toContain('v2-dist/index.html');
    expect(output).toContain('v2-dist/assets/');
  }, 180_000);
});

/**
 * The same assertion for the client, Spec 146 Phase 12.
 *
 * `client-dist` was added to `files` and to `bundle-assets` beside `v2-dist`,
 * and a `files` entry that resolves to nothing is silently absent from the
 * tarball — which is how a mount that works from a checkout ships broken. v2 has
 * had this check since D14; the client had none.
 */
describe('client packaging (Spec 146 Phase 12)', () => {
  it('npm pack includes client-dist after copy-client', () => {
    execSync('pnpm copy-client', {
      cwd: codevRoot,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const output = execSync('npm pack --dry-run 2>&1', {
      cwd: codevRoot,
      encoding: 'utf-8',
    });
    expect(output).toContain('client-dist/index.html');
    expect(output).toContain('client-dist/assets/');
  }, 180_000);
});
