"""Confirm a test actually fails without its fix.

A test that passes both with and without the change it was written for is not
evidence of anything. This reverts one fix at a time, runs the suite, and puts
the file back -- with the restore in a `finally`, because a mutation left behind
is worse than the claim it was checking.
"""
import subprocess, sys

MUTATIONS = [
    (
        'packages/t3-client/src/resume.ts',
        '    if (item.sequence <= this.#applied) return;\n',
        '',
        'runs the handler for a redelivered item but does NOT walk backwards',
    ),
    (
        'packages/t3-client/src/subscription.ts',
        "const madeProgress = (synchronized || catchUp.length > 0) && handlerFailure === null;",
        "const madeProgress = synchronized || catchUp.length > 0;",
        'bounds reconnects when a handler fails deterministically',
    ),
    (
        'packages/t3-client/src/envelope.ts',
        '    assertFrameShape(candidate as Record<string, unknown>, tag, raw);',
        '',
        'rejects a Chunk with no values array',
    ),
    (
        'packages/t3-client/src/envelope.ts',
        '    assertFrameShape(candidate as Record<string, unknown>, tag, raw);',
        '',
        'rejects an Exit whose Failure cause is not an array',
    ),
    (
        'packages/t3-client/src/client.ts',
        '        this.options.onOutOfBand?.(frame);\n        this.#failAllPending(error);',
        '        this.options.onOutOfBand?.(frame);',
        'fails every in-flight request on ClientProtocolError instead of leaving them to time out',
    ),
    (
        'packages/t3-client/src/client.ts',
        '        onChunk: (values) => {\n          armIdleTimer();',
        '        onChunk: (values) => {',
        'does not abandon a stream that keeps delivering',
    ),
    (
        'packages/t3-client/src/subscription.ts',
        'return typeof name !== \'string\' || !TERMINAL_ERROR_NAMES.has(name);',
        'return true;',
        'throws SubscriptionTerminatedError rather than reconnecting on a PayloadShapeError',
    ),
    (
        # The stop-after-failure lives in `enqueue`'s chain guard, not in the
        # duplicate filter. A first attempt reverted the duplicate filter, the
        # test still passed, and that said nothing about the test -- the
        # mutation was pointed somewhere else.
        'packages/t3-client/src/subscription.ts',
        '        chain = chain.then(async () => {\n          if (handlerFailure) return;',
        '        chain = chain.then(async () => {',
        'does not apply a later event after an earlier handler failed in the same stream',
    ),
    (
        'packages/t3-client/src/subscription.ts',
        "  resetTo(sequence: number): void {\n    this.#cursor",
        "  resetTo(sequence: number): void {\n    if (sequence <= this.#cursor.applied) return;\n    this.#cursor",
        'resetTo moves the cursor down, persists it, and live events flow again',
    ),
    (
        'packages/t3-client/src/subscription.ts',
        "              enqueue(\n                () =>\n                  this.options.onResume(",
        "              void ((() =>\n                  this.options.onResume(",
        'reports only after the queued handlers have run',
    ),
    (
        'packages/t3-client/src/subscription.ts',
        "  'ProtocolError',\n  'MalformedFrameError',\n",
        '',
        'surfaces ProtocolError instead of resubscribing on it',
    ),
    (
        'packages/t3-client/src/subscription.ts',
        "  'ProtocolError',\n  'MalformedFrameError',\n",
        '',
        'surfaces MalformedFrameError instead of resubscribing on it',
    ),
    (
        'packages/t3-client/src/socket.ts',
        '    const wake = this.#wakeRetry;\n    this.#wakeRetry = null;\n    wake?.();',
        '',
        'rejects rather than leaving the caller pending forever',
    ),
    (
        'packages/t3-client/src/envelope.ts',
        "      if (frame.values.length === 0) throw new MalformedFrameError(raw, 'Chunk values array is empty');\n",
        '',
        'rejects a Chunk whose values array is empty',
    ),
    (
        'packages/t3-client/src/envelope.ts',
        '        for (const entry of exit.cause) {',
        '        for (const entry of [] as unknown[]) {',
        'rejects a cause entry that is a shapeless object',
    ),
    (
        'packages/t3-client/src/envelope.ts',
        '        for (const entry of exit.cause) {',
        '        for (const entry of [] as unknown[]) {',
        'rejects a Fail with no error and a Die with no defect',
    ),
    (
        'packages/t3-client/src/client.ts',
        '            try {\n              this.#sendRaw(interrupt(chunk.requestId));\n            } catch {\n              /* the socket is already gone; nothing to interrupt through */\n            }\n',
        '',
        'INTERRUPTS the server when a streamed chunk fails its shape check',
    ),
]

for path, fixed, unfixed, test_name in MUTATIONS:
    original = open(path).read()
    if fixed not in original:
        print(f'SKIP  {test_name}: anchor not found in {path}')
        continue
    try:
        open(path, 'w').write(original.replace(fixed, unfixed, 1))
        r = subprocess.run(
            ['npx', 'vitest', 'run',
             'packages/codev/src/__tests__/spec-146-t3-client.test.ts',
             '-t', test_name],
            capture_output=True, text=True,
        )
    finally:
        open(path, 'w').write(original)
    verdict = 'FAILS without the fix (good)' if r.returncode != 0 else 'STILL PASSES -- the test is not pointed at the defect'
    print(f'{verdict}: {test_name}')
