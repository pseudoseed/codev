/**
 * Interrupt command — send a bare ESC keystroke into a builder's PTY (Spec 1273).
 *
 * This is the only recovery that reaches a builder *mid-turn*. When a builder
 * chains foreground waits inside one turn, every `afx send` — including the
 * architect's order to stop — queues unread until the turn ends. ESC interrupts
 * the running tool and ends the turn. An explicit Enter opt-in then lets queued
 * messages process; ESC alone is the safe default for an unknown screen.
 *
 * Verified in production (shannon workspace, 2026-07-27): a builder wedged for
 * 45+ minutes on a wait for a file whose producer had already died resumed
 * within two minutes of receiving ESC. Until now that recipe
 * (`afx send <builder> --raw "$(printf '\x1b')"`) lived only in architect lore
 * and had to be discovered under pressure.
 *
 * Addressing, workspace detection and sender identity are reused verbatim from
 * `afx send` — there is exactly one address resolver.
 */

import type { InterruptOptions } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { TowerClient } from '../lib/tower-client.js';
import { detectWorkspaceRoot, detectCurrentBuilderId } from './send.js';
import { findBuilderById } from '../lib/builder-lookup.js';
import { isThreadBacked } from '../thread-runtime.js';
import { adoptThreadInThisProcess, closeThreadBackend } from '../thread-backend.js';

export async function interrupt(options: InterruptOptions): Promise<void> {
  const target = options.builder;
  const noEnter = options.noEnter !== false;

  if (!target) {
    fatal('Must specify a builder. Usage: afx interrupt <builder>');
  }

  logger.header('Sending Interrupt (ESC)');

  let builder = null;
  try {
    builder = findBuilderById(target);
  } catch {
    builder = null;
  }
  if (builder && isThreadBacked(builder) && builder.threadId) {
    // A workspace we could not detect is NOT a workspace with no engine.
    //
    // `?? undefined` sent an undetectable root to the unkeyed slot, so the lookup missed
    // and the user was told "no thread engine is registered" — which is a statement about
    // the engine map, when the truth was that this command never worked out which
    // workspace it was in. Two causes, one sentence: the defect this whole issue is
    // about, in the code written to fix it.
    const workspaceRoot = detectWorkspaceRoot();
    if (!workspaceRoot) {
      fatal(
        `Cannot interrupt ${builder.id}: it is thread-backed, and this command could not work out `
        + `which workspace it is running in — so there is no engine to look up rather than no engine `
        + `registered. Run it from inside the workspace, or from a builder worktree under it.`,
      );
    }
    try {
      // Register the backend in THIS process and adopt the thread from the row, then
      // interrupt (issue #227 item 2).
      //
      // This command used to look the engine up and throw, because nothing registers one
      // in a fresh `afx` process — a correct sentence about a command that did not work.
      // The engine map is keyed by workspace, so it is named here rather than left to the
      // unkeyed slot: an engine registered for a different workspace holds another
      // server and another project.
      const engine = await adoptThreadInThisProcess({
        threadId: builder.threadId,
        workspaceRoot,
        worktreePath: builder.worktree,
        branch: builder.branch,
        builderId: builder.id,
        harnessName: builder.harness,
        model: builder.model,
      });
      const settled = await engine.interrupt(builder.threadId);
      if (settled.activeTurnId !== null) {
        fatal(`Interrupt of ${builder.id} did not settle activeTurnId`);
      }
      logger.success(`Interrupt sent to thread ${builder.threadId}`);
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    } finally {
      // An open WebSocket keeps the event loop alive, and this command is expected to
      // exit. Without it the first live run printed its success line and then hung until
      // the caller killed it — the interrupt having already landed. Working, and hung.
      closeThreadBackend(workspaceRoot);
    }
    return;
  }

  const workspace = detectWorkspaceRoot() ?? undefined;

  // Same identity rule as `afx send`: in a confirmed builder worktree an
  // unverifiable canonical id aborts rather than sending as an unverified
  // sender, which Tower would silently route to 'main' (issue #1094).
  let from: string;
  try {
    from = detectCurrentBuilderId() ?? 'architect';
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }

  const client = new TowerClient();
  if (!(await client.isRunning())) {
    fatal('Tower is not running. Start it with: afx tower start');
  }

  try {
    // `message` carries the ESC byte so the route's non-empty validation is
    // satisfied and both this command and the manual `--raw` recipe exercise the
    // same byte. `escape` is what makes delivery immediate and unformatted.
    const result = await client.sendMessage(target, '\x1b', {
      from,
      workspace,
      fromWorkspace: workspace,
      escape: true,
      noEnter,
    });

    if (!result.ok) {
      throw new Error(result.error || 'Unknown error');
    }

    logger.success(`Interrupt (ESC) sent to ${result.resolvedTo ?? target}`);
    if (!noEnter) {
      logger.info('Enter followed the ESC — any messages queued during the turn should now process.');
    }
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}
