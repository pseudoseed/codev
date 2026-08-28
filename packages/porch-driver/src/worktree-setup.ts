/**
 * Spec 146, Phase 3 — the `installHarnessWorktreeFiles` replacement.
 *
 * WHAT MOVED AND WHAT DID NOT
 *
 * Under t3code there is no CLI to launch, so the parts of the old path that
 * built argv and shell fragments are gone: the role prompt is the first turn's
 * content (`turn.ts`). What remains is genuinely about the worktree and survives
 * the transport change untouched —
 *
 *  - the Claude write-guard (#1018), which stops a builder writing outside its
 *    own worktree,
 *  - `opencode.json`, which is how the opencode runtime finds its instructions,
 *  - the JSON merge and `skip-worktree` behaviour of the original writer, which
 *    exist because these files land in a real git worktree that a human reads.
 *
 * THE GUARD'S CONTENT IS INJECTED, NOT COPIED
 *
 * `buildWorktreeGuardFiles` in `agent-farm/utils/worktree-write-guard.ts` owns the
 * hook script and the `.claude/settings.local.json` it shares with the phase
 * stop-guard. Copying ~150 lines of it here would create a second copy that
 * drifts silently — the failure mode the repo's own lessons name first. So this
 * module owns PLACEMENT and the caller supplies CONTENT, and a caller that
 * supplies none gets `guard: 'absent'` with a reason, never a silent skip.
 *
 * DOES THE GUARD STILL FIRE UNDER t3code'S CLAUDE DRIVER?
 *
 * Yes, on the evidence available without running one: t3code's Claude adapter
 * passes `settingSources: ["user", "project", "local"]` to the Agent SDK
 * (`apps/server/src/provider/Layers/ClaudeAdapter.ts:1243-1247` and `:4312`, at
 * the pinned commit `082e6ea`), and `local` is `.claude/settings.local.json` —
 * the file the guard installs its `PreToolUse` hook into. A driver that loaded no
 * filesystem settings would have made the guard inert, which is exactly the
 * "installed, documented, never fires" outcome the spec refuses to accept
 * silently.
 *
 * What that evidence is and is not: it establishes that the settings file is
 * READ. It does not establish that a `PreToolUse` hook declared there fires for
 * an SDK-driven tool call, because no claudeAgent turn was run against it in this
 * phase — the live harness drives the codex driver. Recorded in
 * `codev/research/146-phase3-live-evidence.json` under `limits.guard`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { T3DriverKind } from './harness-map.js';

export interface WorktreeFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface WorktreeSetupOptions {
  readonly worktreePath: string;
  /**
   * The Claude write-guard files, from `buildWorktreeGuardFiles(worktreePath)`.
   *
   * Injected so this module does not hold a second copy of the hook script.
   */
  readonly guardFiles?: ReadonlyArray<WorktreeFile>;
  /** Where the role text is written for a human to read. Default `.builder-role.md`. */
  readonly roleFilePath?: string;
  /** The role text. Omitted means no role file is written. */
  readonly roleContent?: string;
}

export interface WorktreeSetupPlan {
  readonly files: ReadonlyArray<WorktreeFile>;
  /**
   * Whether the write-guard is part of this plan.
   *
   * `'not-applicable'` for a driver that is not Claude, `'absent'` when it
   * applies and no content was supplied — those are different facts and must not
   * be spelled the same way.
   */
  readonly guard: 'installed' | 'absent' | 'not-applicable';
  readonly guardReason?: string;
}

/**
 * What to write into a worktree for `driverKind`.
 *
 * Pure: returns the plan, writes nothing. `applyWorktreeSetup` does the writing,
 * so a caller can log or assert the plan before anything touches disk.
 */
export function planWorktreeSetup(driverKind: T3DriverKind, options: WorktreeSetupOptions): WorktreeSetupPlan {
  const files: WorktreeFile[] = [];
  const roleFilePath = options.roleFilePath ?? '.builder-role.md';

  if (options.roleContent !== undefined) {
    files.push({ relativePath: roleFilePath, content: options.roleContent });
  }

  if (driverKind === 'claudeAgent') {
    if (options.guardFiles && options.guardFiles.length > 0) {
      files.push(...options.guardFiles);
      return { files, guard: 'installed' };
    }
    return {
      files,
      guard: 'absent',
      guardReason:
        'No guard files were supplied. The write-guard (#1018) is therefore NOT ' +
        'installed in this worktree, and a builder can write outside it. This is ' +
        'reported rather than skipped so the absence is a fact the caller holds, ' +
        'not one discovered later.',
    };
  }

  if (driverKind === 'opencode') {
    // `instructions` names the role file, so it is listed only when that file is
    // actually written. Pointing opencode at a path that does not exist is not a
    // harmless extra entry: it is a config that describes instructions nobody
    // supplied, and it would read as "the role is installed" to anyone looking.
    const instructions = options.roleContent === undefined ? [] : [roleFilePath];
    files.push({
      relativePath: 'opencode.json',
      content: JSON.stringify({ instructions }, null, 2) + '\n',
    });
  }

  return { files, guard: 'not-applicable' };
}

/**
 * Write a plan's files into the worktree.
 *
 * JSON files are shallow-merged with what is already there and `instructions` is
 * de-duplicated, because `opencode.json` may be a file the user wrote. A JSON
 * file that will not parse is left alone and reported: overwriting it would
 * destroy a user's config to install a convenience.
 */
export function applyWorktreeSetup(
  plan: WorktreeSetupPlan,
  worktreePath: string,
  onWarning?: (message: string) => void,
): ReadonlyArray<string> {
  const written: string[] = [];

  for (const file of plan.files) {
    const targetPath = resolve(worktreePath, file.relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });

    if (file.relativePath.endsWith('.json') && existsSync(targetPath)) {
      try {
        const existing = JSON.parse(readFileSync(targetPath, 'utf-8')) as Record<string, unknown>;
        const incoming = JSON.parse(file.content) as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...existing, ...incoming };
        if (Array.isArray(existing.instructions) && Array.isArray(incoming.instructions)) {
          merged.instructions = [...new Set([...existing.instructions, ...incoming.instructions])];
        }
        writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n');
      } catch {
        onWarning?.(
          `Cannot merge ${file.relativePath}: the existing file is not valid JSON. ` +
            `Skipping it, to preserve config this driver did not write.`,
        );
        continue;
      }
    } else {
      writeFileSync(targetPath, file.content);
    }

    // Generated files must not be committed back. Non-fatal: a file git does not
    // track yet has nothing to mark.
    try {
      execFileSync('git', ['update-index', '--skip-worktree', file.relativePath], {
        cwd: worktreePath,
        stdio: 'pipe',
      });
    } catch {
      /* untracked file; nothing to mark */
    }

    written.push(file.relativePath);
  }

  return written;
}
