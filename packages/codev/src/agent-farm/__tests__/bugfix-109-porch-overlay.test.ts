/**
 * Issue #109: afx status must show porch phase/completion, not the spawn
 * snapshot (implementing / init).
 *
 * These tests fail if overlayBuilderFromPorch is a no-op — that is the
 * production bug: global.db stays at spawn values forever.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readPorchPhase,
  statusFromPorchPhase,
  overlayBuilderFromPorch,
} from '../lib/porch-overlay.js';
import type { Builder } from '../types.js';

function builder(worktree: string, extra: Partial<Builder> = {}): Builder {
  return {
    id: 'builder-bugfix-147',
    name: 'Bugfix #147: finished builders look live',
    type: 'bugfix',
    status: 'implementing',
    phase: 'init',
    worktree,
    branch: 'builder/bugfix-147',
    issueNumber: 147,
    ...extra,
  };
}

function writeProject(worktree: string, dirName: string, yaml: string): void {
  const dir = join(worktree, 'codev', 'projects', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.yaml'), yaml);
}

describe('porch overlay (issue #109)', () => {
  let root: string;
  let worktree: string;

  beforeEach(() => {
    root = join(tmpdir(), `porch-overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    worktree = join(root, 'bugfix-147');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads phase from the matching project status.yaml', () => {
    writeProject(worktree, 'bugfix-147-finished', 'id: bugfix-147\nphase: verified\nbuild_complete: true\n');
    expect(readPorchPhase(worktree, 'bugfix-147')).toBe('verified');
  });

  it('returns null when the worktree has no porch state', () => {
    expect(readPorchPhase(worktree, 'bugfix-147')).toBeNull();
    expect(readPorchPhase('', 'bugfix-147')).toBeNull();
    expect(readPorchPhase(worktree, null)).toBeNull();
  });

  it('maps verified/complete to status complete, pr to pr, else leaves status', () => {
    expect(statusFromPorchPhase('verified', 'implementing')).toBe('complete');
    expect(statusFromPorchPhase('complete', 'implementing')).toBe('complete');
    expect(statusFromPorchPhase('pr', 'implementing')).toBe('pr');
    expect(statusFromPorchPhase('investigate', 'implementing')).toBe('implementing');
    expect(statusFromPorchPhase('fix', 'blocked')).toBe('blocked');
  });

  it('overlays a finished builder so afx status no longer says implementing/init', () => {
    writeProject(worktree, 'bugfix-147-finished', "id: 'bugfix-147'\nphase: verified\n");
    const shown = overlayBuilderFromPorch(builder(worktree));
    expect(shown.phase).toBe('verified');
    expect(shown.status).toBe('complete');
  });

  it('overlays an in-progress protocol phase (not just the terminal one)', () => {
    writeProject(worktree, 'bugfix-147-finished', 'id: bugfix-147\nphase: investigate\n');
    const shown = overlayBuilderFromPorch(builder(worktree));
    expect(shown.phase).toBe('investigate');
    expect(shown.status).toBe('implementing');
  });

  it('ignores an unrelated project dir that sorts first', () => {
    writeProject(worktree, '0087-unrelated', 'id: "0087"\nprotocol: spir\nphase: complete\n');
    writeProject(worktree, 'bugfix-147-done', 'id: bugfix-147\nphase: investigate\n');
    const shown = overlayBuilderFromPorch(builder(worktree));
    expect(shown.phase).toBe('investigate');
    expect(shown.status).toBe('implementing');
  });

  it('leaves the spawn snapshot alone when status.yaml is missing', () => {
    const raw = builder(worktree);
    expect(overlayBuilderFromPorch(raw)).toBe(raw);
  });
});
