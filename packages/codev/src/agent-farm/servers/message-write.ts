/**
 * Paced message writing for PTY sessions (Bugfix #584).
 *
 * Extracted to a shared module to avoid circular imports between
 * tower-routes.ts and tower-cron.ts.
 */

/** Minimal writable session interface — avoids coupling to PtySession. */
export interface WritableSession {
  /**
   * Write input to the underlying PTY. Returns `false` when the write was dropped
   * (#1198: a shellper-backed session whose socket has died still reports status
   * 'running', yet its writes silently no-op). {@link writeMessagePaced} threads this
   * boolean so a mailbox delivery whose bytes never reached the terminal is held, not
   * marked delivered (Spec 1313 integration review — the silent-loss finding).
   */
  write(data: string): boolean;
}

// Messages longer than this threshold are written line-by-line with delays
// to prevent the receiving terminal from classifying the input as a paste
// and swallowing the final Enter.
const PACED_WRITE_LINE_THRESHOLD = 4;
const INTER_LINE_DELAY_MS = 10;

/**
 * Hard ceiling on the bytes handed to a single `session.write` (Bugfix #273).
 *
 * A tty's input queue is finite — on macOS it is 1024 bytes — and a write larger
 * than what the queue can hold is truncated **silently**: `pty.write()` returns
 * without error, so {@link writeMessagePaced} resolves `true` and the mailbox row is
 * marked `delivered` for bytes that never reached the agent. Issue #273 lost the first
 * 1021 characters of a 1274-character message that way, and the loss was spelled
 * `delivered`.
 *
 * Line count is not a proxy for byte count. The message that broke was **three lines**
 * — header, a 1173-character body on one line, footer — so it took the short path below
 * and went out as one 1274-byte write; the paced path would have been no better, since
 * it writes one line at a time and that body *is* one line. The bound has to be on
 * bytes, at the write itself.
 *
 * **The cap counts UTF-16 units; the hazard is UTF-8 bytes.** The conversion is not 1:1,
 * and the bound only holds because of the ratio: the worst case is 3 bytes per unit (a
 * 3-byte BMP character such as 日 is one unit; a 4-byte character is a surrogate PAIR, so
 * it costs two units for four bytes, which is cheaper per unit). So 256 units emit **at
 * most 768 bytes** — still inside the 1024-byte queue, with room for several chunks to
 * sit there while the reader drains between them.
 *
 * That is the constraint to preserve if this number is ever changed: `3 × cap < 1024`,
 * so **the cap must stay at or below 341**. Raising it to 512 on the reasoning that it
 * is "still half the queue" would emit 1536-byte writes and reopen this bug.
 */
export const MAX_WRITE_CHUNK_CHARS = 256;
const PACED_ENTER_DELAY_MS = 80;
const SIMPLE_ENTER_DELAY_MS = 50;

/** ESC keystroke — ends the agent's current turn (Spec 1273). */
export const ESC = '\x1b';

/**
 * Delay between the ESC and the Enter that follows it. Matches the short-message
 * Enter delay: ESC has to be processed by the TUI before Enter is meaningful.
 */
export const ESCAPE_ENTER_DELAY_MS = SIMPLE_ENTER_DELAY_MS;

/**
 * Write a sequence of control bytes to a PTY, SETTLING between them (Issue #196).
 *
 * The settle is not politeness, it is correctness. **ESC immediately followed by a
 * character is the standard terminal encoding for Alt+character** (`ESC` + `u` is how a
 * TUI receives Alt+u), so writing `\x1b\x15` back-to-back can legitimately be parsed as
 * ONE alt-modified keypress rather than two keystrokes — in which case an `--interrupt`
 * on opencode would neither end the turn nor clear the composer, and would report success.
 * That is the same class of defect this issue exists to fix, one layer down.
 *
 * Reuses {@link ESCAPE_ENTER_DELAY_MS} rather than inventing a number: it exists for
 * exactly this reason ("ESC has to be processed by the TUI before Enter is meaningful"),
 * and a second constant would be a second thing to keep in sync.
 *
 * A single byte writes immediately and returns 0, so claude and codex — where
 * `promptReadySequence` dedups to one `\x03` — are byte-for-byte and timing-for-timing
 * unchanged.
 *
 * @returns ms offset (from call time) when the last byte is written
 */
export function writeControlSequence(session: WritableSession, bytes: readonly string[]): number {
  if (bytes.length === 0) return 0;
  session.write(bytes[0]);
  let offset = 0;
  for (let i = 1; i < bytes.length; i++) {
    offset += ESCAPE_ENTER_DELAY_MS;
    const byte = bytes[i];
    setTimeout(() => session.write(byte), offset);
  }
  return offset;
}

/**
 * Write a bare ESC keystroke to a PTY session (Spec 1273).
 *
 * This is the verified mid-turn recovery for a wedged agent: ESC interrupts the
 * running tool and ends the turn, after which queued messages process. It is the
 * command form of `afx send <builder> --raw "$(printf '\x1b')"`.
 *
 * A caller can explicitly request a trailing Enter because it is what lets
 * already-queued input through once ESC has ended the turn. That opt-in must be
 * deliberate: Enter can activate a highlighted action on an unknown dialog.
 *
 * Deliberately not routed through `writeMessageToSession`: ESC is a control byte,
 * not text, so line-pacing and paste-detection logic do not apply to it.
 *
 * @returns ms timestamp (from call time) when all writes complete
 */
export function writeEscapeToSession(session: WritableSession, noEnter: boolean): number {
  session.write(ESC);
  if (noEnter) return 0;
  setTimeout(() => session.write('\r'), ESCAPE_ENTER_DELAY_MS);
  return ESCAPE_ENTER_DELAY_MS;
}

/**
 * Split a message into the exact chunks that will be handed to `session.write`
 * (Bugfix #273): one per line, and any line longer than {@link MAX_WRITE_CHUNK_CHARS}
 * further split so no single write can overflow the receiving tty's input queue.
 *
 * The `\n` stays attached to the tail chunk of its line, so concatenating the result
 * reproduces the message byte for byte — the split is invisible to the receiver.
 *
 * A chunk boundary never lands between the two halves of a surrogate pair: slicing
 * UTF-16 at a fixed index can cut an emoji in two, and each half would then be written
 * as a lone surrogate and encoded as U+FFFD, silently corrupting the character. When
 * the boundary falls on a high surrogate the chunk gives that unit up to the next one.
 *
 * That guard is also what keeps a multi-byte UTF-8 sequence whole. `session.write`
 * takes a JS string, not a Buffer, so the UTF-8 encoding happens per chunk at the write
 * — and a chunk that is well-formed UTF-16 always encodes to complete UTF-8 sequences.
 * A 2- or 3-byte character (é, 日) is a single UTF-16 unit and cannot be split at all;
 * only the 4-byte characters, which are surrogate pairs, could be, and this is where
 * they are protected. Split on a Buffer instead and the guard would have to count
 * continuation bytes.
 */
export function segmentMessageForWrite(message: string): string[] {
  const lines = message.split('\n');
  const segments: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = i < lines.length - 1 ? lines[i] + '\n' : lines[i];
    if (text.length <= MAX_WRITE_CHUNK_CHARS) {
      segments.push(text);
      continue;
    }
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + MAX_WRITE_CHUNK_CHARS, text.length);
      // Don't cut a surrogate pair in half. `Math.max` keeps the loop finite: giving a
      // unit back can only ever move `end` to `offset`, and a chunk of zero length would
      // never advance.
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end = Math.max(offset + 1, end - 1);
      segments.push(text.slice(offset, end));
      offset = end;
    }
  }

  return segments;
}

/**
 * Write a message to a PTY session, pacing output so the terminal neither treats it
 * as a paste (Bugfix #584) nor silently drops the part of it that did not fit in the
 * tty's input queue (Bugfix #273).
 *
 * Short messages (<4 lines AND <= MAX_WRITE_CHUNK_CHARS): single write + delayed
 * Enter. Everything else: {@link segmentMessageForWrite} chunks with 10ms gaps, then
 * Enter once every chunk is out.
 *
 * The second condition is the #273 fix. A three-line message can still be 1274 bytes
 * long, and one write that big is truncated by the receiving tty without any layer
 * reporting a failure - so the fast path is only for messages that genuinely are small.
 *
 * @param delayOffset  ms offset for all scheduled writes (used to serialize
 *                     multiple messages to the same session without interleaving)
 * @returns            ms timestamp (from call time) when all writes complete
 */
export function writeMessageToSession(
  session: WritableSession, message: string, noEnter: boolean, delayOffset = 0,
): number {
  const lines = message.split('\n');

  if (lines.length < PACED_WRITE_LINE_THRESHOLD && message.length <= MAX_WRITE_CHUNK_CHARS) {
    // Short messages: single write (existing behavior, works fine)
    if (delayOffset === 0) {
      session.write(message);
    } else {
      setTimeout(() => session.write(message), delayOffset);
    }
    const enterTime = delayOffset + SIMPLE_ENTER_DELAY_MS;
    if (!noEnter) {
      setTimeout(() => session.write('\r'), enterTime);
    }
    return enterTime;
  }

  // Pace output chunk-by-chunk: one write per line, and a long line split further so
  // no single write exceeds MAX_WRITE_CHUNK_CHARS. Writing all lines in a single
  // write() causes the terminal to treat it as a paste and swallow the final Enter
  // (#584); writing more than the input queue holds loses the excess in silence (#273).
  const segments = segmentMessageForWrite(message);
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i];
    const lineDelay = delayOffset + i * INTER_LINE_DELAY_MS;
    if (lineDelay === 0) {
      session.write(text);
    } else {
      setTimeout(() => session.write(text), lineDelay);
    }
  }

  const lastLineTime = delayOffset + (segments.length - 1) * INTER_LINE_DELAY_MS;
  if (!noEnter) {
    const enterTime = lastLineTime + PACED_ENTER_DELAY_MS;
    setTimeout(() => session.write('\r'), enterTime);
    return enterTime;
  }
  return lastLineTime;
}

/**
 * Paced write of a message (text + trailing Enter unless `noEnter`) that reports
 * whether every byte reached the PTY. Resolves `true` when the whole submit landed,
 * `false` when ANY scheduled write was dropped (#1198: a shellper socket that died
 * mid-pace). This is the delivery layer's authoritative success signal — a mailbox
 * delivery holds a row whose bytes never made it instead of marking it delivered
 * (Spec 1313 integration review — the silent-loss finding).
 *
 * `writeMessageToSession` fires the text, any subsequent lines, and the trailing
 * Enter across `setTimeout` gaps (10–130ms+), and a t=0 `writable` precheck cannot
 * see a socket that dies *during* that sequence. So wrap the session and record
 * whether any of those writes returned false. The returned promise resolves at the
 * final scheduled offset (`doneMs`); `writeMessageToSession` registers the Enter's
 * `setTimeout` at that same offset *before* this resolve is scheduled, so the Enter
 * executes first and its result is observed by resolution time.
 *
 * Awaiting the promise is also what makes the per-agent write serializer's
 * completion-chaining real — the next delivery cannot begin until this submit
 * (Enter included) is entirely on the wire.
 */
export function writeMessagePaced(
  session: WritableSession, message: string, noEnter: boolean,
): Promise<boolean> {
  let delivered = true;
  const tracked: WritableSession = {
    write: (data: string): boolean => {
      const ok = session.write(data);
      if (!ok) delivered = false;
      return ok;
    },
  };
  const doneMs = writeMessageToSession(tracked, message, noEnter);
  return new Promise((resolve) => setTimeout(() => resolve(delivered), doneMs));
}
