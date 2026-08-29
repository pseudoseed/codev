/**
 * Spec 146, Phase 4 — message delivery semantics.
 *
 * Here rather than in `packages/porch-driver/__tests__/`, which is what the plan
 * named, for the reason phases 1-3 landed in the same place: the root `test` script
 * is `pnpm --filter @cluesmith/codev test`, so a test inside `packages/porch-driver`
 * would look present and never run. The plan records the deviation.
 *
 * The spec makes the mailbox's deletion conditional on five properties, so these
 * tests are written to FAIL if a property is merely plausible rather than held:
 *
 *  - Ordering is driven with CONCURRENT sends. A sequential loop passes against a
 *    queue with no ordering guarantee at all, because nothing ever races.
 *  - The queue-while-active test asserts the messages arrive after settle AND that
 *    none reached the transport during the turn. "Ten arrived in order" is true of
 *    an implementation that interleaved all ten into the running turn.
 *  - The unreachable-server test asserts the send REJECTS and that nothing is left
 *    holding the message, because silently queueing would also produce a call that
 *    did not throw.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DispatchJournal, recoverPendingCommands } from '../../../porch-driver/src/commands.js';
import {
  MESSAGE_METHOD,
  commandIdForKey,
  sendMessage,
  type OutboundMessage,
} from '../../../porch-driver/src/deliver.js';
import { ThreadMessageQueue, type QueueTarget } from '../../../porch-driver/src/queue.js';
import {
  ScheduleCorruptError,
  ScheduleStore,
  ScheduledDelivery,
  type ScheduledMessage,
} from '../../../porch-driver/src/scheduled.js';

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `spec146-p4-${label}-`));
}

/** A dispatcher that records the order the transport actually saw. */
function recordingDispatcher(options: { readonly delayMs?: (n: number) => number } = {}) {
  const calls: Array<{ method: string; payload: any; at: number }> = [];
  let n = 0;
  return {
    calls,
    /** Texts in the order they reached the transport. */
    get texts(): string[] {
      return calls.map((c) => c.payload?.message?.text).filter((t) => typeof t === 'string');
    },
    async call(method: string, payload: any) {
      const mine = n++;
      const delay = options.delayMs?.(mine) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      calls.push({ method, payload, at: Date.now() });
      return {};
    },
  };
}

function message(text: string, key = text): OutboundMessage {
  return { threadId: 't1', text, idempotencyKey: key };
}

// ------------------------------------------------------------ idempotency keys

describe('spec 146 phase 4: idempotency keys', () => {
  it('derives the same commandId for the same key, always', () => {
    // This determinism IS the idempotency mechanism. If it were random, a retry
    // after an ambiguous failure would be a NEW command and the server would apply
    // it twice — the exact double-send the key exists to prevent.
    expect(commandIdForKey('k-1')).toBe(commandIdForKey('k-1'));
    expect(commandIdForKey('k-1')).not.toBe(commandIdForKey('k-2'));
  });

  it('derives a well-formed UUID, so it goes anywhere a generated id goes', () => {
    expect(commandIdForKey('k-1')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('a retry after an ambiguous failure delivers exactly once', async () => {
    // The ambiguous case: the dispatch threw, so the caller cannot know whether the
    // command landed. Retrying under the same key must not produce a second
    // delivery — here the transport sees the same commandId both times, which is
    // what t3code's receipt table collapses.
    const dir = tempDir('retry');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      let failNext = true;
      const seen: string[] = [];
      const dispatcher = {
        async call(_method: string, payload: any) {
          seen.push(payload.commandId);
          if (failNext) {
            failNext = false;
            throw Object.assign(new Error('socket closed'), { name: 'NotConnectedError' });
          }
          return {};
        },
      };

      await expect(sendMessage(dispatcher, journal, message('hello', 'k-1'))).rejects.toThrow('socket closed');
      const receipt = await sendMessage(dispatcher, journal, message('hello', 'k-1'));

      expect(seen).toEqual([commandIdForKey('k-1'), commandIdForKey('k-1')]);
      expect(receipt.commandId).toBe(commandIdForKey('k-1'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a retry of a SETTLED send does not touch the network at all', async () => {
    const dir = tempDir('retry-settled');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher();

      const first = await sendMessage(dispatcher, journal, message('hello', 'k-1'));
      const second = await sendMessage(dispatcher, journal, message('hello', 'k-1'));

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(dispatcher.calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the acknowledgement does not claim the agent read it', async () => {
    // The type is named for what it witnesses. This test exists so the name cannot
    // drift into `delivered` without something going red.
    const dir = tempDir('ack-shape');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const receipt = await sendMessage(recordingDispatcher(), journal, message('hi', 'k-1'));
      expect(receipt.kind).toBe('accepted-by-server');
      expect(Object.keys(receipt)).not.toContain('read');
      expect(Object.keys(receipt)).not.toContain('delivered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------- ordering

describe('spec 146 phase 4: ordering', () => {
  it('preserves send order under CONCURRENT pressure, not just sequentially', async () => {
    // The input shape is the test. Awaiting each send in turn cannot reorder
    // anything, so it would pass against a queue with no ordering guarantee. Here
    // ten sends are started without awaiting, and the transport is made SLOWEST on
    // the first message, so an implementation that dispatched them in parallel
    // would land them out of order.
    const dir = tempDir('order');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher({ delayMs: (n) => (n === 0 ? 40 : 1) });
      const queue = new ThreadMessageQueue(() => ({ threadId: 't1', isTurnActive: false }), dispatcher, journal);

      const texts = Array.from({ length: 10 }, (_, i) => `m${i}`);
      await Promise.all(texts.map((t) => queue.send(message(t))));
      await queue.flush();

      expect(dispatcher.texts).toEqual(texts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a message sent while draining does not overtake the backlog', async () => {
    // The subtle half of ordering: the queue empties, and a fresh send arrives
    // while earlier messages are still in flight. Without one FIFO for every
    // message, the newcomer takes the free transport and lands first.
    const dir = tempDir('order-late');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher({ delayMs: (n) => (n === 0 ? 30 : 0) });
      const queue = new ThreadMessageQueue(() => ({ threadId: 't1', isTurnActive: false }), dispatcher, journal);

      const first = queue.send(message('early'));
      const second = queue.send(message('late'));
      await Promise.all([first, second]);
      await queue.flush();

      expect(dispatcher.texts).toEqual(['early', 'late']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------- queue while active

describe('spec 146 phase 4: queued while a turn is active', () => {
  it('holds ten messages during a turn and delivers them in order on settle', async () => {
    const dir = tempDir('queue-active');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher();
      let turnActive = true;
      const target = (): QueueTarget => ({ threadId: 't1', isTurnActive: turnActive });
      const queue = new ThreadMessageQueue(target, dispatcher, journal);

      const texts = Array.from({ length: 10 }, (_, i) => `m${i}`);
      const receipts = await Promise.all(texts.map((t) => queue.send(message(t))));

      // NOT INTERLEAVED. Asserting only the post-settle order would pass against an
      // implementation that pushed all ten into the running turn.
      expect(dispatcher.calls).toHaveLength(0);
      expect(queue.depth).toBe(10);
      expect(receipts.every((r) => r.kind === 'queued-by-porch')).toBe(true);
      expect(receipts.map((r) => (r.kind === 'queued-by-porch' ? r.position : -1))).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);

      turnActive = false;
      await queue.flush();

      // NOT DROPPED, and in order.
      expect(dispatcher.texts).toEqual(texts);
      expect(queue.depth).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a turn starting mid-drain stops the rest of the backlog', async () => {
    const dir = tempDir('queue-restart');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      let turnActive = false;
      const dispatcher = recordingDispatcher();
      const queue = new ThreadMessageQueue(
        () => ({ threadId: 't1', isTurnActive: turnActive }),
        dispatcher,
        journal,
      );

      await queue.send(message('a'));
      turnActive = true;
      const held = queue.send(message('b'));
      await queue.flush();

      expect(dispatcher.texts).toEqual(['a']);
      expect(queue.depth).toBe(1);

      turnActive = false;
      await queue.flush();
      await held;
      expect(dispatcher.texts).toEqual(['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a queued message is journalled before the queue admits it', async () => {
    // A message that existed only in memory is a message a crash loses. The intent
    // is on disk before `send` returns, so recovery re-dispatches it.
    const dir = tempDir('queue-durable');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      const queue = new ThreadMessageQueue(
        () => ({ threadId: 't1', isTurnActive: true }),
        recordingDispatcher(),
        journal,
      );

      await queue.send(message('survive-me', 'k-1'));

      // A fresh process reads the same file and finds it pending.
      const reopened = new DispatchJournal(path);
      expect(reopened.pending().map((r) => r.commandId)).toEqual([commandIdForKey('k-1')]);

      const dispatcher = recordingDispatcher();
      await recoverPendingCommands(dispatcher, reopened);
      expect(dispatcher.calls[0].payload.message.text).toBe('survive-me');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------- unreachable server

describe('spec 146 phase 4: an unreachable server fails loudly', () => {
  it('rejects at the call site rather than silently queueing', async () => {
    const dir = tempDir('unreachable');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dead = {
        async call() {
          throw Object.assign(new Error('the t3code socket is not open'), { name: 'NotConnectedError' });
        },
      };
      const queue = new ThreadMessageQueue(() => ({ threadId: 't1', isTurnActive: false }), dead, journal);

      await expect(queue.send(message('into the void'))).rejects.toThrow(/socket is not open/);

      // And it is NOT being held for a later retry. A queue that kept it would also
      // have produced a call that did not resolve successfully, so the depth
      // assertion is what separates "failed loudly" from "queued silently".
      expect(queue.depth).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails within a bounded time rather than hanging', async () => {
    const dir = tempDir('unreachable-bounded');
    try {
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const slowDead = {
        async call() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw Object.assign(new Error('request timed out'), { name: 'RequestTimeoutError' });
        },
      };
      const queue = new ThreadMessageQueue(() => ({ threadId: 't1', isTurnActive: false }), slowDead, journal);

      const started = Date.now();
      await expect(queue.send(message('x'))).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unanswered send stays pending, so recovery re-dispatches it', async () => {
    // Failing loudly is not the same as forgetting. The caller learns immediately;
    // the intent is still on disk, because "I could not tell whether it landed" is
    // not "it did not land".
    const dir = tempDir('unreachable-pending');
    try {
      const path = join(dir, 'commands.jsonl');
      const journal = new DispatchJournal(path);
      const dead = {
        async call() {
          throw Object.assign(new Error('socket closed'), { name: 'NotConnectedError' });
        },
      };

      await expect(sendMessage(dead, journal, message('x', 'k-1'))).rejects.toThrow();
      expect(new DispatchJournal(path).pending().map((r) => r.commandId)).toEqual([commandIdForKey('k-1')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -------------------------------------------------------- scheduled delivery

describe('spec 146 phase 4: durable scheduled delivery', () => {
  function scheduled(key: string, dueAt: number, text = key): ScheduledMessage {
    return { idempotencyKey: key, threadId: 't1', text, dueAt, scheduledAt: new Date().toISOString() };
  }

  it('a pre-due message survives a restart and fires once, at its due time', async () => {
    // The property `afx send --delay` and cron both need. The "restart" is a second
    // ScheduledDelivery over the same file with no shared memory — which is what a
    // restart actually is.
    const dir = tempDir('sched-restart');
    try {
      const storePath = join(dir, 'scheduled.jsonl');
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));

      let now = 1_000;
      const before = new ScheduledDelivery(
        new ScheduleStore(storePath),
        recordingDispatcher(),
        journal,
        () => now,
      );
      before.start();
      before.schedule(scheduled('k-1', 5_000));
      before.stop();

      // Nothing fired: it was not due.
      expect(new ScheduleStore(storePath).pending().map((m) => m.idempotencyKey)).toEqual(['k-1']);

      now = 6_000;
      const dispatcher = recordingDispatcher();
      const after = new ScheduledDelivery(new ScheduleStore(storePath), dispatcher, journal, () => now);
      after.start();
      const receipts = await after.fireDue();
      after.stop();

      expect(receipts).toHaveLength(1);
      expect(dispatcher.texts).toEqual(['k-1']);
      expect(new ScheduleStore(storePath).pending()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a duplicate schedule under the same key does not double-fire', async () => {
    const dir = tempDir('sched-dup');
    try {
      const store = new ScheduleStore(join(dir, 'scheduled.jsonl'));
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher();
      let now = 1_000;
      const delivery = new ScheduledDelivery(store, dispatcher, journal, () => now);
      delivery.start();

      delivery.schedule(scheduled('k-1', 5_000));
      delivery.schedule(scheduled('k-1', 5_000));
      delivery.schedule(scheduled('k-1', 9_000)); // a retry, not a reschedule

      expect(store.pending()).toHaveLength(1);
      // The first due time wins.
      expect(store.pending()[0].dueAt).toBe(5_000);

      now = 6_000;
      await delivery.fireDue();
      await delivery.fireDue();
      delivery.stop();

      expect(dispatcher.calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a message due while the process was down fires immediately, not never', async () => {
    const dir = tempDir('sched-late');
    try {
      const storePath = join(dir, 'scheduled.jsonl');
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      new ScheduleStore(storePath).schedule(scheduled('k-late', 2_000));

      const dispatcher = recordingDispatcher();
      // Restarting well after the due time. Late is not cancelled.
      const delivery = new ScheduledDelivery(new ScheduleStore(storePath), dispatcher, journal, () => 90_000);
      delivery.start();
      await delivery.fireDue();
      delivery.stop();

      expect(dispatcher.texts).toEqual(['k-late']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks fired AFTER the dispatch, so a crash in the window re-fires', async () => {
    // The same ordering rule the cursor has. Marking it fired first would lose the
    // message at exactly the crash this store exists to survive; re-firing is safe
    // because the derived commandId makes it the same command.
    const dir = tempDir('sched-order');
    try {
      const storePath = join(dir, 'scheduled.jsonl');
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const store = new ScheduleStore(storePath);
      store.schedule(scheduled('k-1', 1_000));

      let pendingAtDispatch: number | null = null;
      const dispatcher = {
        async call() {
          pendingAtDispatch = new ScheduleStore(storePath).pending().length;
          throw Object.assign(new Error('socket closed'), { name: 'NotConnectedError' });
        },
      };

      const delivery = new ScheduledDelivery(store, dispatcher, journal, () => 2_000);
      await expect(delivery.fireDue()).rejects.toThrow('socket closed');

      // Still pending during the dispatch, and still pending after it failed.
      expect(pendingAtDispatch).toBe(1);
      expect(new ScheduleStore(storePath).pending()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cancelled message does not fire, now or after a restart', async () => {
    const dir = tempDir('sched-cancel');
    try {
      const storePath = join(dir, 'scheduled.jsonl');
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const delivery = new ScheduledDelivery(new ScheduleStore(storePath), recordingDispatcher(), journal, () => 1_000);
      delivery.start();
      delivery.schedule(scheduled('k-1', 5_000));
      delivery.cancel('k-1');
      delivery.stop();

      const dispatcher = recordingDispatcher();
      const after = new ScheduledDelivery(new ScheduleStore(storePath), dispatcher, journal, () => 9_000);
      after.start();
      await after.fireDue();
      after.stop();

      expect(dispatcher.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a torn last line is recovered; a damaged middle line is reported', () => {
    // Same rule as the dispatch journal: a crash mid-append is ordinary and a
    // damaged file is not, and answering both with "nothing is scheduled" would
    // drop every pending message while looking correct.
    const dir = tempDir('sched-torn');
    try {
      const path = join(dir, 'scheduled.jsonl');
      const store = new ScheduleStore(path);
      store.schedule(scheduled('k-1', 5_000));

      // A crash mid-append.
      writeFileSync(path, readFileSync(path, 'utf-8') + '{"kind":"sched');
      expect(store.pending().map((m) => m.idempotencyKey)).toEqual(['k-1']);

      // And an append after the torn tail leaves a readable file.
      store.schedule(scheduled('k-2', 6_000));
      expect(store.pending().map((m) => m.idempotencyKey)).toEqual(['k-1', 'k-2']);

      // Damage in the MIDDLE is a different fact.
      const lines = readFileSync(path, 'utf-8').split('\n');
      lines[0] = '{not json';
      writeFileSync(path, lines.join('\n'));
      expect(() => new ScheduleStore(path).pending()).toThrow(ScheduleCorruptError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a scheduled fire uses the same commandId a direct send would', async () => {
    // Scheduled and direct paths share the idempotency mechanism, so a message that
    // was both scheduled and sent by hand collapses to one delivery rather than two.
    const dir = tempDir('sched-key');
    try {
      const storePath = join(dir, 'scheduled.jsonl');
      const journal = new DispatchJournal(join(dir, 'commands.jsonl'));
      const dispatcher = recordingDispatcher();
      const delivery = new ScheduledDelivery(new ScheduleStore(storePath), dispatcher, journal, () => 9_000);
      delivery.schedule(scheduled('k-shared', 1_000));
      await delivery.fireDue();

      expect(dispatcher.calls[0].payload.commandId).toBe(commandIdForKey('k-shared'));
      expect(dispatcher.calls[0].method).toBe('orchestration.dispatchCommand');
      expect(dispatcher.calls[0].payload.type).toBe(MESSAGE_METHOD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
