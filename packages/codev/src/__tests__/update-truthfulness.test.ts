/**
 * Issues #29, #30, #31 — `codev update` saying things that were not checked.
 *
 * All three are the same defect wearing different clothes: the code reports a
 * conclusion it never established.
 *
 *   #31 `--dry-run` announced "no files will be changed" and then wrote.
 *   #30 A conflict was reported with the reason "Content differs from template"
 *       when the only test performed was `fs.existsSync`.
 *   #29 Skills were preserved "without replacing customizations" by a guard
 *       that tested the DIRECTORY, so it could not tell a customization from a
 *       stale copy and preserved both.
 *
 * Each test below fails against the old implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  copyRootFiles,
  copySkills,
  SKILL_MANIFEST_FILENAME,
} from '../lib/scaffold.js';

// Not under os.tmpdir(): same reasoning as the write-guard fixtures.
const FIXTURE_HOME = path.join(path.resolve(__dirname, '..', '..'), 'node_modules', '.update-fixtures');

let base: string;
let target: string;
let skeleton: string;

beforeEach(() => {
  fs.mkdirSync(FIXTURE_HOME, { recursive: true });
  base = fs.mkdtempSync(path.join(FIXTURE_HOME, 'upd-'));
  target = path.join(base, 'project');
  skeleton = path.join(base, 'skeleton');
  fs.mkdirSync(path.join(skeleton, 'templates'), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
});

afterEach(() => {
  fs.rmSync(FIXTURE_HOME, { recursive: true, force: true });
});

function writeTemplate(file: string, content: string): void {
  fs.writeFileSync(path.join(skeleton, 'templates', file), content);
}

function writeSkill(root: string, provider: string, name: string, files: Record<string, string>): void {
  const dir = path.join(root, `.${provider}`, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

describe('#30: copyRootFiles must compare content before calling it a conflict', () => {
  it('reports an identical file as unchanged, not as a conflict', () => {
    writeTemplate('CLAUDE.md', 'same content\n');
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'same content\n');

    const r = copyRootFiles(target, skeleton, 'proj', { handleConflicts: true });

    expect(r.unchanged).toContain('CLAUDE.md');
    expect(r.conflicts).not.toContain('CLAUDE.md');
  });

  it('writes NO .codev-new sibling for an identical file', () => {
    // The visible cost of the old behavior: a merge task that was a no-op.
    writeTemplate('CLAUDE.md', 'same content\n');
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'same content\n');

    copyRootFiles(target, skeleton, 'proj', { handleConflicts: true });

    expect(fs.existsSync(path.join(target, 'CLAUDE.md.codev-new'))).toBe(false);
  });

  it('still reports a genuine difference as a conflict, and writes the sibling', () => {
    writeTemplate('CLAUDE.md', 'new content\n');
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'old content\n');

    const r = copyRootFiles(target, skeleton, 'proj', { handleConflicts: true });

    expect(r.conflicts).toContain('CLAUDE.md');
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md.codev-new'), 'utf-8')).toBe('new content\n');
  });

  it('compares AFTER template substitution, so a substituted file is not a false conflict', () => {
    writeTemplate('CLAUDE.md', 'project: {{PROJECT_NAME}}\n');
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'project: proj\n');

    const r = copyRootFiles(target, skeleton, 'proj', { handleConflicts: true });

    expect(r.unchanged).toContain('CLAUDE.md');
    expect(r.conflicts).toHaveLength(0);
  });
});

describe('#31: --dry-run must not write', () => {
  it('writes no .codev-new sibling on a dry run', () => {
    writeTemplate('CLAUDE.md', 'new content\n');
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'old content\n');

    const r = copyRootFiles(target, skeleton, 'proj', { handleConflicts: true, dryRun: true });

    expect(r.conflicts).toContain('CLAUDE.md');
    expect(fs.existsSync(path.join(target, 'CLAUDE.md.codev-new'))).toBe(false);
  });

  it('creates no new file on a dry run, but still reports what it would create', () => {
    writeTemplate('AGENTS.md', 'fresh\n');

    const r = copyRootFiles(target, skeleton, 'proj', { handleConflicts: true, dryRun: true });

    expect(r.copied).toContain('AGENTS.md');
    expect(fs.existsSync(path.join(target, 'AGENTS.md'))).toBe(false);
  });

  it('does not write on a dry run through the FORCE branch either', () => {
    // The force branch was missed the first time: `copyRootFiles` was called
    // with no options at all, so `--dry-run --force` announced "no files will
    // be changed" and then created the file. Both are real CLI flags.
    writeTemplate('AGENTS.md', 'fresh\n');

    const r = copyRootFiles(target, skeleton, 'proj', { dryRun: true });

    expect(r.copied).toContain('AGENTS.md');
    expect(fs.existsSync(path.join(target, 'AGENTS.md'))).toBe(false);
  });

  it('a dry run followed by a real run produces the same reported outcome', () => {
    // The point of a dry run is that it predicts the real one.
    writeTemplate('CLAUDE.md', 'new\n');
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), 'old\n');

    const dry = copyRootFiles(target, skeleton, 'proj', { handleConflicts: true, dryRun: true });
    const real = copyRootFiles(target, skeleton, 'proj', { handleConflicts: true });

    expect(dry.conflicts).toEqual(real.conflicts);
    expect(dry.copied).toEqual(real.copied);
    expect(dry.unchanged).toEqual(real.unchanged);
  });
});

describe('#29: skills must be refreshable, and customizations must survive', () => {
  it('records a manifest when it first installs a skill', () => {
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n' });

    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    const manifestPath = path.join(target, '.claude', 'skills', SKILL_MANIFEST_FILENAME);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))).toHaveProperty('afx');
  });

  it('REFRESHES a vendored skill that is unmodified but stale', () => {
    // The whole point. Under the old guard this was frozen forever.
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n' });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2 — now documents --branch\n' });
    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.refreshed).toContain('.claude/skills/afx/');
    expect(fs.readFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'utf-8'))
      .toBe('v2 — now documents --branch\n');
  });

  it('LEAVES a locally edited skill alone, and says so', () => {
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n' });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    fs.writeFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'my local notes\n');
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });
    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.customized).toContain('.claude/skills/afx/');
    expect(r.refreshed).not.toContain('.claude/skills/afx/');
    expect(fs.readFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'utf-8'))
      .toBe('my local notes\n');
  });

  it('treats a skill of UNKNOWN provenance as customized, never as refreshable', () => {
    // Installed before manifests existed. "I cannot tell" must not be spelled
    // the same way as "safe to overwrite" — that would eat real local work.
    writeSkill(target, 'claude', 'afx', { 'SKILL.md': 'vendored long ago\n' });
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });

    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.customized).toContain('.claude/skills/afx/');
    expect(fs.readFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'utf-8'))
      .toBe('vendored long ago\n');
  });

  it('backfills the manifest for an already-current skill, so the NEXT update can tell', () => {
    // Unknown provenance but identical content: safe to record, and recording
    // it is what lets the following release refresh instead of stalling.
    writeSkill(target, 'claude', 'afx', { 'SKILL.md': 'v1\n' });
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n' });

    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });
    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.refreshed).toContain('.claude/skills/afx/');
  });

  it('notices a change in a nested file, not just the top-level one', () => {
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n', 'references/flags.md': 'a\n' });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n', 'references/flags.md': 'b\n' });
    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.refreshed).toContain('.claude/skills/afx/');
  });

  it('still installs a brand-new skill that the project does not have', () => {
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n' });
    writeSkill(skeleton, 'claude', 'porch', { 'SKILL.md': 'p1\n' });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    writeSkill(skeleton, 'claude', 'consult', { 'SKILL.md': 'c1\n' });
    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.copied).toContain('.claude/skills/consult/');
  });

  it('without refreshUnmodified, behaves exactly as before', () => {
    // init/adopt still want the old semantics; only update opts in.
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n' });
    copySkills(target, skeleton, { skipExisting: true });

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });
    const r = copySkills(target, skeleton, { skipExisting: true });

    expect(r.skipped).toContain('.claude/skills/afx/');
    expect(r.refreshed).toHaveLength(0);
    expect(fs.readFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'utf-8')).toBe('v1\n');
  });
});

describe('#29 follow-up: a file deleted from the skeleton must not freeze the skill', () => {
  it('removes a file the skeleton dropped, instead of leaving it behind', () => {
    // copyDirRecursive is additive. Overlaying leaves the deleted file in the
    // vendored skill — the exact stale-doc symptom #29 exists to fix, surviving
    // the fix that was supposed to remove it.
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n', 'references/old.md': 'removed in v2\n' });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });
    fs.rmSync(path.join(skeleton, '.claude/skills/afx/references'), { recursive: true, force: true });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(fs.existsSync(path.join(target, '.claude/skills/afx/references/old.md'))).toBe(false);
  });

  it('stays refreshable on the NEXT update after a skeleton deletion', () => {
    // The compounding half. An overlay records the skeleton's hash while the
    // destination hashes to src+leftover, so the following update reads
    // destHash !== installedHash, calls it customized, and freezes it forever
    // with zero local edits. Silent and unrecoverable without deleting the dir.
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n', 'references/old.md': 'gone in v2\n' });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });
    fs.rmSync(path.join(skeleton, '.claude/skills/afx/references'), { recursive: true, force: true });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v3\n' });
    const third = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(third.customized).toHaveLength(0);
    expect(third.refreshed).toContain('.claude/skills/afx/');
    expect(fs.readFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'utf-8')).toBe('v3\n');
  });

  it('a local edit still survives a skeleton deletion', () => {
    // The removal is scoped to the branch that already proved the copy is
    // unmodified. A customized skill must never reach it.
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n', 'references/old.md': 'a\n' });
    copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });
    fs.writeFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'MY NOTES\n');

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });
    fs.rmSync(path.join(skeleton, '.claude/skills/afx/references'), { recursive: true, force: true });
    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.customized).toContain('.claude/skills/afx/');
    expect(fs.readFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'utf-8')).toBe('MY NOTES\n');
    expect(fs.existsSync(path.join(target, '.claude/skills/afx/references/old.md'))).toBe(true);
  });
});

describe('#29 follow-up: init/adopt must leave provenance behind', () => {
  it('recordManifest writes a manifest WITHOUT refreshing anything', () => {
    // adopt's shape: it must never rewrite an existing project's skills, but it
    // should still leave enough behind for a later update to tell stale from
    // customized.
    writeSkill(target, 'claude', 'afx', { 'SKILL.md': 'pre-existing\n' });
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });

    const r = copySkills(target, skeleton, { skipExisting: true, recordManifest: true });

    expect(r.refreshed).toHaveLength(0);
    expect(fs.readFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'utf-8'))
      .toBe('pre-existing\n');
  });

  it('a skill installed with recordManifest is refreshable on the next update', () => {
    // The whole reason this option exists. Installed at v1 via init, never
    // updated at v1 — under the original fix that project would be classified
    // unknown-provenance and frozen out of every future refresh.
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n' });
    copySkills(target, skeleton, { recordManifest: true });

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });
    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.refreshed).toContain('.claude/skills/afx/');
    expect(r.customized).toHaveLength(0);
  });

  it('recordManifest still respects a local edit made after install', () => {
    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v1\n' });
    copySkills(target, skeleton, { recordManifest: true });
    fs.writeFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'MINE\n');

    writeSkill(skeleton, 'claude', 'afx', { 'SKILL.md': 'v2\n' });
    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.customized).toContain('.claude/skills/afx/');
    expect(fs.readFileSync(path.join(target, '.claude/skills/afx/SKILL.md'), 'utf-8')).toBe('MINE\n');
  });
});

describe('#29 follow-up: hashing raw bytes', () => {
  const BYTES_A = Buffer.from([0xff, 0xfe, 0x01]);
  const BYTES_B = Buffer.from([0xff, 0xfe, 0x02]);

  function installBinarySkill(bytes: Buffer): void {
    writeSkill(skeleton, 'claude', 'assets', { 'SKILL.md': 'v1\n' });
    fs.writeFileSync(path.join(skeleton, '.claude/skills/assets/asset.bin'), bytes);
  }

  it('sees a one-byte binary change that utf-8 decoding would flatten', () => {
    // Both byte strings decode to the same U+FFFD sequence, so a utf-8 hash
    // rated them identical — a locally modified binary would have read as
    // unmodified and been silently overwritten.
    installBinarySkill(BYTES_A);
    copySkills(target, skeleton, { recordManifest: true });

    // Local edit: same length, one byte different, invalid utf-8 either way.
    fs.writeFileSync(path.join(target, '.claude/skills/assets/asset.bin'), BYTES_B);
    writeSkill(skeleton, 'claude', 'assets', { 'SKILL.md': 'v2\n' });
    fs.writeFileSync(path.join(skeleton, '.claude/skills/assets/asset.bin'), BYTES_A);

    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.customized).toContain('.claude/skills/assets/');
    expect(fs.readFileSync(path.join(target, '.claude/skills/assets/asset.bin'))).toEqual(BYTES_B);
  });

  it('still refreshes when the binary is untouched and only text moved', () => {
    installBinarySkill(BYTES_A);
    copySkills(target, skeleton, { recordManifest: true });

    writeSkill(skeleton, 'claude', 'assets', { 'SKILL.md': 'v2\n' });
    fs.writeFileSync(path.join(skeleton, '.claude/skills/assets/asset.bin'), BYTES_A);

    const r = copySkills(target, skeleton, { skipExisting: true, refreshUnmodified: true });

    expect(r.refreshed).toContain('.claude/skills/assets/');
  });
});
