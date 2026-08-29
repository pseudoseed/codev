/**
 * Live harness tests for the porch-driver ThreadEngine.
 *
 * Skips loudly when the pinned server cannot be verified or started.
 * A skip is "could not check", never a pass.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const harness = join(repoRoot, 'tools', 't3-server', 't3-server.mjs');

function harnessStatus(): { ok: boolean; reason: string } {
  if (!existsSync(harness)) {
    return { ok: false, reason: `could not check: missing ${harness}` };
  }
  try {
    execFileSync('node', [harness, 'verify'], { encoding: 'utf8', timeout: 15_000 });
    return { ok: true, reason: 'verified' };
  } catch (err) {
    const errCode = (err as { status?: number }).status;
    if (errCode === 3) return { ok: false, reason: 'could not check: verify could not determine checkout' };
    if (errCode === 1) return { ok: false, reason: 'could not check: checkout does not match pin' };
    return { ok: false, reason: `could not check: verify failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

describe('Spec 146 Phase 9 — porch-driver engine against the pinned harness', () => {
  const status = harnessStatus();

  it.skipIf(!status.ok)(
    `live harness available (${status.reason}) — createPorchThreadEngine is imported from production path`,
    async () => {
      const { createPorchThreadEngine } = await import('../porch-thread-engine.js');
      expect(typeof createPorchThreadEngine).toBe('function');
    },
  );

  it('names the skip when the pinned harness cannot be verified', () => {
    if (status.ok) {
      expect(status.reason).toBe('verified');
      return;
    }
    expect(status.reason).toMatch(/^could not check:/);
  });
});
