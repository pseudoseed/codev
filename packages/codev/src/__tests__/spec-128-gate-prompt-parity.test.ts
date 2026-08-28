import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodevIncludes } from '../lib/skeleton.js';
import { buildPromptFromTemplate, type TemplateContext } from '../agent-farm/commands/spawn-roles.js';
import type { Config } from '../agent-farm/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const include = '{{> protocols/shared/gate-request.md}}';

const phasePrompts = [
  'spir/prompts/specify.md',
  'spir/prompts/plan.md',
  'spir/prompts/review.md',
  'pir/prompts/plan.md',
  'pir/prompts/implement.md',
  'pir/prompts/review.md',
  'aspir/prompts/review.md',
  'air/prompts/pr.md',
  'bugfix/prompts/pr.md',
] as const;

const mirroredProtocolFiles = [
  'shared/gate-request.md',
  ...phasePrompts,
  'spir/builder-prompt.md',
  'aspir/builder-prompt.md',
] as const;

function protocolFile(tree: 'codev' | 'codev-skeleton', relative: string): string {
  return path.join(repoRoot, tree, 'protocols', relative);
}

function expectGateVocabulary(delivered: string): void {
  expect(delivered).not.toContain('{{> protocols/shared/gate-request.md}}');
  expect(delivered).toContain('question');
  expect(delivered).toContain('choices');
  expect(delivered).toContain('consequence');
  expect(delivered).toContain('recommended');
  expect(delivered).toContain('terminalExcerpt');
  expect(delivered).toContain('porch gate {{project_id}} --request-file gate-request.json');
  expect(delivered).toContain('Structured content is optional');
  expect(delivered).toContain('must still send the existing architect notification');
  expect(delivered).toContain('does not approve the gate');
}

describe('Spec 128 gate authoring prompt delivery', () => {
  it.each(phasePrompts)('%s resolves the shared vocabulary through the real include resolver', (relative) => {
    const source = fs.readFileSync(protocolFile('codev', relative), 'utf8');
    expect(source.match(/\{\{> protocols\/shared\/gate-request\.md\}\}/g)).toHaveLength(1);
    expectGateVocabulary(resolveCodevIncludes(source, repoRoot));
  });

  it.each(['spir', 'aspir'] as const)(
    '%s spawn prompt resolves the shared verify-approval vocabulary',
    (protocol) => {
      const config: Config = {
        workspaceRoot: repoRoot,
        codevDir: path.join(repoRoot, 'codev'),
        buildersDir: path.join(repoRoot, '.builders'),
        stateDir: path.join(repoRoot, '.builders', 'state'),
        templatesDir: '',
        serversDir: '',
        bundledRolesDir: '',
        terminalBackend: 'node-pty',
      };
      const context: TemplateContext = {
        protocol_name: protocol.toUpperCase(),
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        project_id: '128',
        input_description: 'issue #128',
      };

      const delivered = buildPromptFromTemplate(config, protocol, context);

      expect(delivered).not.toContain('{{>');
      expect(delivered).toContain('porch gate 128 --request-file gate-request.json');
      expect(delivered).toContain('Structured content is optional');
      expect(delivered).toContain('must still send the existing architect notification');
      expect(delivered).toContain('does not approve the gate');
    },
  );

  it.each(mirroredProtocolFiles)('%s is byte-identical in live and shipped protocol trees', (relative) => {
    expect(fs.readFileSync(protocolFile('codev', relative))).toEqual(
      fs.readFileSync(protocolFile('codev-skeleton', relative)),
    );
  });

  it('keeps each live/skeleton Claude-Codex porch skill twin byte-identical and discoverable', () => {
    for (const prefix of ['', 'codev-skeleton/']) {
      const claude = fs.readFileSync(path.join(repoRoot, prefix, '.claude/skills/porch/SKILL.md'));
      const codex = fs.readFileSync(path.join(repoRoot, prefix, '.codex/skills/porch/SKILL.md'));
      expect(claude).toEqual(codex);
      expect(claude.toString()).toContain('porch gate [id] --request-file');
    }
  });
});
