/**
 * The canonical key for a workspace root, shared by every per-workspace map.
 *
 * WHY THIS IS ITS OWN MODULE (issue #227 item 1).
 *
 * It was a private helper in `thread-runtime.ts`, and that was fine while the engine map
 * was the only thing keyed by a workspace. The spawn factory is keyed the same way now,
 * and it lives in `db/thread-identity.ts` — which `thread-runtime.ts` imports. Reaching
 * back the other way for the key helper would make an import cycle out of two modules
 * that only need one small function. So the function moves down to where both can see it;
 * `thread-runtime.ts` re-exports it, which is why no existing caller had to change.
 *
 * TWO KEYS FOR ONE WORKSPACE IS TWO OF EVERYTHING KEYED BY IT. `/var` and `/private/var`
 * are the same directory on macOS, and `.`-relative and trailing-slash forms are the same
 * workspace — so a string compare would hand one workspace two engines, two sockets, two
 * projects and two spawn factories, which is the failure this key exists to prevent.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The slot for a caller that names no workspace.
 *
 * Deliberately NOT a fallback for keyed lookups. A keyed read that missed and then took
 * this one would restore the process-global bug one indirection further away. A caller
 * either names a workspace or it does not, and the two never see each other's entry.
 */
export const UNKEYED = '\u0000unkeyed';

/** The map key for an optional workspace root: the canonical path, or the unkeyed slot. */
export function workspaceMapKey(workspaceRoot?: string): string {
  return workspaceRoot === undefined ? UNKEYED : canonicalWorkspaceKey(workspaceRoot);
}

const canonicalKeys = new Map<string, string>();

export function canonicalWorkspaceKey(workspaceRoot: string): string {
  // CACHED, because this is on Tower's drain loop.
  //
  // `realpathSync` is a synchronous filesystem syscall, and this runs on every engine
  // lookup — once per agent per 1.5 s tick, inside the sequential loop that three rounds
  // of issue #219 went into clearing of blocking work. A network call and a blocking
  // syscall on that loop differ in magnitude, not in kind.
  //
  // Keyed on the RAW input, so two spellings of one workspace each resolve once and then
  // both hit. The trade is stated rather than hidden: a symlink repointed while Tower is
  // running keeps its old resolution for the life of the process. That is deliberate — a
  // workspace root moving underneath a running Tower is not a supported operation, and
  // re-resolving every tick to catch it costs every tick.
  const cached = canonicalKeys.get(workspaceRoot);
  if (cached !== undefined) return cached;

  const absolute = resolve(workspaceRoot).replace(/\/+$/, '') || '/';
  let key: string;
  try {
    key = realpathSync(absolute);
  } catch {
    key = absolute;
  }
  canonicalKeys.set(workspaceRoot, key);
  return key;
}

/**
 * Forget cached path resolutions.
 *
 * For a test that creates and removes temp directories — a path resolving differently
 * across two tests in one process is otherwise a stale hit. Not for production.
 */
export function clearCanonicalWorkspaceKeys(): void {
  canonicalKeys.clear();
}
