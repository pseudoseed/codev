# bugfix-273 — afx send delivers a truncated message

## Investigate (2026-08-31)

### What the mailbox row actually held

`cbbd1136-dfb3-4911-ac09-d4f1ffd982c8`, `builder-air-271` → `main`, `delivered`.

- `body` 1173 chars, `formatted_message` 1274 chars, `no_enter = 0`.
- The formatted message is **3 lines**: a 68-char `### [BUILDER …] ###` header, a
  **1175-char single-line body**, and a 31-char `###…###` footer.

### Root cause

`writeMessageToSession` (`packages/codev/src/agent-farm/servers/message-write.ts`)
bounds PTY writes by **line count only**:

```ts
const PACED_WRITE_LINE_THRESHOLD = 4;
if (lines.length < PACED_WRITE_LINE_THRESHOLD) { session.write(message); ... }
```

3 < 4, so the whole 1274-byte message went out in **one `session.write`**. Nothing at
any layer bounds the byte size of a single write.

A single PTY write larger than the receiving tty's ~1024-byte input queue is silently
truncated by the kernel. `pty.write()` returns without error, `writeMessagePaced`
therefore resolves `true`, and `deliverAgentMail` marks the row `delivered`.

Measured on this machine (node-pty 1.1.0, macOS 25.6.0, `.builders/bugfix-273` scratchpad
repro): with the receiving process not yet draining stdin in raw mode,

| write shape | sent | received by child |
|---|---|---|
| single 1274-byte write | 1274 | **1024** |
| same bytes, 200-byte chunks @10ms | 1274 | 1274 |
| single 1024-byte write | 1024 | 1024 |

The observed cut in the real message was at offset **1021 of 1274** — the same ~1024
boundary.

The **paced** path has the identical defect one level down: it writes one `session.write`
per *line*, so this message's 1175-char line 2 would be a single oversized write even if
the message had had 10 lines. The line-count threshold is not the bug; the absence of any
byte bound is.

### Not reproduced

The issue reports the *head* was lost and the *tail* survived; the scratchpad repro loses
the tail. The ordering depends on the receiving TUI's line discipline state at the instant
of the write and was not pinned down. The magnitude (~1024 bytes), the silence, and the
`delivered` verdict all reproduce. The `#` run the architect saw is line 3 of our own
formatted message, not a delimiter artifact.

### Fix direction

Bound every `session.write` by bytes, not just by lines: split each line into chunks of at
most a safe fraction of the tty input queue and pace them with the existing
`INTER_LINE_DELAY_MS`. Regression test asserts at the write call site — no single write
handed to `session.write` exceeds the cap for a 3-line, 1274-char message.

## Fix (2026-08-31)

`packages/codev/src/agent-farm/servers/message-write.ts`:

- New `MAX_WRITE_CHUNK_CHARS = 256` and exported `segmentMessageForWrite()`, which splits
  a message into one chunk per line and further splits any line over the cap.
- The single-write fast path now requires `message.length <= MAX_WRITE_CHUNK_CHARS` as
  well as `< 4` lines.
- The paced path writes `segmentMessageForWrite(message)` instead of raw lines, so a
  1173-char single line is 5 writes rather than 1.

Both the mailbox delivery path (`mailbox-wiring.ts` → `writeMessagePaced`) and the
`--interrupt` bypass (`tower-routes.ts:2200`) go through this function, so both are fixed.

`writeMessagePaced` already threads each `session.write` boolean, so a chunk the PTY
rejects still resolves `false` and holds the row.

### Architect corroboration

1274 sent − 1024 accepted = 250; the architect saw the last 230 characters starting mid-sentence
at "and a thread-backed architect has none". The arithmetic matches the measurement.

### UTF-8 boundaries

Raised by the architect: chunk boundaries must not split a multi-byte UTF-8 sequence.
`session.write` takes a JS string, so UTF-8 encoding happens per chunk at the write. A
chunk that is well-formed UTF-16 always encodes to complete UTF-8 sequences: 2- and
3-byte characters are single UTF-16 units and cannot be split at all, and 4-byte
characters are surrogate pairs, which the existing guard protects. Two tests assert this
at the byte level (concatenated per-chunk UTF-8 equals the message's UTF-8), including
sliding a 4-byte character across every boundary offset the cap can land on.

### Regression test

`packages/codev/src/agent-farm/__tests__/bugfix-273-oversized-pty-write.test.ts` asserts
on the strings handed to `session.write`. Reverting the fix (line-count threshold only,
one write per line) fails 2 of them: a 1274-char write and a 1174-char write. Verified.

### Residual, stated plainly

Chunking removes the oversized single write. It does not make delivery acknowledged:
there is no ack channel from a tty, so a reader that never drains at all can still lose
bytes across chunks. The gate's precondition (a clean, idle prompt) is what makes that
unlikely, not this fix.
