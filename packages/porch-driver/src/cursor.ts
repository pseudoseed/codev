/**
 * Spec 146, Phase 3 — the sequence cursor, on disk.
 *
 * `@cluesmith/t3-client`'s `SequenceCursor` holds the ordering rule in memory and
 * calls a `persist` hook. This is that hook, made durable, plus the one thing a
 * durable cursor has to get right:
 *
 * **The cursor advances AFTER the handler completes, never before.**
 *
 * The spec corrected itself on this. Persisting first and acting second loses the
 * event permanently on a crash in between, because replay resumes past it. Acting
 * first and persisting second re-delivers it, which is why every handler must be
 * idempotent. At-least-once is a choice made here, once, and everything
 * downstream depends on it holding.
 *
 * A CORRUPT CURSOR IS NOT SEQUENCE ZERO
 *
 * Reading a damaged cursor file as 0 would resubscribe from the beginning and
 * look like a cold start. That is "I could not tell" spelled as a fact, so it
 * throws instead. An ABSENT file really is a cold start and returns 0.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export class CursorUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly contents: string,
  ) {
    super(
      `Cursor file ${path} does not hold a sequence: ${JSON.stringify(contents.slice(0, 120))}\n` +
        `  Reading this as 0 would resubscribe from the beginning and present a ` +
        `damaged file as a cold start. An absent file is a cold start; an ` +
        `unreadable one is not.`,
    );
    this.name = 'CursorUnreadableError';
  }
}

/** Write `contents` to `path` so a crash leaves either the old file or the new one. */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // fsync the directory so the rename itself survives, not just the bytes.
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } catch {
    // Not every platform permits fsync on a directory descriptor. The rename is
    // still atomic; only its durability against a power loss is weaker, and
    // failing the write over that would be worse than proceeding.
  } finally {
    closeSync(dirFd);
  }
  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the rename already consumed it on every normal path */
    }
  }
}

export interface CursorApplyOptions {
  /**
   * Run after the handler completes and BEFORE the cursor is written.
   *
   * That window is where the spec says a test must kill porch. Without a hook
   * standing in it, a test can only assert the code reads as if it were ordered
   * correctly. Production passes nothing.
   */
  readonly beforeAdvance?: (sequence: number) => void | Promise<void>;
}

/**
 * A last-applied sequence that survives the process.
 *
 * `applied` is the highest sequence whose handler RAN TO COMPLETION. Resuming
 * from it re-delivers anything in flight when the process died.
 */
export class PersistentCursor {
  #applied: number;

  private constructor(
    readonly path: string,
    initial: number,
  ) {
    this.#applied = initial;
  }

  /** Load the cursor at `path`. An absent file is 0; an unreadable one throws. */
  static load(path: string): PersistentCursor {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return new PersistentCursor(path, 0);
    const raw = readFileSync(path, 'utf-8').trim();
    if (raw.length === 0) return new PersistentCursor(path, 0);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new CursorUnreadableError(path, raw);
    return new PersistentCursor(path, value);
  }

  get applied(): number {
    return this.#applied;
  }

  /**
   * Run `handler` for `sequence`, then advance.
   *
   * A sequence at or below `applied` is a redelivery and is skipped: the handler
   * already completed for it. A handler that throws leaves the cursor where it
   * was, so the event comes back.
   */
  async apply(
    sequence: number,
    handler: () => void | Promise<void>,
    options: CursorApplyOptions = {},
  ): Promise<'applied' | 'duplicate'> {
    if (sequence <= this.#applied) return 'duplicate';
    await handler();
    await options.beforeAdvance?.(sequence);
    this.#persist(sequence);
    return 'applied';
  }

  /**
   * Move the cursor to a reconciled position, in either direction.
   *
   * The backwards direction is the one that matters: a cursor ahead of the
   * server's head — a restored or rolled-back database — is recovered only by
   * moving down, and a forward-only guard makes that call a silent no-op. Named
   * `reset` rather than folded into `apply` because moving backwards must be
   * something a caller chooses.
   */
  reset(sequence: number): void {
    this.#persist(sequence);
  }

  #persist(sequence: number): void {
    writeAtomic(this.path, `${sequence}\n`);
    this.#applied = sequence;
  }
}
