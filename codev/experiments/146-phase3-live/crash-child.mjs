/**
 * Spec 146, Phase 3 — the driver process the crash scenarios actually kill.
 *
 * The unit tests stand inside the two windows with hooks. This stands inside them
 * with a real process and `SIGKILL`, which is the difference between "the code is
 * ordered correctly" and "the ordering survives the machine going away". Nothing
 * here catches the signal, because a signal a process can catch is not the crash
 * being tested.
 *
 * Modes:
 *   journal-before-dispatch  kill between the journal write and the dispatch
 *   journal-after-dispatch   kill between the dispatch and the outcome record
 *   cursor-before-advance    kill between the handler completing and the cursor write
 *   cursor-resume            restart, and apply whatever the server redelivers
 *
 * Every mode prints one JSON line to stdout before it dies or exits, so the
 * parent learns what the child observed rather than inferring it from the
 * absence of output.
 */

import { appendFileSync } from 'node:fs';

import { connect } from './lib.mjs';
import { DispatchJournal, dispatchCommand } from '../../../packages/porch-driver/dist/commands.js';
import { PersistentCursor } from '../../../packages/porch-driver/dist/cursor.js';
import { asThreadEvent } from '../../../packages/porch-driver/dist/turn.js';

const [mode] = process.argv.slice(2);
const config = JSON.parse(process.env.CRASH_CHILD_CONFIG ?? '{}');

const say = (fields) => process.stdout.write(JSON.stringify({ mode, ...fields }) + '\n');

/** Die the way a machine dies: uncatchable, with nothing flushed afterwards. */
const die = () => {
  process.kill(process.pid, 'SIGKILL');
};

async function journalMode() {
  const { dispatcher } = await connect(config.baseUrl, config.accessToken);
  const journal = new DispatchJournal(config.journalPath);
  // A turn start, not a metadata edit. `subscribeThread` only delivers thread
  // DETAIL events (`ws.ts:293-312`: message-sent, session-set, activity-appended,
  // turn-diff-completed, proposed-plan-upserted, reverted), so a `thread.meta.update`
  // is invisible on the very subscription this scenario counts applications on —
  // it would have read as "applied zero times" for a command that applied fine.
  // A turn start is also the command whose double-application actually costs
  // something: two turns instead of one.
  const command = {
    type: 'thread.turn.start',
    commandId: config.commandId,
    threadId: config.threadId,
    message: { messageId: config.messageId, role: 'user', text: config.text, attachments: [] },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    createdAt: new Date().toISOString(),
  };

  if (mode === 'journal-before-dispatch') {
    say({ about: 'to journal, then die before dispatching', commandId: config.commandId });
    await dispatchCommand(dispatcher, journal, command, { beforeDispatch: die });
    say({ error: 'still alive after the kill' });
    process.exit(1);
  }

  say({ about: 'to journal, dispatch, then die before recording the outcome', commandId: config.commandId });
  await dispatchCommand(dispatcher, journal, command, { afterDispatch: die });
  say({ error: 'still alive after the kill' });
  process.exit(1);
}

async function cursorMode() {
  const { client } = await connect(config.baseUrl, config.accessToken);
  const cursor = PersistentCursor.load(config.cursorPath);
  const startedAt = cursor.applied;
  const applied = [];
  let killed = false;
  // Declared before the stream opens: the callback closes over it, and a value
  // that only exists after `client.stream` returns would be a race waiting to
  // happen the first time the server answers fast.
  let queue = Promise.resolve();

  const stream = client.stream(
    'orchestration.subscribeThread',
    { threadId: config.threadId, afterSequence: cursor.applied, requestCompletionMarker: true },
    (value) => {
      const event = asThreadEvent(value);
      if (!event || event.aggregateId !== config.threadId) return;
      if (killed) return;
      // Serialised deliberately: the cursor's ordering guarantee is about one
      // handler at a time, and overlapping handlers would make "which sequence
      // was in the window" unanswerable.
      queue = queue.then(async () => {
        if (killed) return;
        await cursor.apply(
          event.sequence,
          () => {
            // The idempotent side effect, recorded so the parent can count how
            // many times the same sequence was processed.
            appendFileSync(config.sideEffectPath, `${event.sequence}\n`);
            applied.push(event.sequence);
          },
          mode === 'cursor-before-advance'
            ? {
                beforeAdvance: (sequence) => {
                  killed = true;
                  say({ about: 'handler done, cursor unwritten, dying now', sequence, cursorApplied: cursor.applied });
                  die();
                },
              }
            : {},
        );
        if (mode === 'cursor-resume' && applied.length >= (config.applyCount ?? 1)) {
          say({ about: 'reprocessed after restart', startedAt, applied, cursorApplied: cursor.applied });
          process.exit(0);
        }
      });
    },
  );

  await stream;
  say({ about: 'stream ended', startedAt, applied, cursorApplied: cursor.applied });
  process.exit(0);
}

try {
  if (mode === 'journal-before-dispatch' || mode === 'journal-after-dispatch') await journalMode();
  else if (mode === 'cursor-before-advance' || mode === 'cursor-resume') await cursorMode();
  else {
    say({ error: `unknown mode ${mode}` });
    process.exit(2);
  }
} catch (error) {
  say({ error: String(error?.stack ?? error) });
  process.exit(3);
}
