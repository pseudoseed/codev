/**
 * Spec 146, Phase 4 — sending a message to a builder, and what the answer means.
 *
 * THE ACKNOWLEDGEMENT IS THE SUBJECT OF THIS FILE
 *
 * The spec makes the mailbox's deletion conditional on five properties, and one of
 * them is that "every send returns an acknowledgement that means the server
 * accepted it durably, not that the agent read it". So the receipt types here are
 * named for what they actually witness, and there is deliberately no type in this
 * module called `Delivered`:
 *
 *  - {@link AcceptedByServer} — porch dispatched it and the server answered. The
 *    message is durable on the server. **Nothing in this receipt observes the agent
 *    reading it**, and the name is the whole reason it is not called `Delivered`.
 *  - {@link QueuedByPorch} — a turn was active, so the message is fsynced to
 *    porch's journal and will be dispatched when the turn settles. Durable, but
 *    durable HERE, not there.
 *
 * Those two must not be spelled the same way. A caller that cannot tell "the server
 * has it" from "porch has it and the network has not been touched" will treat a
 * local write as a remote one, which is the exact class of error the rest of this
 * package is built to avoid. `SendReceipt` is a union so the distinction survives
 * into the caller's type checker rather than living in a comment.
 *
 * IDEMPOTENCY WITHOUT A SECOND SOURCE OF TRUTH
 *
 * A caller-generated idempotency key must make a retry after an ambiguous failure
 * deliver exactly once. The obvious implementation is a durable key→commandId map,
 * and it is the wrong one: it is a second persistent store that has to be kept in
 * step with the dispatch journal, and this repository's own lesson is that a single
 * source of truth beats distributed state.
 *
 * So the `commandId` is DERIVED from the idempotency key — a UUIDv5-shaped digest
 * over a fixed namespace. The same key always produces the same `commandId`, which
 * means a retry is automatically the same command, which means t3code's receipt
 * table collapses it (`OrchestrationEngine.ts:142-169` at the pinned commit,
 * demonstrated live in Phase 3's scenario E). No extra file, nothing to reconcile,
 * and it survives a restart because it holds no state at all.
 *
 * The journal is still consulted first, so a retry that porch can settle locally
 * never touches the network. That is an optimisation; the server's dedup is the
 * guarantee.
 */

import { createHash } from 'node:crypto';

import {
  DispatchJournal,
  dispatchCommand,
  type CommandDispatcher,
  type DispatchOptions,
} from './commands.js';

/**
 * Namespace for deriving a `commandId` from an idempotency key.
 *
 * Fixed, and must never change: it is what makes a retry after a restart — or from
 * a different process — resolve to the same command the first attempt used.
 */
const COMMAND_ID_NAMESPACE = 'codev.spec146.porch-driver.deliver.v1';

/**
 * The `commandId` for an idempotency key.
 *
 * UUIDv5-shaped: a SHA-1 over namespace and key, with the version and variant bits
 * set so the result is a well-formed UUID the server will accept anywhere a
 * generated one goes. Deterministic by design — that determinism IS the idempotency
 * mechanism, not an implementation detail of one.
 */
export function commandIdForKey(idempotencyKey: string): string {
  const digest = createHash('sha1').update(`${COMMAND_ID_NAMESPACE}:${idempotencyKey}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The server accepted the message durably.
 *
 * **This is not a read receipt and must never be presented as one.** It witnesses
 * exactly one thing: porch dispatched the command and the server answered without
 * refusing. Whether the agent has seen the text, will see it, or is even running is
 * outside what this type can say.
 */
export interface AcceptedByServer {
  readonly kind: 'accepted-by-server';
  readonly idempotencyKey: string;
  readonly commandId: string;
  readonly threadId: string;
  /** ISO 8601, taken when the server's answer arrived. */
  readonly acceptedAt: string;
  /** True when porch resolved this from its journal without touching the network. */
  readonly deduplicated: boolean;
}

/**
 * Porch accepted the message durably; the server has not seen it yet.
 *
 * A turn was active, so dispatching now would interleave the message into a running
 * turn. The intent is fsynced to the dispatch journal and the queue will dispatch it
 * when the turn settles.
 *
 * Distinct from {@link AcceptedByServer} on purpose. Both are honest durability
 * claims about different machines, and collapsing them into one "ok" would tell a
 * caller the network succeeded when it was never used.
 */
export interface QueuedByPorch {
  readonly kind: 'queued-by-porch';
  readonly idempotencyKey: string;
  readonly commandId: string;
  readonly threadId: string;
  /** ISO 8601, taken when the intent reached the disk. */
  readonly queuedAt: string;
  /** Position in the thread's queue, from 1. Ordering is asserted on this. */
  readonly position: number;
}

/** What a send can answer. Two different facts, kept apart in the type system. */
export type SendReceipt = AcceptedByServer | QueuedByPorch;

/** The message text plus the key that makes a retry safe. */
export interface OutboundMessage {
  readonly threadId: string;
  readonly text: string;
  /**
   * Caller-generated. Two sends of the same logical message must use the same key;
   * two different messages must not.
   */
  readonly idempotencyKey: string;
}

/**
 * The command a message to a builder actually is.
 *
 * **Not `thread.message.send`.** An earlier draft of this file used that name and
 * every unit test passed, because the tests inject a fake dispatcher that accepts
 * any payload. The live server refused it on sight: there is no such member of
 * t3code's command union, and the generated contract lists no `thread.message.*`
 * command at all. Sending user text to a thread IS starting a turn with it.
 *
 * The lesson is Phase 3's, unlearned and relearned one phase later: a fake
 * dispatcher validates nothing about the contract, so a payload check against the
 * vendored schema is what has to carry it. The test for this asserts
 * `checkPayload(method, 'input', payload)` returns `ok`, which is the only thing in
 * the suite that could have caught an invented method name.
 */
export const MESSAGE_METHOD = 'thread.turn.start';

/**
 * The `messageId` for an idempotency key.
 *
 * Derived, like the `commandId`, so a retry rebuilds a byte-identical payload
 * rather than a new message inside a deduplicated command. A different namespace,
 * so the two ids never collide.
 */
export function messageIdForKey(idempotencyKey: string): string {
  return commandIdForKey(`message:${idempotencyKey}`);
}

/**
 * The command payload for a message. **The only place its shape is written.**
 *
 * It exists because the shape was written in two places and only one of them was
 * corrected. `sendMessage` dispatched the fixed `thread.turn.start`; the queue
 * journalled its recovery intent as the old `thread.message.send` with the old
 * body. Nothing failed at the time — the journal is porch's own file and accepts
 * any object — so the defect sat one crash away: recovery would replay a command
 * the server has no branch for, and the queued messages recovery exists to save
 * would be exactly the ones lost.
 *
 * Both review lanes found it independently, which is the useful signal about
 * duplicated shape: it is not that the second copy was wrong, it is that a second
 * copy existed at all.
 */
export function buildMessageCommand(
  message: OutboundMessage,
  createdAt: string = new Date().toISOString(),
): Record<string, unknown> & { type: string } {
  return {
    type: MESSAGE_METHOD,
    commandId: commandIdForKey(message.idempotencyKey),
    threadId: message.threadId,
    message: {
      messageId: messageIdForKey(message.idempotencyKey),
      role: 'user',
      text: message.text,
      attachments: [],
    },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    createdAt,
  };
}

/**
 * Send one message now, without consulting turn state.
 *
 * Callers that must not interleave into a running turn use {@link ThreadMessageQueue}
 * instead — this function is the transport step underneath it, and it dispatches
 * whenever it is called.
 *
 * **Throws when the server is unreachable.** That is a requirement, not an
 * oversight: the mailbox's hold-and-retry behaviour is deliberately not reproduced
 * here, so a caller learns at the call site rather than believing a message is on
 * its way. See {@link ThreadMessageQueue} for the one case where a send is held,
 * which is a live turn and never an unreachable server.
 */
export async function sendMessage(
  dispatcher: CommandDispatcher,
  journal: DispatchJournal,
  message: OutboundMessage,
  options: DispatchOptions = {},
): Promise<AcceptedByServer> {
  const commandId = commandIdForKey(message.idempotencyKey);

  // Already settled by an earlier attempt: answer from the journal rather than
  // sending it again. The server would collapse the duplicate anyway — this just
  // means an ambiguous retry does not need the network to be up to be correct.
  if (journalHasDispatched(journal, commandId)) {
    return {
      kind: 'accepted-by-server',
      idempotencyKey: message.idempotencyKey,
      commandId,
      threadId: message.threadId,
      acceptedAt: new Date().toISOString(),
      deduplicated: true,
    };
  }

  await dispatchCommand(
    dispatcher,
    journal,
    buildMessageCommand(message),
    options,
  );

  return {
    kind: 'accepted-by-server',
    idempotencyKey: message.idempotencyKey,
    commandId,
    threadId: message.threadId,
    acceptedAt: new Date().toISOString(),
    deduplicated: false,
  };
}

/** True when the journal records this command as dispatched. */
export function journalHasDispatched(journal: DispatchJournal, commandId: string): boolean {
  for (const record of journal.read().records) {
    if (record.kind === 'outcome' && record.commandId === commandId && record.status === 'dispatched') {
      return true;
    }
  }
  return false;
}
