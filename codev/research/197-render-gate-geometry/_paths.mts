/**
 * Shared path resolution for the Issue #197 measurement scripts, so they run from a checkout
 * rather than only from the worktree they were written in.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here })
  .toString()
  .trim();
export const SRC = join(REPO, 'packages/codev/src');
export const FIXTURES = join(SRC, 'agent-farm/__tests__/fixtures/gate');
