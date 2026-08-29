import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let packDirectory: string;
let packedFiles: string[];

beforeAll(() => {
  packDirectory = mkdtempSync(join(tmpdir(), 'codev-extension-retirement-'));
  execFileSync('npm', ['pack', '--pack-destination', packDirectory], {
    cwd: workspaceRoot,
    stdio: 'pipe',
  });

  const tarball = readdirSync(packDirectory).find((file) => file.endsWith('.tgz'));
  expect(tarball).toBeDefined();
  packedFiles = execFileSync('tar', ['-tzf', join(packDirectory, tarball!)], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
});

afterAll(() => {
  rmSync(packDirectory, { recursive: true, force: true });
});

describe('extension retirement', () => {
  it('deletes the Stream Deck source tree rather than merely excluding its package', () => {
    expect(existsSync(join(workspaceRoot, 'apps/streamdeck'))).toBe(false);
  });

  it('removes both extensions from active release automation and instructions', () => {
    expect(existsSync(join(workspaceRoot, 'scripts/bump-vscode.sh'))).toBe(false);
    expect(existsSync(join(workspaceRoot, '.github/workflows/sdk-canary.yml'))).toBe(false);

    const releaseSurfaces = [
      'scripts/bump-all.sh',
      'codev/protocols/release/protocol.md',
      'docs/releases/UNRELEASED.md',
      'docs/releases/UNRELEASED.template.md',
      '.github/workflows/test.yml',
    ];

    for (const path of releaseSurfaces) {
      const content = readFileSync(join(workspaceRoot, path), 'utf8');
      expect(content, path).not.toMatch(/apps\/vscode|streamdeck|bump-vscode|sdk-canary/i);
    }
  });

  it('keeps supported apps in the pnpm workspace and excludes the VS Code extension', () => {
    const members = JSON.parse(
      execFileSync('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], {
        cwd: workspaceRoot,
        encoding: 'utf8',
      }),
    ) as Array<{ name?: string }>;
    const names = members.flatMap(({ name }) => (name ? [name] : []));

    expect(names).toContain('@cluesmith/codev-web');
    expect(names).toContain('@cluesmith/codev-v2');
    expect(names).not.toContain('codev-vscode');
    expect(names).not.toContain('@cluesmith/codev-streamdeck');
  });

  it('packs neither retired extension while retaining supported apps', () => {
    expect(packedFiles).toContain('package/apps/web/package.json');
    expect(packedFiles).toContain('package/apps/v2/package.json');
    expect(packedFiles.some((file) => file.startsWith('package/apps/vscode/'))).toBe(false);
    expect(packedFiles.some((file) => file.startsWith('package/apps/streamdeck/'))).toBe(false);
  });

  it('packs packages/porch-driver/dist/thread.js so the phase-9 adapter import is in the tarball', () => {
    expect(packedFiles).toContain('package/packages/porch-driver/dist/thread.js');
  });

  it('marks the retained VS Code source unsupported', () => {
    const readme = readFileSync(join(workspaceRoot, 'apps/vscode/README.md'), 'utf8');
    expect(readme).toContain('**Unsupported.**');
    expect(readme).toContain('no longer built, tested, packaged, or released');
  });
});
