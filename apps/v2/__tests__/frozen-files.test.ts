import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const FROZEN = [
  'apps/web',
  'apps/vscode',
  'apps/streamdeck',
  'packages/codev/templates/tower.html',
  'packages/codev/src/agent-farm/servers/tower-server.ts',
  'packages/codev/src/agent-farm/servers/tower-routes.ts',
  'packages/codev/src/terminal/pty-session.ts',
  'packages/codev/src/agent-farm/servers/v2-events.ts',
  'packages/codev/src/agent-farm/servers/v2-sampler.ts',
  'packages/codev/src/agent-farm/servers/v2-projection.ts',
  'packages/codev/src/agent-farm/servers/v2-status.ts',
  'packages/codev/src/agent-farm/servers/v2-ids.ts',
  'packages/types/src/v2-events.ts',
];

describe('frozen files (scenario 11)', () => {
  it('git diff --stat is empty on every C1/C2 path', () => {
    const committed = execFileSync('git', ['diff', '--stat', 'origin/main...HEAD', '--', ...FROZEN], {
      encoding: 'utf8',
    });
    const worktree = execFileSync('git', ['diff', '--stat', '--', ...FROZEN], { encoding: 'utf8' });
    expect(committed.trim()).toBe('');
    expect(worktree.trim()).toBe('');
  });
});
