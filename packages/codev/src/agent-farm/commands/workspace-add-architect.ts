/**
 * `afx workspace add-architect [--name <name>]` (Spec 755)
 *
 * Registers an additional named architect terminal in an active workspace.
 *
 * Without `--name`, Tower auto-assigns the next available `architect-<N>`
 * (smallest unused integer ≥ 2). With `--name <name>`, the name is validated
 * client-side first (cheap roundtrip avoidance) and then the request is
 * dispatched to Tower, which re-validates and rejects collisions.
 *
 * Existing `afx architect` (local Claude session, no Tower) is intentionally
 * unchanged — its no-Tower contract is preserved.
 */

import { getConfig } from '../utils/index.js';
import { logger } from '../utils/logger.js';
import { getTowerClient } from '../lib/tower-client.js';
import {
  autoNumberArchitectName,
  DEFAULT_ARCHITECT_NAME,
  validateArchitectName,
} from '../utils/architect-name.js';
import { getArchitects, setArchitectByName } from '../state.js';
import { architectThreadDefaults, createArchitectThread, tryGetThreadEngine } from '../thread-runtime.js';
import { closeThreadBackend, ensureThreadBackendReady } from '../thread-backend.js';

export interface WorkspaceAddArchitectOptions {
  name?: string;
}

export async function workspaceAddArchitect(
  options: WorkspaceAddArchitectOptions = {},
): Promise<void> {
  const config = getConfig();
  const workspacePath = config.workspaceRoot;

  // Client-side validation. Tower re-validates, but failing fast here
  // gives a tighter error path when the user typos a name.
  //
  // Note: we distinguish "no --name supplied" (undefined) from "--name with
  // empty/whitespace value" (rejected explicitly). The former auto-numbers;
  // the latter is a user error and must not silently auto-number.
  if (options.name !== undefined) {
    const trimmed = options.name.trim();
    if (trimmed === '') {
      logger.error('Architect name cannot be empty. Omit --name to auto-number, or supply a valid name.');
      process.exit(1);
    }
    const err = validateArchitectName(trimmed);
    if (err) {
      logger.error(err);
      process.exit(1);
    }
    // Pass the trimmed value through to the Tower client.
    options.name = trimmed;
  }

  // Without this the thread branch below is dead code in production. Every `afx`
  // invocation is a fresh process, and nothing else in this command registers an
  // engine — so `tryGetThreadEngine()` was always undefined here and a workspace
  // configured for threads still got a Tower terminal. `afx spawn` already calls
  // this for the same reason; `add-architect` is the command that makes an
  // architect a thread, so it is the one place the omission made spec 146's
  // "an architect is a thread whose worktree is the workspace root" unreachable.
  //
  // Returns `not-configured` and registers nothing when no server is named, which
  // leaves the Tower path below byte-for-byte unchanged. It throws when a server IS
  // configured and cannot be reached, which is the module's standing rule: an
  // unreachable server must not be spelled the same way as an unconfigured one.
  await ensureThreadBackendReady(workspacePath);

  if (tryGetThreadEngine(workspacePath)) {
    const existing = new Set(getArchitects(workspacePath).map((a) => a.name));
    let name = options.name;
    if (name) {
      // The Tower path refuses a name already registered. This one consulted
      // `existing` only when auto-numbering, so an explicit collision created a
      // SECOND thread and `setArchitectByName` overwrote the row — leaving the
      // first thread alive on the server with nothing pointing at it. Two paths,
      // one contract, and only one of them destroyed state.
      //
      // Same sentence as `addArchitect` in tower-instances.ts, deliberately: a
      // user hitting this should not be able to tell which engine refused.
      if (existing.has(name)) {
        logger.error(`Architect '${name}' is already registered in this workspace.`);
        process.exit(1);
      }
    } else {
      // `autoNumberArchitectName` starts at 2 and never returns the reserved
      // default, so 'main' stays this path's first-architect case.
      name = existing.has(DEFAULT_ARCHITECT_NAME)
        ? autoNumberArchitectName(existing)
        : DEFAULT_ARCHITECT_NAME;
    }
    // Read BEFORE the create, so the pair recorded is the one this create resolves —
    // not a re-read of configuration that a concurrent edit could have moved.
    const defaults = architectThreadDefaults(workspacePath);
    try {
      const threadId = await createArchitectThread({ name, workspaceRoot: workspacePath });
      setArchitectByName(workspacePath, name, {
        name,
        cmd: '',
        startedAt: new Date().toISOString(),
        threadId,
        // Issue #227 item 3: the pair this thread was created with, pinned on the row the
        // way a builder's is. Without it a later `attach` — which is where Tower resumes
        // this thread — carries no harness or model and falls back to whatever
        // `.codev/config.json` says at THAT moment, so editing `threads.model` between a
        // spawn and a delivery silently moved a live architect onto a different model.
        harness: defaults?.harness,
        model: defaults?.model,
      });
      logger.success(`Started architect '${name}' (thread ${threadId}).`);
    } finally {
      // Issue #271. An open WebSocket keeps the event loop alive, and this command is
      // expected to exit. Without it the live run printed nothing and hung past two
      // minutes until the caller killed it — the architect having already been created
      // AND registered. Working, and hung, which reads from outside exactly like a
      // command that failed.
      //
      // The same fix `afx interrupt` carries, for the same reason. Every one-shot
      // command that reaches a thread owes it.
      closeThreadBackend(workspacePath);
    }
    return;
  }

  const client = getTowerClient();
  const towerRunning = await client.isRunning();
  if (!towerRunning) {
    logger.error('Tower is not running. Start it with `afx workspace start` first.');
    process.exit(1);
  }

  const result = await client.addArchitect(workspacePath, options.name);

  if (!result.ok) {
    logger.error(result.error ?? 'Failed to add architect.');
    process.exit(1);
  }

  logger.success(`Started architect '${result.name}' (terminal ${result.terminalId}).`);
}
